#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

fail() {
  printf 'Deployment refused: %s\n' "$1" >&2
  exit 1
}

is_full_sha() {
  [[ "$1" =~ ^[a-f0-9]{40}$ ]]
}

env_value_matches() {
  local key="$1" expected="$2"
  awk -F= -v key="$key" -v expected="$expected" '
    /^[[:space:]]*#/ { next }
    {
      name = $1
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", name)
      if (name == key) {
        count++
        value = substr($0, index($0, "=") + 1)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      }
    }
    END { exit !(count == 1 && value == expected) }
  ' "$ENV_FILE"
}

env_value_is_nonempty() {
  local key="$1"
  awk -F= -v key="$key" '
    /^[[:space:]]*#/ { next }
    {
      name = $1
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", name)
      if (name == key) {
        count++
        value = substr($0, index($0, "=") + 1)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      }
    }
    END { exit !(count == 1 && length(value) > 0) }
  ' "$ENV_FILE"
}

ENVIRONMENT_KEYS=(
  BOTMERZZ_IMAGE_TAG BOTMERZZ_BUILD_CONTEXT
  NODE_ENV PORT HOST_IP HOST_PORT BASE_URL TIMEZONE TRUST_PROXY
  DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD DB_ROOT_PASSWORD DB_POOL_SIZE
  SCHEDULER_ENABLED SCHEDULER_INTERVAL_SECONDS
  TEBAR_API_KEY TEBAR_PROFILE_ID TEBAR_ACCOUNT_ID TEBAR_WEBHOOK_SECRET
  OPENROUTER_API_KEY OPENROUTER_MODEL OPENROUTER_GENERATOR_TEMPERATURE OPENROUTER_GENERATOR_TOP_P
  TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID
  LEARNING_CAPTURE_ENABLED LEARNING_ACTIVATION_ENABLED LEARNING_RETRIEVAL_ENABLED
  LEARNING_PROMPT_INTEGRATION_ENABLED LEARNING_SHADOW_ENABLED LEARNING_RETENTION_ENABLED
  LEARNING_RETENTION_DAYS
)

if [[ "${BOTMERZZ_TEST_MODE:-}" == "1" ]]; then
  APP_DIR="${BOTMERZZ_APP_DIR:?test mode requires BOTMERZZ_APP_DIR}"
else
  APP_DIR="/opt/botmerzz"
fi

WORKSPACE="${GITHUB_WORKSPACE:-}"
REPOSITORY="${GITHUB_REPOSITORY:-}"
COMMIT_SHA="${BOTMERZZ_COMMIT_SHA:-}"
EXPECTED_MAIN_SHA="${BOTMERZZ_EXPECTED_MAIN_SHA:-}"

if [[ "${GITHUB_EVENT_NAME:-}" != "workflow_run" ||
      "${BOTMERZZ_CI_WORKFLOW_NAME:-}" != "CI" ||
      "${BOTMERZZ_CI_WORKFLOW_PATH:-}" != ".github/workflows/ci.yml" ||
      "${BOTMERZZ_CI_EVENT:-}" != "push" ||
      "${BOTMERZZ_CI_BRANCH:-}" != "main" ||
      "${BOTMERZZ_CI_CONCLUSION:-}" != "success" ||
      "${BOTMERZZ_CI_REPOSITORY:-}" != "mamay-org/botmerzz" ||
      "${BOTMERZZ_CI_HEAD_REPOSITORY:-}" != "mamay-org/botmerzz" ||
      "$REPOSITORY" != "mamay-org/botmerzz" ||
      -z "$WORKSPACE" ||
      "$EXPECTED_MAIN_SHA" != "$COMMIT_SHA" ]]; then
  fail "CI provenance is invalid or stale; refusing deployment."
fi
if ! is_full_sha "$COMMIT_SHA" || ! is_full_sha "$EXPECTED_MAIN_SHA"; then
  fail "CI provenance is invalid or stale; refusing deployment."
fi

