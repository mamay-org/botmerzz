#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly app_dir=/opt/botmerzz-staging
readonly env_file="$app_dir/.env"
readonly compose_file="$app_dir/compose.vps.yaml"
readonly next_compose_file="${3:-}"
readonly retry_helper_file="${4:-}"
readonly deploy_script_file="${BASH_SOURCE[0]}"

commit_sha="${1:-}"
image_ref="${2:-}"
[[ "$commit_sha" =~ ^[a-f0-9]{40}$ ]] || { echo 'Invalid commit SHA.' >&2; exit 2; }
[[ "$image_ref" =~ ^ghcr\.io/mamay-org/botmerzz@sha256:[a-f0-9]{64}$ ]] || {
  echo 'Invalid digest-pinned image reference.' >&2
  exit 2
}
[[ "$next_compose_file" =~ ^/opt/botmerzz-staging/compose\.vps\.yaml\.next\.[0-9]+$ ]] || {
  echo 'Invalid incoming Compose manifest path.' >&2
  exit 2
}
[[ "$retry_helper_file" =~ ^/opt/botmerzz-staging/retry-command\.sh\.next\.[0-9]+$ ]] || {
  echo 'Invalid incoming retry helper path.' >&2
  exit 2
}
[[ "$deploy_script_file" =~ ^/opt/botmerzz-staging/deploy-staging\.sh\.next\.[0-9]+$ ]] || {
  echo 'Invalid incoming deployment script path.' >&2
  exit 2
}
if [[ ! "${DOCKER_CONFIG:-}" =~ ^/opt/botmerzz-staging/\.ghcr-auth-[0-9]+$ ]]; then
  echo 'Temporary GHCR Docker config is missing or has an invalid path.' >&2
  exit 2
fi

env_backup=''
compose_backup=''
env_tmp=''
changed=false
completed=false
startup_attempted=false
backup_file=''
rollback_image_file=''
rollback_compose_file=''
rollback_env_file=''
rollback_image_tmp=''
rollback_compose_tmp=''
backup_tmp=''

cleanup() {
  exit_code=$?
  if [[ "$changed" == true && "$completed" != true && "$startup_attempted" == false ]]; then
    echo 'Deployment failed before app startup; restoring previous app configuration.' >&2
    set +e
    cp -p "$env_backup" "$env_file"
    cp -p "$compose_backup" "$compose_file"
    set -e
  elif [[ "$changed" == true && "$completed" != true ]]; then
    echo 'App startup was attempted; migrations may have committed. No automatic image rollback: inspect schema and use the approved recovery procedure.' >&2
  fi

  [[ -z "$env_tmp" ]] || rm -f -- "$env_tmp"
  [[ -z "$env_backup" ]] || rm -f -- "$env_backup"
  [[ -z "$compose_backup" ]] || rm -f -- "$compose_backup"
  [[ -z "$rollback_image_tmp" ]] || rm -f -- "$rollback_image_tmp"
  [[ -z "$rollback_compose_tmp" ]] || rm -f -- "$rollback_compose_tmp"
  [[ -z "$backup_tmp" ]] || rm -f -- "$backup_tmp"
  rm -f -- "$next_compose_file" "$retry_helper_file" "$deploy_script_file"

  DOCKER_CONFIG="$DOCKER_CONFIG" docker logout ghcr.io >/dev/null 2>&1 || true
  rm -rf -- "$DOCKER_CONFIG"
  exit "$exit_code"
}
trap cleanup EXIT

if [[ ! -f "$env_file" || ! -f "$compose_file" || ! -f "$next_compose_file" || ! -f "$retry_helper_file" ]]; then
  echo 'Staging environment, Compose file, or retry helper is missing.' >&2
  exit 2
fi
if [[ ! -s "$DOCKER_CONFIG/config.json" ]]; then
  echo 'Temporary GHCR login is missing.' >&2
  exit 2
