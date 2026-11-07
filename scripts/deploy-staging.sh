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
backup_file=''
rollback_image_file=''
rollback_compose_file=''
rollback_image_tmp=''
rollback_compose_tmp=''
backup_tmp=''

cleanup() {
  exit_code=$?
  if [[ "$changed" == true && "$completed" != true ]]; then
    echo 'Deployment readiness failed; restoring previous app configuration.' >&2
    set +e
    cp -p "$env_backup" "$env_file"
    cp -p "$compose_backup" "$compose_file"
    docker compose --env-file "$env_file" -p botmerzz-staging -f "$compose_file" \
      up -d --no-deps --wait --wait-timeout 240 app
    set -e
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

env_backup="$(mktemp "$app_dir/.env.rollback.XXXXXX")"
compose_backup="$(mktemp "$app_dir/.compose.rollback.XXXXXX")"
cp -p "$env_file" "$env_backup"
cp -p "$compose_file" "$compose_backup"

backup_dir="$app_dir/backups"
install -d -m 700 "$backup_dir"
chmod 700 "$backup_dir"
backup_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_prefix="$backup_dir/predeploy-${commit_sha}-${backup_stamp}"
backup_file="${backup_prefix}.sql.gz"
rollback_image_file="${backup_prefix}.image"
rollback_compose_file="${backup_prefix}.compose.vps.yaml"
if [[ -e "$backup_file" || -e "$rollback_image_file" || -e "$rollback_compose_file" ]]; then
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
chmod 600 "$backup_tmp"
mv -- "$backup_tmp" "$backup_file"
backup_tmp=''

rollback_image_tmp="$(mktemp "$backup_dir/.rollback-image.XXXXXX")"
rollback_compose_tmp="$(mktemp "$backup_dir/.rollback-compose.XXXXXX")"
printf 'APP_IMAGE=%s\n' "$old_image" > "$rollback_image_tmp"
cp -- "$compose_file" "$rollback_compose_tmp"
chmod 600 "$rollback_image_tmp" "$rollback_compose_tmp"
mv -- "$rollback_image_tmp" "$rollback_image_file"
rollback_image_tmp=''
mv -- "$rollback_compose_tmp" "$rollback_compose_file"
rollback_compose_tmp=''
find "$backup_dir" -type f \( \
  -name 'predeploy-*.sql.gz' -o \
  -name 'predeploy-*.image' -o \
  -name 'predeploy-*.compose.vps.yaml' \
\) -mtime +30 -delete

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
docker compose --env-file "$env_file" -p botmerzz-staging -f "$compose_file" \
  up -d --no-deps --wait --wait-timeout 240 app

base_url="$(sed -n 's/^BASE_URL=//p' "$env_file" | head -n 1)"
if [[ -z "$base_url" ]] || ! curl --fail --silent --show-error --max-time 20 \
  "${base_url%/}/health/ready" >/dev/null; then
  echo 'Staging HTTP readiness check failed.' >&2
  exit 1
fi

completed=true
echo "Staging app ready on commit ${commit_sha} with image ${image_ref}."
echo 'App startup may immediately tick the in-process scheduler; persisted schedule and automation settings were left unchanged.'
echo "Pre-deployment backups (mode 600): ${backup_file}, ${rollback_image_file}, ${rollback_compose_file}."