if [[ "$APP_DIR" != /* || "$APP_DIR" == *[[:space:]]* ]]; then
  fail "deployment directory must be an absolute path without whitespace."
fi

if [[ ! -d "$WORKSPACE" || ! -f "$WORKSPACE/Dockerfile" || ! -f "$WORKSPACE/compose.yaml" ]]; then
  fail "checked-out release workspace is incomplete."
fi

CHECKED_OUT_SHA="$(git -C "$WORKSPACE" rev-parse --verify HEAD 2>/dev/null || true)"
if [[ "$CHECKED_OUT_SHA" != "$COMMIT_SHA" ]]; then
  fail "checked-out source does not match the tested CI commit."
fi
if [[ -n "$(git -C "$WORKSPACE" status --porcelain 2>/dev/null)" ]]; then
  fail "checked-out release workspace has unexpected modifications."
fi
if git -C "$WORKSPACE" ls-tree -r --name-only "$COMMIT_SHA" |
  awk -F/ '$NF ~ /^\.env/ && $NF != ".env.example" { found = 1 } END { exit !found }'; then
  fail "release source contains a tracked runtime environment file."
fi

ENV_FILE="$APP_DIR/.env"
if [[ ! -f "$ENV_FILE" || -L "$ENV_FILE" || ! -r "$ENV_FILE" ]]; then
  fail "LXC-local runtime environment is missing or unreadable."
fi
ENV_MODE="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE" 2>/dev/null || true)"
if [[ "$ENV_MODE" != "600" ]]; then
  fail "LXC-local runtime environment must have mode 600."
fi

for key in DB_PASSWORD DB_ROOT_PASSWORD; do
  if ! env_value_is_nonempty "$key"; then
    fail "LXC-local database credential $key is missing."
  fi
done
for pair in \
  "NODE_ENV production" \
  "PORT 3000" \
  "HOST_IP 192.168.0.27" \
  "HOST_PORT 3000" \
  "BASE_URL https://botmerzz.sequein.my.id" \
  "TIMEZONE Asia/Kuala_Lumpur" \
  "TRUST_PROXY 192.168.0.80" \
  "DB_HOST db" \
  "DB_PORT 3306" \
  "DB_NAME botmerzz" \
  "DB_USER botmerzz_app" \
  "DB_POOL_SIZE 5"; do
  read -r key expected <<< "$pair"
  if ! env_value_matches "$key" "$expected"; then
    fail "LXC-local runtime setting $key does not match the homelab target."
  fi
done

ACTIVE_LINK="$APP_DIR/active"
STATE_DIR="$APP_DIR/state"
VOLUME_MARKER="$STATE_DIR/database-volume"
VOLUME_NAME="botmerzz_mysql_data"

if [[ -n "${DOCKER_HOST:-}" || -n "${DOCKER_CONTEXT:-}" ]]; then
  fail "remote Docker endpoint overrides are not allowed on the homelab runner."
fi
for command_name in docker git tar curl awk grep stat readlink mktemp install mv head date ln rm cat sleep; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required deployment command $command_name is unavailable."
done
docker info >/dev/null 2>&1 || fail "local Docker Engine is unavailable."
docker compose version >/dev/null 2>&1 || fail "Docker Compose is unavailable."
DOCKER_CONTEXT_NAME="$(docker context show 2>/dev/null || true)"
if [[ -z "$DOCKER_CONTEXT_NAME" ]]; then
  fail "Docker CLI has no active local context."
fi
DOCKER_ENDPOINT="$(docker context inspect --format '{{(index .Endpoints "docker").Host}}' "$DOCKER_CONTEXT_NAME" 2>/dev/null || true)"
if [[ "$DOCKER_ENDPOINT" != unix://* ]]; then
  fail "Docker context must point to the local Unix socket."
fi

INITIAL_BOOTSTRAP=true
if [[ -L "$ACTIVE_LINK" ]]; then
  ACTIVE_TARGET="$(readlink "$ACTIVE_LINK")"
  if [[ ! "$ACTIVE_TARGET" =~ ^releases/[a-f0-9]{40}$ || ! -f "$APP_DIR/$ACTIVE_TARGET/metadata.json" ]]; then
    fail "active release pointer is invalid."
  fi
  INITIAL_BOOTSTRAP=false
elif [[ -e "$ACTIVE_LINK" ]]; then
  fail "active release path exists but is not a symlink."
fi

if [[ "$INITIAL_BOOTSTRAP" == true ]]; then
  for key in \
    SCHEDULER_ENABLED \
    LEARNING_CAPTURE_ENABLED \
    LEARNING_ACTIVATION_ENABLED \
    LEARNING_RETRIEVAL_ENABLED \
    LEARNING_PROMPT_INTEGRATION_ENABLED \
    LEARNING_SHADOW_ENABLED \
    LEARNING_RETENTION_ENABLED; do
    if ! env_value_matches "$key" false; then
      fail "initial bootstrap requires $key=false and all scheduler/Learning execution disabled."
    fi
  done
fi

if [[ -f "$VOLUME_MARKER" ]]; then
  if ! grep -Fxq "volume=$VOLUME_NAME" "$VOLUME_MARKER" ||
     ! grep -Eq '^state=(pending|ready)$' "$VOLUME_MARKER"; then
    fail "database volume state marker is invalid."
  fi
  VOLUME_STATE="$(awk -F= '$1 == "state" { print $2 }' "$VOLUME_MARKER")"
  if [[ "$VOLUME_STATE" == "ready" ]]; then
    docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1 ||
      fail "persistent MySQL volume is missing; refusing to create a replacement database."
  fi
elif [[ "$INITIAL_BOOTSTRAP" == false ]]; then
  fail "active release has no database volume marker; refusing to continue."
else
  docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1 &&
    fail "an existing MySQL volume has no BotMerzz bootstrap marker; refusing to reuse it."
fi

mkdir -p "$APP_DIR/source" "$APP_DIR/releases" "$APP_DIR/backups" "$STATE_DIR"
if [[ ! -f "$VOLUME_MARKER" ]]; then
  printf 'volume=%s\nstate=pending\n' "$VOLUME_NAME" > "$VOLUME_MARKER"
fi

for key in "${ENVIRONMENT_KEYS[@]}"; do
  unset "$key" || true
done

SOURCE_DIR="$APP_DIR/source/$COMMIT_SHA"
SOURCE_MARKER="$SOURCE_DIR/.botmerzz-commit"
SOURCE_STAGING=""
RELEASE_DIR="$APP_DIR/releases/$COMMIT_SHA"
RELEASE_STAGING=""

cleanup_staging() {
  if [[ -n "$SOURCE_STAGING" && -d "$SOURCE_STAGING" && "$SOURCE_STAGING" == "$APP_DIR/source/.${COMMIT_SHA}."* ]]; then
    rm -rf -- "$SOURCE_STAGING"
  fi
  if [[ -n "$RELEASE_STAGING" && -d "$RELEASE_STAGING" && "$RELEASE_STAGING" == "$APP_DIR/releases/.${COMMIT_SHA}."* ]]; then
    rm -rf -- "$RELEASE_STAGING"
  fi
}
trap cleanup_staging EXIT

if [[ -d "$SOURCE_DIR" ]]; then
  [[ -f "$SOURCE_MARKER" ]] && [[ "$(cat "$SOURCE_MARKER")" == "$COMMIT_SHA" ]] ||
    fail "existing source workspace does not match the release commit."
else
  SOURCE_STAGING="$(mktemp -d "$APP_DIR/source/.${COMMIT_SHA}.XXXXXX")"
  git -C "$WORKSPACE" archive --format=tar "$COMMIT_SHA" | tar -xf - -C "$SOURCE_STAGING"
  printf '%s\n' "$COMMIT_SHA" > "$SOURCE_STAGING/.botmerzz-commit"
  mv "$SOURCE_STAGING" "$SOURCE_DIR"
  SOURCE_STAGING=""
fi

if [[ -d "$RELEASE_DIR" ]]; then
  [[ -f "$RELEASE_DIR/metadata.json" && -f "$RELEASE_DIR/compose.yaml" && -f "$RELEASE_DIR/release.env" ]] ||
    fail "existing release directory is incomplete; inspect it before retrying."
  grep -Fq "\"commit\":\"$COMMIT_SHA\"" "$RELEASE_DIR/metadata.json" ||
    fail "existing release metadata does not match the tested commit."
else
  RELEASE_STAGING="$(mktemp -d "$APP_DIR/releases/.${COMMIT_SHA}.XXXXXX")"
  install -m 0644 "$WORKSPACE/compose.yaml" "$RELEASE_STAGING/compose.yaml"
  {
    printf 'BOTMERZZ_IMAGE_TAG=%s\n' "$COMMIT_SHA"
    printf 'BOTMERZZ_BUILD_CONTEXT=%s\n' "$SOURCE_DIR"
  } > "$RELEASE_STAGING/release.env"
  RELEASED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf '{"commit":"%s","image":"botmerzz:%s","createdAt":"%s"}\n' \
    "$COMMIT_SHA" "$COMMIT_SHA" "$RELEASED_AT" > "$RELEASE_STAGING/metadata.json"
  mv "$RELEASE_STAGING" "$RELEASE_DIR"
  RELEASE_STAGING=""
fi

COMPOSE_ARGS=(
  compose
  --project-directory "$APP_DIR"
  --env-file "$ENV_FILE"
  --env-file "$RELEASE_DIR/release.env"
  --project-name botmerzz
  --file "$RELEASE_DIR/compose.yaml"
)
compose() {
  docker "${COMPOSE_ARGS[@]}" "$@"
}

compose config --quiet || fail "Docker Compose configuration is invalid."
docker build \
  --target runtime \
  --build-arg "VCS_REF=$COMMIT_SHA" \
  --tag "botmerzz:$COMMIT_SHA" \
  "$SOURCE_DIR" || fail "local Docker image build failed."

if [[ "$INITIAL_BOOTSTRAP" == false ]]; then
  if [[ -n "$(compose ps -q app)" ]]; then
    compose stop app || fail "the previous app service could not be stopped safely."
  fi
fi

compose up -d --wait --wait-timeout 120 db || fail "MySQL did not become healthy."
compose run --rm --no-deps app npm run migrate || fail "application migrations failed; app remains stopped for operator recovery."
compose up -d --no-deps --wait --wait-timeout 120 app || fail "application container did not become healthy."

HEALTH_RETRIES="${BOTMERZZ_HEALTH_RETRIES:-15}"
HEALTH_RETRY_DELAY="${BOTMERZZ_HEALTH_RETRY_DELAY:-2}"
if [[ ! "$HEALTH_RETRIES" =~ ^[1-9][0-9]*$ || ! "$HEALTH_RETRY_DELAY" =~ ^[0-9]+$ ]]; then
  fail "health-check retry configuration is invalid."
fi

check_health() {
  local description="$1" url="$2"
  shift 2
  local attempt
  for ((attempt = 1; attempt <= HEALTH_RETRIES; attempt++)); do
    if curl --fail --silent --show-error --max-time 10 "$@" "$url" >/dev/null 2>&1; then
      printf '%s health check passed.\n' "$description"
      return 0
    fi
    if (( attempt < HEALTH_RETRIES )); then sleep "$HEALTH_RETRY_DELAY"; fi
  done
  fail "$description health check failed; inspect the app and ingress on LXC 10027."
}

check_health "LAN application" "http://192.168.0.27:3000/health/ready"
check_health "Traefik Host-header route" "http://192.168.0.80/health/ready" \
  -H "Host: botmerzz.sequein.my.id" -H "X-Forwarded-Proto: https"
check_health "Public HTTPS" "https://botmerzz.sequein.my.id/health/ready"

APP_CONTAINER_ID="$(compose ps -q app | head -n 1)"
if [[ -z "$APP_CONTAINER_ID" ]]; then
  fail "healthy app service has no running container."
fi
RUNNING_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$APP_CONTAINER_ID" 2>/dev/null || true)"
RUNNING_REVISION="$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$APP_CONTAINER_ID" 2>/dev/null || true)"
if [[ "$RUNNING_IMAGE" != "botmerzz:$COMMIT_SHA" || "$RUNNING_REVISION" != "$COMMIT_SHA" ]]; then
  fail "running app image does not match the tested commit."
fi

RUNTIME_ENV="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$APP_CONTAINER_ID" 2>/dev/null || true)"
for key in \
  SCHEDULER_ENABLED \
  LEARNING_CAPTURE_ENABLED \
  LEARNING_ACTIVATION_ENABLED \
  LEARNING_RETRIEVAL_ENABLED \
  LEARNING_PROMPT_INTEGRATION_ENABLED \
  LEARNING_SHADOW_ENABLED \
  LEARNING_RETENTION_ENABLED; do
  value="$(printf '%s\n' "$RUNTIME_ENV" | awk -F= -v key="$key" '$1 == key { count++; value = $2 } END { if (count == 1) print value }')"
  if [[ "$value" != "true" && "$value" != "false" ]]; then
    fail "effective runtime flag $key is missing or invalid."
  fi
  if [[ "$INITIAL_BOOTSTRAP" == true && "$value" != "false" ]]; then
    fail "effective initial runtime flag $key must be false."
  fi
done

if [[ -f "$VOLUME_MARKER" ]]; then
  printf 'volume=%s\nstate=ready\n' "$VOLUME_NAME" > "$VOLUME_MARKER.tmp"
  mv -f "$VOLUME_MARKER.tmp" "$VOLUME_MARKER"
fi

PREVIOUS_SHA=""
if [[ -L "$ACTIVE_LINK" ]]; then
  PREVIOUS_TARGET="$(readlink "$ACTIVE_LINK")"
  PREVIOUS_SHA="${PREVIOUS_TARGET#releases/}"
  printf '%s\n' "$PREVIOUS_SHA" > "$APP_DIR/previous-release.tmp"
  mv -f "$APP_DIR/previous-release.tmp" "$APP_DIR/previous-release"
fi

NEXT_ACTIVE_LINK="$APP_DIR/.active-$COMMIT_SHA-$$"
ln -s "releases/$COMMIT_SHA" "$NEXT_ACTIVE_LINK"
if mv --version >/dev/null 2>&1; then
  mv -fT "$NEXT_ACTIVE_LINK" "$ACTIVE_LINK"
else
  mv -fh "$NEXT_ACTIVE_LINK" "$ACTIVE_LINK"
fi

printf 'Deployment succeeded for commit %s.\n' "$COMMIT_SHA"
printf 'Scheduler and Learning flags were verified in the running app environment.\n'