fi
if ! command -v flock >/dev/null 2>&1; then
  echo 'The util-linux flock command is required to serialize staging deployments.' >&2
  exit 2
fi
exec 9>"$app_dir/.deploy-staging.lock"
chmod 600 "$app_dir/.deploy-staging.lock"
if ! flock -n 9; then
  echo 'Another staging deployment is already running.' >&2
  exit 75
fi

old_image="$(sed -n 's/^APP_IMAGE=//p' "$env_file" | head -n 1)"
[[ -n "$old_image" ]] || { echo 'APP_IMAGE is missing in the staging environment.' >&2; exit 2; }
current_container="$(docker compose --env-file "$env_file" -p botmerzz-staging -f "$compose_file" ps -q app)"
[[ "$current_container" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo 'Expected exactly one current app container.' >&2; exit 1; }
current_scheduler="$(docker inspect "$current_container" | python3 -c '
import json, sys
try:
    values = dict(item.split("=", 1) for item in json.load(sys.stdin)[0]["Config"]["Env"] if "=" in item)
    value = values.get("SCHEDULER_ENABLED", "false").strip().lower()
    if value not in ("true", "false"): raise ValueError()
    print(value)
except (KeyError, IndexError, TypeError, ValueError):
    print("Cannot establish current scheduler configuration.", file=sys.stderr)
    sys.exit(1)
')"

env_backup="$(mktemp "$app_dir/.env.rollback.XXXXXX")"
compose_backup="$(mktemp "$app_dir/.compose.rollback.XXXXXX")"
cp -- "$env_file" "$env_backup"
cp -- "$compose_file" "$compose_backup"

backup_dir="$app_dir/backups"
install -d -m 700 "$backup_dir"
chmod 700 "$backup_dir"
backup_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_prefix="$backup_dir/predeploy-${commit_sha}-${backup_stamp}"
backup_file="${backup_prefix}.sql.gz"
rollback_image_file="${backup_prefix}.image"
rollback_compose_file="${backup_prefix}.compose.vps.yaml"
rollback_env_file="${backup_prefix}.env"
if [[ -e "$backup_file" || -e "$rollback_image_file" || -e "$rollback_compose_file" || -e "$rollback_env_file" ]]; then
  echo 'A pre-deployment backup already exists for this timestamp; refusing to overwrite it.' >&2
  exit 1
fi
backup_tmp="$backup_file.tmp"
if ! docker compose --env-file "$env_file" -p botmerzz-staging -f "$compose_file" \
  exec -T db sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqldump --single-transaction --routines --triggers -uroot "$MYSQL_DATABASE"' \
  | gzip -c > "$backup_tmp"; then
  rm -f -- "$backup_tmp"
  echo 'Pre-deployment database backup failed; deployment stopped.' >&2
  exit 1
fi
if ! gzip -t "$backup_tmp"; then
  echo 'Pre-deployment backup integrity check failed; deployment stopped.' >&2
  exit 1
fi
chmod 600 "$backup_tmp"
mv -- "$backup_tmp" "$backup_file"
backup_tmp=''

rollback_image_tmp="$(mktemp "$backup_dir/.rollback-image.XXXXXX")"
rollback_compose_tmp="$(mktemp "$backup_dir/.rollback-compose.XXXXXX")"
printf 'APP_IMAGE=%s\n' "$old_image" > "$rollback_image_tmp"
cp -- "$compose_file" "$rollback_compose_tmp"
cp -- "$env_file" "$rollback_env_file"
chmod 600 "$rollback_env_file"
chmod 600 "$rollback_image_tmp" "$rollback_compose_tmp"
mv -- "$rollback_image_tmp" "$rollback_image_file"
rollback_image_tmp=''
mv -- "$rollback_compose_tmp" "$rollback_compose_file"
rollback_compose_tmp=''
env_tmp="$(mktemp "$app_dir/.env.deploy.XXXXXX")"
awk -v image="$image_ref" '
  BEGIN { replaced = 0 }
  /^APP_IMAGE=/ {
    if (replaced != 0) exit 2
    print "APP_IMAGE=" image
    replaced = 1
    next
  }
  { print }
  END { if (replaced != 1) exit 3 }
' "$env_file" > "$env_tmp"
chmod 600 "$env_tmp"

# Check the fully interpolated incoming Compose configuration without printing it:
# environment values may come from shell overrides as well as the env file.
if ! docker compose --env-file "$env_tmp" -p botmerzz-staging -f "$next_compose_file" config --format json | python3 -c '
import json, sys
try:
    app = json.load(sys.stdin)["services"]["app"]
    env = app["environment"]
    names = ("LEARNING_CAPTURE_ENABLED", "LEARNING_ACTIVATION_ENABLED", "LEARNING_RETRIEVAL_ENABLED", "LEARNING_PROMPT_INTEGRATION_ENABLED", "LEARNING_SHADOW_ENABLED", "LEARNING_RETENTION_ENABLED")
    if not all(str(env.get(name, "")).strip().lower() == "false" for name in names):
        raise ValueError("learning flags must all be explicitly false")
    if str(env.get("SCHEDULER_ENABLED", "")).strip().lower() != sys.argv[1]:
        raise ValueError("scheduler configuration changed")
except (KeyError, TypeError, ValueError):
    print("Incoming Compose must disable all six Learning flags and preserve the scheduler setting.", file=sys.stderr)
    sys.exit(1)
' "$current_scheduler"; then
  echo 'Incoming Compose safety check failed; deployment stopped.' >&2
  exit 1
fi
mv -- "$env_tmp" "$env_file"
env_tmp=''
changed=true

mv -- "$next_compose_file" "$compose_file"
docker compose --env-file "$env_file" -p botmerzz-staging -f "$compose_file" config --quiet
if ! /bin/bash "$retry_helper_file" docker compose --env-file "$env_file" \
  -p botmerzz-staging -f "$compose_file" pull app; then
  echo 'GHCR image pull failed after retries; checking VPS host connectivity to ghcr.io.' >&2
  if ghcr_status="$(curl --silent --show-error --connect-timeout 8 --max-time 15 \
    --output /dev/null --write-out '%{http_code}' https://ghcr.io/v2/ 2>/dev/null)"; then
    case "$ghcr_status" in
      200|401)
        echo "Host connectivity to ghcr.io is available (HTTP ${ghcr_status}); check Docker daemon networking, DNS, or proxy settings." >&2
        ;;
      *)
        echo "Host GHCR connectivity probe returned HTTP ${ghcr_status}." >&2
        ;;
    esac
  else
    echo 'Host could not reach ghcr.io over HTTPS; check VPS outbound DNS, TCP 443, or provider firewall.' >&2
  fi
  exit 1
