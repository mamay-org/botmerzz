# [Historical archive] BotMerzz First Learning Upgrade Plan — Legacy VPS/GHCR

> **Archived and superseded. Do not execute this plan.** This document records a previous VPS/GHCR migration rehearsal and is retained as historical context only. The current deployment target and procedure are Proxmox LXC 10027 in [Deployment](DEPLOYMENT.md). The legacy host, backup, image, workflow, paths, approvals, and commands below are not current infrastructure facts or authorization to access a VPS, run an old workflow, migrate a database, or publish content.

**Historical status:** Superseded; not approved and not an execution authorization.

## Release binding

- Target: existing VPS 178.83.188.163 (host.botmerzz.my.id), Compose project botmerzz-staging.
- Application change: commit 9a7df5e405c3b557bb9523834465226191da5e69.
- Exact application image: ghcr.io/mamay-org/botmerzz@sha256:ecaaa4a9f19c1482c6220be8f7dcd2faee6bbd401f9a646baa8ae6eb7f44d162.
- Current database schema: 010_dynamic_configuration.sql; planned result: 019_learning_shadow_admission.sql.
- Deployment run 43021505573 stopped at the first-upgrade gate before application startup. No migration or app replacement occurred in that run.

This plan upgrades the existing database and app in place. It does not create a second service, database, scheduler, or volume. It preserves the existing publishing history and scheduler/automation settings. The deployment must continue using the existing workflow and scripts/deploy-staging.sh.

## Verified backup and rehearsal

The database was dumped from the existing MySQL 8.4.13 container with a consistent InnoDB snapshot:

~~~sh
docker exec botmerzz-staging-db-1 sh -c \
  'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqldump --single-transaction --quick --routines --triggers --events --hex-blob --set-gtid-purged=OFF --no-tablespaces -uroot "$MYSQL_DATABASE"'
~~~

The output was gzipped to a temporary file on the VPS, checked with gzip -t, set to mode 600, then atomically placed at:

/opt/botmerzz-staging/backups/first-learning-upgrade-9a7df5e405c3b557bb9523834465226191da5e69.sql.gz

- Snapshot time: 2026-11-11 13:41:27 UTC.
- Size: 76,156 bytes.
- SHA-256: c7e1fe399f4c222d5057a260e392d230864afbff2e3a1ef2b197d25f805ae94b.
- The prior verified snapshot was retained at a separate path; no backup was deleted.

### Reproducible controlled command sequence

The following describes the completed process. The current target file already exists; if creating a replacement snapshot, use a new UTC timestamped candidate and archive the existing target before promotion. Never overwrite it silently.

~~~sh
set -Eeuo pipefail
umask 077
APP=/opt/botmerzz-staging
COMMIT=9a7df5e405c3b557bb9523834465226191da5e69
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
chmod 700 "$APP/backups"
CANDIDATE="$APP/backups/.first-learning-upgrade-$COMMIT.$STAMP.candidate.sql.gz"
TEMP="$CANDIDATE.tmp"
test ! -e "$CANDIDATE"
test ! -e "$TEMP"
cleanup_backup() { test ! -e "$TEMP" || unlink "$TEMP"; }
trap cleanup_backup EXIT
docker exec botmerzz-staging-db-1 sh -c \
  'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqldump --single-transaction --quick --routines --triggers --events --hex-blob --set-gtid-purged=OFF --no-tablespaces -uroot "$MYSQL_DATABASE"' \
  | gzip -c > "$TEMP"
gzip -t "$TEMP"
chmod 600 "$TEMP"
mv -- "$TEMP" "$CANDIDATE"
trap - EXIT
sha256sum "$CANDIDATE"
~~~

Only after the candidate has passed an isolated restore, promote it to the gate's fixed backup path while preserving the prior snapshot:

~~~sh
TARGET="$APP/backups/first-learning-upgrade-$COMMIT.sql.gz"
ARCHIVE="$APP/backups/first-learning-upgrade-$COMMIT.snapshot-$STAMP.sql.gz"
if test -e "$TARGET"; then
  test ! -e "$ARCHIVE"
  cp --preserve=mode,ownership "$TARGET" "$ARCHIVE"
  chmod 600 "$ARCHIVE"
fi
mv -- "$CANDIDATE" "$TARGET"
chmod 600 "$TARGET"
gzip -t "$TARGET"
sha256sum "$TARGET"
~~~

For the isolated restore, generate a disposable local-only password and use an ephemeral Docker network/container without a volume or host port. Wait for an authenticated SELECT before streaming the backup over SSH; never store the uncompressed dump locally:

~~~sh
set -Eeuo pipefail
RESTORE_CONTAINER=botmerzz-first-upgrade-final-restore-20261111
RESTORE_NETWORK=botmerzz-first-upgrade-final-net-20261111
RESTORE_PASSWORD=$(openssl rand -hex 32)
cleanup_restore() {
  docker container rm --force "$RESTORE_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$RESTORE_NETWORK" >/dev/null 2>&1 || true
}
trap cleanup_restore EXIT
docker network create "$RESTORE_NETWORK"
docker run --detach --rm \
  --name "$RESTORE_CONTAINER" \
  --network "$RESTORE_NETWORK" \
  --network-alias restore-db \
  --env MYSQL_ROOT_PASSWORD="$RESTORE_PASSWORD" \
  --env MYSQL_DATABASE=botmerzz_restore mysql:8.4.13