fi

# The first upgrade requires an operator-attested restore and approved plan
# bound to this exact release. The live database query is read-only.
db_has_019="$(docker compose --env-file "$env_file" -p botmerzz-staging -f "$compose_file" exec -T db sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot "$MYSQL_DATABASE" -Nse "SELECT COUNT(*) FROM schema_migrations WHERE version=0x3031395f6c6561726e696e675f736861646f775f61646d697373696f6e2e73716c"')"
if [[ ! "$db_has_019" =~ ^[01]$ ]]; then
  echo 'Unable to establish first Learning migration state; deployment stopped.' >&2
  exit 1
fi
if [[ "$db_has_019" == 0 ]]; then
  evidence="$backup_dir/first-learning-upgrade-${commit_sha}.evidence"
  verified_backup="$backup_dir/first-learning-upgrade-${commit_sha}.sql.gz"
  approved_plan="$backup_dir/first-learning-upgrade-${commit_sha}.plan"
  if [[ ! -s "$evidence" || ! -s "$verified_backup" || ! -s "$approved_plan" ]] || ! python3 - "$evidence" "$verified_backup" "$approved_plan" "$image_ref" <<'PY'
import hashlib, pathlib, sys
try:
    evidence, backup, plan, image = sys.argv[1:]
    lines = pathlib.Path(evidence).read_text().splitlines()
    pairs = [line.split('=', 1) for line in lines]
    data = dict(pairs)
    if len(data) != len(pairs) or set(data) != {'image', 'backup_sha256', 'plan_sha256', 'restore_verified', 'plan_approved'}:
        raise ValueError('invalid evidence')
    def digest(path):
        h = hashlib.sha256()
        with open(path, 'rb') as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b''):
                h.update(chunk)
        return h.hexdigest()
    if (data['image'] != image or data['restore_verified'] != 'yes' or data['plan_approved'] != 'yes'
            or data['backup_sha256'] != digest(backup) or data['plan_sha256'] != digest(plan)):
        raise ValueError('evidence mismatch')