ready=false
for attempt in $(seq 1 90); do
  if docker exec --env MYSQL_PWD="$RESTORE_PASSWORD" "$RESTORE_CONTAINER" \
    mysql --batch --skip-column-names --user=root botmerzz_restore \
    --execute='SELECT 1' >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
test "$ready" = true
ssh botmerzz-vps \
  'gzip -cd /opt/botmerzz-staging/backups/first-learning-upgrade-9a7df5e405c3b557bb9523834465226191da5e69.sql.gz' \
  | docker exec --interactive --env MYSQL_PWD="$RESTORE_PASSWORD" "$RESTORE_CONTAINER" \
      mysql --user=root botmerzz_restore
~~~

The rehearsal then ran only the migration CLI from the exact image ID. No app-server command, scheduler, publisher, or provider credential was supplied:

~~~sh
docker run --rm \
  --network botmerzz-first-upgrade-final-net-20261111 \
  --entrypoint node \
  --env NODE_ENV=test \
  --env DB_HOST=restore-db --env DB_PORT=3306 \
  --env DB_USER=root --env DB_PASSWORD="$RESTORE_PASSWORD" \
  --env DB_NAME=botmerzz_restore \
  --env SCHEDULER_ENABLED=false \
  --env LEARNING_CAPTURE_ENABLED=false \
  --env LEARNING_ACTIVATION_ENABLED=false \
  --env LEARNING_RETRIEVAL_ENABLED=false \
  --env LEARNING_PROMPT_INTEGRATION_ENABLED=false \
  --env LEARNING_SHADOW_ENABLED=false \
  --env LEARNING_RETENTION_ENABLED=false \
  sha256:ecaaa4a9f19c1482c6220be8f7dcd2faee6bbd401f9a646baa8ae6eb7f44d162 \
  src/cli.js migrate
~~~

The final argument above is the local Docker image ID verified against the VPS inspection of the full repository digest, not a locally present name@digest reference.

After comparing schema_migrations, existing row counts, the migration 018 index, slots, and a hash of publishing/idempotency fields, the temporary environment was removed:

~~~sh
docker exec --env MYSQL_PWD="$RESTORE_PASSWORD" "$RESTORE_CONTAINER" \
  mysql --batch --skip-column-names --user=root botmerzz_restore \
  --execute='SELECT version FROM schema_migrations ORDER BY version'
docker exec --env MYSQL_PWD="$RESTORE_PASSWORD" "$RESTORE_CONTAINER" \
  mysql --batch --skip-column-names --user=root botmerzz_restore \
  --execute='SELECT status,COUNT(*) FROM slots GROUP BY status ORDER BY status'
docker exec --env MYSQL_PWD="$RESTORE_PASSWORD" "$RESTORE_CONTAINER" \
  mysql --batch --skip-column-names --user=root botmerzz_restore \
  --execute="SELECT COUNT(*),COUNT(DISTINCT id),SUM(status='published'),SUM(provider_post_id IS NOT NULL),SUM(idempotency_key IS NOT NULL),COUNT(DISTINCT idempotency_key),SUM(status IN ('ready','publishing','unknown','generating')) FROM slots"
docker exec --env MYSQL_PWD="$RESTORE_PASSWORD" "$RESTORE_CONTAINER" \
  mysql --batch --skip-column-names --user=root botmerzz_restore \
  --execute='CHECK TABLE slots'
cleanup_restore
trap - EXIT
~~~

These local restore/rehearsal commands are safe to repeat only with a new disposable container/network name and the intended verified backup. Do not run the migration CLI against the VPS container or live database.

The actual backup was streamed over SSH into a disposable, local-only Docker network and restored to a MySQL 8.4.13 container with no persistent volume. No raw SQL dump was written to the workstation. On the VPS, inspecting the full repository-digest reference returned both RepoDigest ghcr.io/mamay-org/botmerzz@sha256:ecaaa4a9f19c1482c6220be8f7dcd2faee6bbd401f9a646baa8ae6eb7f44d162 and image ID sha256:ecaaa4a9f19c1482c6220be8f7dcd2faee6bbd401f9a646baa8ae6eb7f44d162. The image was exported from that exact reference over SSH; the locally loaded image ID and byte size matched the VPS inspection (349,148,201 bytes, 11 layers), and the ordered RootFS layer list hash matched on both hosts: 239a4fd4e24a9598f9307cd6c593e8e6a140177556788b6b85fa749fb681b499. docker load did not retain RepoDigests locally, so the rehearsal invoked the verified local image ID, not a locally tagged repository reference. The image ran only node src/cli.js migrate, with all six Learning flags and SCHEDULER_ENABLED explicitly false. The server command, scheduler, provider clients, and publisher were not started.

Observed verification:

- Restored schema was 001–010; all 15 original base tables used InnoDB.
- The exact release image applied nine migrations and reached 001–019.
- Row counts in the 14 pre-existing application tables other than schema_migrations were unchanged. The migration ledger advanced from 10 to 19 rows.
- Slots remained at 130 rows with 130 unique IDs, 99 published records, 99 provider post IDs, 99 non-null distinct idempotency keys, and zero ready/publishing/unknown/generating records in the restored snapshot.
- A SHA-256 fingerprint over ordered slot IDs, idempotency keys, provider IDs/statuses, slot statuses, scheduled times, and completion times was identical before and after migration: 20d48b4c937757c14eb478cff89da82639110cc61ed72e1fc0aa91337d5ee519. Values were not printed.
- Migration 018 created the visible, ascending, non-unique BTREE index (status, completed_at, id) without prefixes. CHECK TABLE slots returned OK; 39 foreign-key constraints were present after migration.
- The temporary MySQL container and network were removed after verification.

This proves a restore and migration rehearsal for the named snapshot. It does not create offsite disaster recovery: the gate backup remains on the same VPS. The deploy script will also create a fresh pre-deployment dump, but a later snapshot should be restored and rehearsed again if normal scheduler writes make this verified backup stale before release.

## Migration and operational plan

Migrations 011–019 were executed in order by the exact release image. The runner uses a database advisory lock, and migration bookkeeping is written only after a migration's statements succeed. MySQL DDL can commit independently; this is not a promise of transactional schema rollback. Migration 018 validates an already-present named index before accepting it and stops on an incompatible definition without dropping it.

After plan approval and a separate deployment authorization:

1. Immediately before the release, re-identify the VPS, Compose project, single app container, MySQL container, and existing persistent volume. Confirm the database is still at 010 and that the gate backup's hash matches this plan.
2. Recheck the scheduler and slot lifecycle read-only. The scheduler is currently configured on and performs an immediate tick on app startup. Do not begin during generation/publishing or while any outcome is unknown. Choose a window that avoids an upcoming due slot, or first obtain an explicit operational decision about that slot. Do not test by publishing.
3. Confirm the incoming Compose configuration explicitly resolves all six Learning flags to false and preserves the current scheduler setting. The deployment script enforces both before and after app replacement.
4. Stage this exact plan at /opt/botmerzz-staging/backups/first-learning-upgrade-9a7df5e405c3b557bb9523834465226191da5e69.plan, then create the release-bound evidence file only after the operator has approved this exact plan hash. Keep the evidence file mode 600.
5. Re-run failed GitHub Actions run 43021505573 only after separately authorizing the in-place release. With STAGING_DEPLOY_ENABLED=true, a successful rerun replaces the existing app and starts migrations automatically. It does not require a new push.
6. Verify app health, schema 019, all six effective Learning flags false, one app/scheduler, and publishing/slot integrity. Do not send a live Threads request.

The deployment gate requires these three release-bound files:

- first-learning-upgrade-9a7df5e405c3b557bb9523834465226191da5e69.sql.gz
- first-learning-upgrade-9a7df5e405c3b557bb9523834465226191da5e69.plan
- first-learning-upgrade-9a7df5e405c3b557bb9523834465226191da5e69.evidence

When a separate release authorization is given, the .evidence file must contain exactly five unique entries: image set to the exact digest above; backup_sha256 set to c7e1fe399f4c222d5057a260e392d230864afbff2e3a1ef2b197d25f805ae94b; plan_sha256 set to the SHA-256 of this exact plan file as recorded in the production readiness report; restore_verified=yes; and plan_approved=yes. Do not edit the approved plan after calculating its hash.

The deployment script verifies file presence, exact image binding, hashes, gzip integrity, and the two yes assertions. It cannot independently prove that a restore or approval occurred. Neither .plan nor .evidence is currently present on the VPS; the gate remains closed. Do not create .evidence until both plan approval and separate release authorization are explicit.

## Failure handling and stop conditions

- Abort before rerunning if the target, schema version, backup hash, release digest, flags, scheduler configuration, or slot state differs from this plan.
- If failure occurs before app startup, the deployment script restores the prior app configuration.
- Once startup is attempted, migration DDL may have committed. The script intentionally does not automatically restart the old image against an uncertain schema. Inspect schema_migrations and the 018 index, preserve the database, and prefer reviewed forward recovery.
- Do not restore an older snapshot over newer publishing history without separate explicit authorization. The fresh pre-deploy dump and this restore-verified first-upgrade backup are distinct artifacts.
- If normal scheduler writes occur before release, refresh the gate backup and repeat the isolated restore/migration rehearsal for the new hash. Do not attest an old snapshot as current.

## Approval boundary

Approval of this document authorizes only the migration plan. It does not authorize writing plan_approved=yes, rerunning the workflow, changing live configuration, migrating the live database, restarting the app, activating Learning, or publishing to Threads. Deployment requires a separate explicit authorization after the final scheduler/slot and backup checks.