except (OSError, UnicodeError, ValueError):
    print('First-upgrade evidence missing or invalid; verified restore and approved plan required.', file=sys.stderr)
    sys.exit(1)
PY
  then
    echo 'First Learning upgrade blocked pending operator backup, restore and plan evidence.' >&2
    exit 1
  fi
  if ! gzip -t "$verified_backup"; then
    echo 'The operator-verified backup is not a valid gzip archive.' >&2
    exit 1
  fi
fi
startup_attempted=true
docker compose --env-file "$env_file" -p botmerzz-staging -f "$compose_file" \
  up -d --no-deps --wait --wait-timeout 240 app

app_container="$(docker compose --env-file "$env_file" -p botmerzz-staging -f "$compose_file" ps -q app)"
expected_image_id="$(docker image inspect --format '{{.Id}}' "$image_ref")"
if [[ ! "$app_container" =~ ^[A-Za-z0-9_.-]+$ || -z "$expected_image_id" || "$(docker inspect --format '{{.Image}}' "$app_container")" != "$expected_image_id" ]]; then
  echo 'Running app image does not match the requested digest.' >&2
  exit 1
fi
if ! docker inspect "$app_container" | python3 -c '
import json, sys
try:
    values = dict(item.split("=", 1) for item in json.load(sys.stdin)[0]["Config"]["Env"] if "=" in item)
    names = ("LEARNING_CAPTURE_ENABLED", "LEARNING_ACTIVATION_ENABLED", "LEARNING_RETRIEVAL_ENABLED", "LEARNING_PROMPT_INTEGRATION_ENABLED", "LEARNING_SHADOW_ENABLED", "LEARNING_RETENTION_ENABLED")
    if not all(values.get(name, "").strip().lower() == "false" for name in names): raise ValueError()
    if values.get("SCHEDULER_ENABLED", "").strip().lower() != sys.argv[1]: raise ValueError()
except (KeyError, IndexError, TypeError, ValueError):
    print("Running app flags or scheduler configuration do not match the approved configuration.", file=sys.stderr)
    sys.exit(1)
' "$current_scheduler"; then
  echo 'Running app configuration verification failed.' >&2
  exit 1
fi

base_url="$(sed -n 's/^BASE_URL=//p' "$env_file" | head -n 1)"
if [[ -z "$base_url" ]] || ! curl --fail --silent --show-error --max-time 20 \
  "${base_url%/}/health/ready" >/dev/null; then
  echo 'Staging HTTP readiness check failed.' >&2
  exit 1
fi

completed=true
echo "Staging app ready on commit ${commit_sha} with image ${image_ref}."
echo 'App startup may immediately tick the in-process scheduler; persisted schedule and automation settings were left unchanged.'
echo "Pre-deployment backups (mode 600): ${backup_file}, ${rollback_image_file}, ${rollback_compose_file}, ${rollback_env_file}."

