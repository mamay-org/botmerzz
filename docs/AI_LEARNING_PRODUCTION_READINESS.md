# AI Learning Center — Controlled Rollout Readiness

> **Historical VPS/GHCR assessment — superseded.** The technical evidence below records an earlier VPS deployment review and is retained unchanged as historical context. Its target, workflows, credentials, database state, commands, and readiness decisions do not describe the current homelab deployment. The current target and operator instructions are in [Deployment](DEPLOYMENT.md); no live LXC 10027 deployment or ingress verification is claimed here.

## Automatic in-place release preparation — latest

The operator chose the existing VPS, Compose project, app service and MySQL volume for both production and testing, with automatic deployment after successful `main` CI and `STAGING_DEPLOY_ENABLED=true`. Temporary app/scheduler downtime and reduced test isolation are accepted. This decision supersedes earlier proposals that every release require a manual GitHub Environment approval; it does not authorize a deployment during this preparation. No GitHub variable or production configuration was changed, and live GitHub branch protection, queued workflows and effective variable values remain unverified.

The repository workflow still publishes a digest-pinned image only after successful push CI. CI now provisions disposable MySQL schemas and explicitly executes the migration 018 recovery and Learning upgrade tests that previously skipped. The deploy job checks that its commit is still the current `main` head after admission to the existing non-cancelling concurrency group and fails closed if GitHub cannot be checked. The branch can still advance between that check and app replacement; the check is not atomic with the remote host. Review any older queued runs before the first authorized release.

The deploy script preserves old backup files, validates each new gzip dump, saves the prior image/Compose and a mode-0600 environment snapshot, checks incoming and running Learning flags and preserves the existing scheduler setting, pulls the requested app digest, replaces only the app using `--no-deps`, and verifies image ID and readiness. `/health/ready` now fails when the scheduler is configured on but its timer is not enabled. This timer check does not prove a successful scheduler tick, provider operation, or absence of runtime errors. Review safe error logs and operational monitoring after deployment. On a failure before new app startup the script restores configuration without restarting the running app; after startup has been attempted it does not automatically run the older image against potentially changed schema. Diagnose migration/startup/health errors and prefer approved forward recovery; do not restore an old database snapshot over newer publishing history. The backup is created while the current app can still write: later writes are not in that snapshot, so do not assume restoring it preserves subsequent posts.

For the first Learning schema upgrade, while migration 019 is not recorded, the script blocks startup unless the operator has completed and attested an actual backup restore and approved a migration plan. In `/opt/botmerzz-staging/backups`, the future release requires files sharing `first-learning-upgrade-<40-character-commit>` and suffixes `.sql.gz`, `.plan`, and `.evidence`. The evidence contains exactly `image=<digest-pinned-image>`, `backup_sha256=<sha256-of-sql.gz>`, `plan_sha256=<sha256-of-plan>`, `restore_verified=yes`, and `plan_approved=yes`, one per line. The script verifies hashes, image reference and gzip integrity; the `yes` values are an operator attestation, not independent proof of a restore. Protect these files and the backed-up environment. A first automatic deploy attempt cannot pass this gate until the release image digest exists and those artifacts have been prepared; plan a separately authorized first release accordingly. No real backup or evidence was created in this task. Offsite storage is desirable where practical; never transfer production data without authorization.

The six Learning flags must all resolve to `false` for this deployment path: capture, activation, retrieval, prompt integration, shadow and retention. The checks intentionally continue to enforce this until a later authorized change to the release controls. The database-backed active-rule bit cannot override disabled retrieval/execution flags in the tested application. Current production uses an older image without these variables; the first new container's values can only be verified after a separately authorized deployment.

The scheduler retains its existing immediate first tick. Deployment itself does not insert a new scheduling request, but a due pending slot can be processed immediately after restart, and existing planning policy can skip missed slots or update pending state. Therefore ready/pending rows are preserved through container replacement but can transition normally once the scheduler resumes; zero provider-side duplicates cannot be guaranteed by mocks. Existing idempotency persistence, locking and unknown-outcome reconciliation mitigate retries. Inspect live slots before release, do not blindly retry an unknown result, and account for due publishing in the chosen window. A graceful stop waits for active dispatch up to the existing process deadline; forced interruption remains a recovery boundary.

Verification in this preparation: `npm test` **409 total / 389 passed / 0 failed / 20 MySQL-gated skipped**; the migration 018 and upgrade cases were separately run against disposable MySQL 8.4, **1/1 each with no skips**. `npm run test:integration` against a separate disposable MySQL 8.4 returned **76/76**, followed by configuration integration **1/1**; the temporary containers were removed. `node --test test/deploy-staging.test.js` ran **12/12** with mocked Docker, not a real deployment. Release-head tests ran **4/4** with mocked GitHub responses. `npm run check`, shell syntax checks, YAML parsing and `git diff --check` passed. The 018 interruption remains simulated rather than an actual crash.

**Current readiness:** local CI/CD changes pass isolated checks, but the actual GitHub workflow and host deployment have not been executed. Production deployment remains **NO-GO** pending an actual verified restore, an approved first-migration plan tied to a release image, current GitHub settings/queue and a safe release window. The scheduler can process due work at startup, so do not claim that the restart cannot coincide with a post. Learning activation is **NO-GO**. No push, image publication, production migration, container restart or deployment is authorized by this preparation.

## Migration 018 local remediation — latest

The migration runner now checks `information_schema.STATISTICS` before applying 018. A matching visible, non-unique ascending BTREE on `(status, completed_at, id)` without prefixes or expressions is accepted and migration history is recorded; an incompatible same-named index causes `MIGRATION_018_INDEX_MISMATCH` and requires manual inspection. No existing index is dropped. This supersedes the unresolved 018 code-defect assessment below; release migration readiness remains **NO-GO** until the release artifact and upgrade/rollback compatibility are verified using an authorized restored copy of the actual database.

Disposable MySQL 8.4 tests: `NODE_ENV=test ALLOW_DESTRUCTIVE_DB_TESTS=true DB_HOST=127.0.0.1 DB_PORT=33349 DB_USER=root DB_PASSWORD=local-only-test DB_NAME=merzz_test_018 node --test test/migration-018.mysql.integration.test.js test/migrations.test.js` — **8 passed, 0 failed, 0 skipped**. It covered fresh 018, upgrade from 017, a correctly pre-existing index with missing history, five incompatible definitions, repeated runs, migration history and preservation of an existing slot. The interruption was simulated by committing the index before recording migration history; no real process crash was injected. Before the fix, that simulated state reproduced `MIGRATION_FAILED`. Existing upgrade: same disposable endpoint/credentials with `DB_NAME=merzz_test_upgrade node --test test/learning-upgrade.mysql.integration.test.js` — **1 passed, 0 failed, 0 skipped**. The temporary container was removed. `node --test test/scheduler.test.js test/dispatcher.test.js test/config.test.js test/learning.test.js` — **88 passed, 0 failed, 0 skipped**. `npm test` — **395 total, 375 passed, 0 failed, 20 skipped** (database-gated skips include the new MySQL test, which passed separately above). `npm run check` and `git diff --check` passed. No production migration was run.

## Release remediation: live slot and operator handoff

Read-only VPS query at 2026-11-11 11:40:35 UTC found automation enabled and pending slot `14422a37-f6d3-4433-b009-266c537e9706`, scheduled 2026-11-11 12:37:06.136 UTC. Its automation session matches the current session; claim, publish start, completion, error, payload, idempotency key and provider post ID were absent. It was **not yet due** at that instant. There were 97 published, 16 canceled, 12 failed, 2 skipped and 1 pending slots; none were ready, generating, publishing or unknown. The published count increased from 96 during the preceding inspection. The prior overdue slot ID was not recorded, so its identity and outcome cannot be proven from that observation; do not infer that it is the current slot or that it was the additional published record. No provider request was made to check external publishing.

The checked-in scheduler claims a due pending slot only when automation/session, integration and other checks pass; in-flight and unknown operations fence additional work. A restart may tick immediately. Before any separately authorized replacement, inspect the current slot/session/provider status again and choose a window with no in-flight or unknown result. The operator may wait for the normal schedule to settle and inspect again, or explicitly authorize an operational pause and assess its effect: the existing pause workflow can cancel pending/generating/ready slots and alter session state. Neither option was executed here; preserve history and idempotency, and reconcile uncertain provider outcomes before retry. Current deployed code and release code must both be considered when deciding eligibility.

At 11:43:17 UTC a further read-only check still showed automation enabled, one pending slot and no due/ready/generating/publishing/unknown slots. This later snapshot remains time-sensitive and does not establish the identity or outcome of the previously overdue slot.

GitHub settings were not accessible through the available connector. A repository administrator can inspect, without changing settings, using `gh api repos/mamay-org/botmerzz/actions/variables/STAGING_DEPLOY_ENABLED`, `gh api repos/mamay-org/botmerzz/environments/staging/variables/STAGING_DEPLOY_ENABLED`, `gh api repos/mamay-org/botmerzz/environments/staging`, and `gh api repos/mamay-org/botmerzz/branches/main/protection`. A 404 or 403 does not prove a variable or protection is absent without checking access. Alternatively inspect Settings → Secrets and variables → Actions → Variables, Settings → Environments → staging, and Settings → Branches/Rules. Check repository and environment scopes and the actual expression context; require a protected manual release approval and verify its behavior before pushing. The checked-in workflow publishes on successful CI for a push to `main`; the staging job additionally requires `vars.STAGING_DEPLOY_ENABLED == 'true'` and has a non-cancelling concurrency group. An enabled deploy job can replace this production app and apply migrations.

Backup and restore remain blocked: obtain explicit approval for a consistent current-data dump and its isolated restore, name a recovery owner and retention period, select encryption/key management and a separately approved offsite destination, validate the encrypted artifact and dump integrity, then restore into a disposable MySQL 8.4 instance with all application/scheduler/provider access disabled. Compare migration history and counts for slots by status, idempotency records, admins and relevant Learning tables; check foreign keys and application compatibility without disclosing content. A valid archive alone is not restore proof. No live data was copied or transferred.

The existing deployment script demonstrates the intended consistent InnoDB dump mechanism: `mysqldump --single-transaction --routines --triggers` from the MySQL container, compressed with gzip. After approval, the database operator should verify disk capacity, use a restrictive umask and an encrypted destination, record the source schema/version and creation time, encrypt with an approved recipient/key stored separately from the dump, and verify gzip/decryption and a cryptographic checksum without printing contents. The backup owner must approve and perform the offsite transfer and document retention and key recovery. The restore operator must restore to a new isolated MySQL 8.4 database with no scheduler or providers, compare migration and critical-table counts against the time-consistent backup baseline, and document any differences and restore duration. Do not restore over the running database or overwrite later publishing history. Select a concrete encryption method, offsite destination, credential handling, retention period and responsible person before writing executable commands; none is verified or authorized here.

## Final release blocker recheck — 2026-11-11

At 11:36 UTC, read-only inspection confirmed the existing app and MySQL containers healthy, schema 010, scheduler `true`, persisted automation enabled, and **one pending slot already due**. There were no ready, generating, publishing or unknown slots at that instant. The database occupied approximately 0.88 MiB; `slots` was approximately 0.23 MiB with an estimated 127 rows; the root filesystem had 17 GiB free. The app database account reports `ALL PRIVILEGES` on its existing schema; this is evidence of granted privileges, not an executed migration. Repeat all slot, scheduler and resource checks immediately before a separately authorized release. A restart can immediately dispatch the due slot; do not restart until the operator establishes and authorizes a safe handling plan without resetting schedule or blindly replaying an unknown outcome.

### Pending migration assessment

| Migration | Reviewed operation and dependency | Release assessment |
| --- | --- | --- |
| 011 | Creates feedback, candidate, rule and review tables referencing existing slots/admins. | Additive; actual-data upgrade and foreign-key behavior not rehearsed. |
| 012 | Creates capture events referencing slots and 011 candidates. | Additive; actual-data rehearsal pending. |
| 013 | Creates validation observations referencing slots. | Additive; actual-data rehearsal pending. |
| 014 | Creates slot claims and durable attempts referencing slots. | Additive; isolated test simulated a partial 014 DDL commit, not a production restore. |
| 015 | Creates lifecycle/version tables and inserts version-1 snapshots for existing approved 011 rules. | Existing values are copied with `INSERT IGNORE`; foreign keys and compatibility must be checked on a restored actual copy. |
| 016 | Creates shadow evaluations and reviews with limits and admin references. | Additive; actual-data rehearsal pending. |
| 017 | Creates snapshots referencing 014 attempts and slots. | Additive; actual-data rehearsal pending. |
| 018 | Creates `slots_published_completed` on the existing `slots` table. | **Recovery blocker:** MySQL DDL can commit before the migration row is recorded. A crash in that interval leaves the index present and rerunning the plain `CREATE INDEX` can fail with duplicate index name. Previous upgrade test covered partial 014, not this failure. Add and verify safe reconciliation for an existing matching index before release; reject a mismatched definition. |
| 019 | Creates shadow admission limits referencing admins. | Additive; actual-data rehearsal pending. |

Migrations run on app startup under a database advisory lock with a 30-second acquisition timeout. DDL may commit independently; rollback of the app image does not roll schema back. Small observed tables and free disk do not establish lock duration or compatibility with the old image. Do not run the migrations on the VPS in this preflight.

### Release controls and evidence

- The running image is `ghcr.io/mamay-org/botmerzz@sha256:74b4bc3f4a631f439d430447169854a332794ddae8c89b216685d7f7361a716c`; no proposed release commit or digest exists for the dirty worktree. Preserve this digest and matching Compose/config snapshot as rollback inputs, subject to testing old-image compatibility against the migrated schema.
- Intended future release flags are explicitly `LEARNING_CAPTURE_ENABLED=false`, `LEARNING_ACTIVATION_ENABLED=false`, `LEARNING_RETRIEVAL_ENABLED=false`, `LEARNING_PROMPT_INTEGRATION_ENABLED=false`, `LEARNING_SHADOW_ENABLED=false`, and `LEARNING_RETENTION_ENABLED=false`. They are absent in the current old container; new-image effective values have not been observed. Verify them after any authorized replacement without printing credentials.
- The GitHub connector returned a protocol error and does not expose the required settings in this session. Effective `STAGING_DEPLOY_ENABLED`, environment/repository variable precedence, `staging` reviewers and branch protection remain unknown. The checked-in workflow publishes an image after successful CI on a `main` push and can deploy when that variable resolves to `true`. The owner must verify an explicit manual approval gate before a push; no GitHub settings were changed.
- Same-host mode-0600 compressed predeploy dumps exist; neither an encrypted offsite copy nor an actual-database restore has been verified. The earlier synthetic restore is not recovery evidence for this database. The operator must authorize creation and use of a consistent current-data backup, identify recovery ownership and retention, authorize any offsite transfer, validate integrity, and rehearse restoration in an isolated compatible MySQL instance. No production data copy was made in this task.
- Existing deploy script saves a same-host dump, prior image and Compose file, changes `APP_IMAGE`, then recreates only the existing app with `--no-deps`. It automatically attempts app rollback on failure but cannot undo committed DDL. It does not retain a full persistent `.env` snapshot after success. Review actual Compose drift, safely snapshot configuration, preserve the volume, and verify health/flags/slots after an explicitly authorized release. For schema incompatibility or partial migration, stop and follow an approved forward-recovery plan; do not overwrite newer publishing history with an old database snapshot without separate authorization. The runbook patterns below are not approved executable release commands.

**Decisions:** functional readiness GO on earlier isolated results; GitHub deployment safety **NO-GO/unverified**; backup/restore **NO-GO**; migration **NO-GO** including migration 018 recovery; scheduler safety **NO-GO** for an unplanned restart with a due slot; Learning isolation **NOT VERIFIED for release image**; production deployment **NO-GO**; deployment authorization **NOT GRANTED**. Exact approvals still needed: current-data backup and isolated restore, offsite destination/transfer, any GitHub settings change, scheduler maintenance action if needed, and a specific reviewed deployment. No production state, credentials, configuration, images or GitHub settings were changed; no provider request or Threads publish was made.

## Verified in-place VPS inspection — latest

The configured `botmerzz-vps` alias authenticated with strict host-key checking as `botmerzz-deploy`. Inspection was read-only. Host `host.botmerzz.my.id` runs Linux 6.8.0-31-generic x86_64, Docker 29.9.3 and Compose 5.7.0. The documented directory `/opt/botmerzz-staging` and Compose project `botmerzz-staging` exist. The only running Docker containers observed were healthy `botmerzz-staging-app-1` and `botmerzz-staging-db-1`. The app uses `ghcr.io/mamay-org/botmerzz@sha256:74b4bc3f4a631f439d430447169854a332794ddae8c89b216685d7f7361a716c`, bound to `127.0.0.1:3000`; MySQL uses `mysql:8.4`, with no published host port, and persists in `botmerzz-staging_mysql_data`. Root filesystem: 25 GiB total, 17 GiB free; RAM: 1.9 GiB total, 1.1 GiB available at inspection.

Caddy was active; its readable site configuration routes `botthreads.botmerzz.my.id` to `127.0.0.1:3000`. An external `curl` to `/health/live` returned HTTP 200 with certificate verification result 0. The running app reports `NODE_ENV=production`, `TRUST_PROXY=true`, and `SCHEDULER_ENABLED=true`. OpenRouter, Tebar and Telegram credential variables were present; their values were not displayed. The six Learning environment variables were **absent** from the running container, and `/app/src/learning.js` was absent in the current image. This establishes the current image lacks that Learning module at the inspected path; it does not establish the effective flags of a future image. Verify all six flags in the replacement container before any Learning use.

The live schema contains migrations 001 through **010**, so repository migrations **011–019** are pending for the proposed working-tree code. No migration was run. The `slots` table had an estimated 127 rows and 0.23 MiB including indexes; `slots_published_completed` from migration 018 was absent. Migration lock duration, privileges and backward compatibility remain unverified. At the query instant, persisted automation was enabled: 96 published, 16 canceled, 12 failed, 2 skipped and 1 pending slot; 0 ready, unknown, generating or publishing slots, and 0 due slots in the queried statuses. The 96 non-null slot idempotency keys were distinct. These are time-sensitive observations, not a guarantee for a later restart. An enabled scheduler can tick immediately on startup; repeat the inspection and reconcile unknown outcomes in the release window.

Same-host predeploy compressed dumps exist, but no encrypted offsite backup, retention policy or successful restore of an actual backup was verified. GitHub Actions environment/repository variable values, environment reviewers and branch protections remain inaccessible from the available tools. A successful CI run from a `main` push can trigger the staging-named deployment job when `STAGING_DEPLOY_ENABLED` is true; this is the in-place production target. Confirm its gate before any push. No image was pushed, container restarted, configuration changed, provider called, migration run or post published during inspection.

**Decisions:** application functional readiness GO on prior isolated evidence; live VPS inventory substantially verified; GitHub release safety, migration readiness, backup/restore and production deployment **NO-GO** pending the evidence above; Learning activation **NO-GO**; deployment authorization **NOT GRANTED**. The previous failed-authentication notes below are historical and superseded by this successful inspection. Existing read-only inventory and proposed rollback patterns remain conditional on a separately approved release and current state.

## VPS access recovery recheck

Read-only local SSH configuration inspection resolves the documented target to user `botmerzz-deploy` and host `178.83.188.163`, with standard identity-file paths and `IdentitiesOnly no`. The current SSH agent reports **no identities**; this differs from the earlier attempt and does not establish why that attempt was rejected. The configured username, server-side authorized keys, available server authentication methods, and the operator's ability to log in remain unverified. No private keys or passwords were requested. Strict host-key checking remains required; the prior authentication failure does not establish host availability.

The repository workflow publishes an image after successful CI for a push to `main`; its staging-named deploy job additionally requires `STAGING_DEPLOY_ENABLED == 'true'`, uses the `staging` environment and a non-cancelling concurrency group. With the confirmed in-place target this can replace the production app and run startup migrations. Repository/environment variable precedence, effective value, reviewers and branch protections cannot be established from the checkout or available GitHub tools. Treat automatic deployment as a release blocker until the repository owner verifies those settings and an explicit manual release gate. No workflow or variable was changed.

**Current decisions:** functional readiness GO based on prior isolated evidence; VPS inspection, GitHub release safety, live migration readiness, backup/restore readiness and production deployment **NO-GO** pending verification; Learning activation **NO-GO**; deployment authorization **NOT GRANTED**. Runtime flags, current image, schema, slot and scheduler states remain unknown. The inventory and rollback command patterns below are not executable release instructions until the live target and release digest are verified. The owner should use an existing authorized SSH session to run the read-only inventory below and return sanitized output, verify the GitHub gate, and provide evidence of an encrypted offsite backup and isolated restore. Do not send private keys or passwords.

## In-place staging-to-production promotion update — 2026-11-11

The operator has confirmed the target architecture: promote the **existing staging VPS, application service and MySQL database in place**. Do not create a second Compose project, app service, database, volume or scheduler; keep the current project/service identifiers and all persisted operational state.

The authorized read-only host check could not authenticate. The documented host-key entry for `178.83.188.163` was present and strict verification succeeded, but `ssh -T -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=yes -o ClearAllForwardings=yes botmerzz-deploy@178.83.188.163 'hostnamectl --static; id -un'` returned `Permission denied (publickey,password)`. No remote command ran and no server state changed. The previous **NO-GO for actual production deployment remains** until the existing host and live state are verified with an authorized identity.

## Production deployment preflight — 2026-11-11

This is the latest preflight result and supersedes the general deployment classification below for an actual production target. The task allowed inspection and isolated preparation only; no production host, configuration, database, DNS, image registry, or workflow was changed.

| Decision | Result | Evidence boundary |
| --- | --- | --- |
| A. Application functional readiness | **GO** for the verified critical workflows. | Unit, integration, targeted publishing/learning tests, isolated MySQL upgrade, local runtime build, and synthetic restore evidence below. |
| B. Actual production deployment readiness | **NO-GO** for this preflight. | The in-place target is decided, but no live-verified hostname/domain, deployment path/project/Compose state, effective environment, schema version, proxy, or backup/restore evidence was available. Repository/staging documentation is not live-target evidence. |
| C. Learning activation | **NO-GO**. | Keep all six server-side Learning flags false. Do not call OpenRouter for evaluation or enable shadow/prompt integration. |
| D. Deployment authorization | **NOT GRANTED**. | No push, image publication, production migration, or deployment was performed. |

### Target and access actually verified

- The local repository is `mamay-org/botmerzz`, branch `tama`, with uncommitted implementation and documentation changes. The worktree includes an existing change to `docs/featv1.md`; it was preserved. There is no release commit or production image digest to deploy.
- The repository configures **staging only**, while the operator has decided that this existing deployment becomes production in place. The expected directory and Compose project in repository instructions are `/opt/botmerzz-staging` and `botmerzz-staging`; `docs/DEPLOYMENT.md` includes `178.83.188.163` in SSH host-key setup. They are documented target identifiers, not live verified host details. A prior operator report names Ubuntu Server 24.04.5, amd64, Docker Engine 29.9.3 and Compose 5.7.0 for staging but explicitly says SSH inspection was not performed.
- No actual hostname/domain, Caddy configuration, mounted MySQL volume name, current app digest, production schema version, or Proxmox/LXC layer was verifiable from this workstation. The operator's in-place decision means these belong to the existing deployment; it does not establish their current values. The VPS template requires an HTTPS `BASE_URL` but does not specify the deployed value.
- The available Docker endpoint is local Docker Desktop. Its running app container is `merzz-local-app-1` (`NODE_ENV=development`, image `kedai-merzz-threads:local`, app bound to `127.0.0.1:3000`), not a production container. Its scheduler and all six Learning flags were effectively false. The local `.env` has OpenRouter, Tebar, and Telegram credential variables populated; values were not printed, changed, or used. These are local-development findings, not production credential evidence.
- There is no SSH alias in the local SSH config and no GitHub CLI. The live GitHub `staging` environment secrets/reviewer rules, repository Actions variable, branch protection, production environment approvals, and actual target host key were not inspected. The staging Compose check without an `APP_IMAGE` correctly refused to resolve; a separate config-only check with synthetic placeholders passed. No secret or production `.env` value was read.

### In-place promotion design

Keep the existing Compose project name `botmerzz-staging`, app and db services, volume, network, public route, provider/account settings, `settings.automation_enabled`, schedule, slots, and ids. The Compose template already sets `NODE_ENV=production`; do not relabel or change `BASE_URL`, proxy trust, scheduler, credentials, account, or environment values merely to remove the word “staging.” Change only the app image digest through the existing deployment script unless verified target evidence proves another change is necessary and the operator separately approves it.

The checked-in deploy script backs up the current database, prior Compose file and previous `APP_IMAGE`, pulls only `app`, and recreates only the existing app service with `--no-deps`; it does not intentionally recreate MySQL or add an app/scheduler. It replaces the server's Compose file with the repository copy, so compare the actual host file against the reviewed release file first and resolve any drift before running the script. In particular, compare the **effective running container environment** with `.env` and the incoming Compose interpolation for `SCHEDULER_ENABLED` and all Learning flags; a setting present only in the current container/Compose can change on recreation. It does not retain a complete `.env` snapshot after a successful deployment, so the deployment owner must arrange a secure configuration snapshot under the approved secret-handling policy. The script's same-VPS unencrypted DB dump is only a deployment recovery aid, not the required offsite backup.

GitHub Actions still calls this path “staging”: a successful CI run for a push to `main` publishes a digest; if `STAGING_DEPLOY_ENABLED` is `true`, the job uses the GitHub `staging` environment and deploys to `/opt/botmerzz-staging`. Since this service will be production, that gate becomes a production release path. Its current live variable and environment reviewers are unknown. Verify the setting and approval protection before any future push; do not rely on the environment name alone. There is no separate production job and no such setting was changed here.

### Read-only inventory commands for the authorized VPS operator

Run these only after the operator supplies a valid read-only/inspection identity and verifies the host key out-of-band. They reveal state but do not print environment values or mutate services:

```sh
cd /opt/botmerzz-staging
hostnamectl --static
cat /etc/os-release
uname -m
docker version --format '{{.Server.Version}}'
docker compose version
docker compose --env-file .env -p botmerzz-staging -f compose.vps.yaml ps
docker compose --env-file .env -p botmerzz-staging -f compose.vps.yaml config --quiet
docker inspect --format '{{.Name}} image={{.Config.Image}} imageID={{.Image}} restart={{.HostConfig.RestartPolicy.Name}} memory={{.HostConfig.Memory}} cpus={{.HostConfig.NanoCpus}} ports={{json .NetworkSettings.Ports}} mounts={{json .Mounts}}' "$(docker compose --env-file .env -p botmerzz-staging -f compose.vps.yaml ps -q app)" "$(docker compose --env-file .env -p botmerzz-staging -f compose.vps.yaml ps -q db)"
df -h /
free -h
```

Then report only sanitized values. Effective app configuration and stored operational state can be checked without revealing credentials or captions:

```sh
docker compose --env-file .env -p botmerzz-staging -f compose.vps.yaml exec -T app node -e 'const c=require("./src/config").loadEnv();console.log(JSON.stringify({environment:c.nodeEnv,baseHost:new URL(c.baseUrl).host,trustProxy:c.trustProxy,schedulerEnabled:c.schedulerEnabled,learning:{capture:c.learningCaptureEnabled,activation:c.learningActivationEnabled,retrieval:c.learningRetrievalEnabled,promptIntegration:c.learningPromptIntegrationEnabled,shadow:c.learningShadowEnabled,retention:c.learningRetentionEnabled},providers:{openRouterKeySet:!!c.openRouter.apiKey,tebarKeySet:!!c.tebar.apiKey,telegramTokenSet:!!c.telegram.botToken},openRouterModel:c.openRouter.model}))'
docker compose --env-file .env -p botmerzz-staging -f compose.vps.yaml exec -T db sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot "$MYSQL_DATABASE" -Nse "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1; SELECT automation_enabled FROM settings WHERE id=1; SELECT status,COUNT(*) FROM slots GROUP BY status ORDER BY status; SELECT COUNT(*) FROM slots WHERE status IN (\"pending\",\"generating\",\"ready\",\"publishing\",\"unknown\") AND scheduled_at<=UTC_TIMESTAMP(3); SELECT COUNT(*) FROM generation_attempts WHERE state IN (\"reserved\",\"generating\",\"validating\")"'
docker compose --env-file .env -p botmerzz-staging -f compose.vps.yaml exec -T db sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot "$MYSQL_DATABASE" -Nse "SELECT table_name,ROUND((data_length+index_length)/1024/1024,1) FROM information_schema.tables WHERE table_schema=DATABASE() ORDER BY data_length+index_length DESC LIMIT 20; SHOW INDEX FROM slots WHERE Key_name=\"slots_published_completed\""'
```

These queries identify migration version, automation state, slot counts, in-flight attempts, table/index sizes and effective flags only. Check specific `ready`, `publishing` and `unknown` slot IDs/statuses in the authorized dashboard and reconcile unknown outcomes before restart; never include captions, credentials, session tokens, provider payloads or account identifiers in the report. Also verify that exactly one BotMerzz app/scheduler process exists and identify any Caddy container/service and its configured site/upstream without dumping the full proxy configuration.

### Configuration, flags and network boundary

The VPS Compose template requires `APP_IMAGE`, `BASE_URL`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, and `DB_ROOT_PASSWORD`; it sets `NODE_ENV=production`, uses the internal service name `db`, and defaults `TRUST_PROXY=false` and `SCHEDULER_ENABLED=false`. The configuration validator requires HTTPS for a production `BASE_URL`. Provider credentials are optional in the template. The actual production values, credential presence, database grant, and session configuration are unavailable, so they cannot be attested here. The app uses database-backed random session tokens stored as hashes; there is no `SESSION_SECRET` variable in the template. Production cookies are Secure, HttpOnly and SameSite=Strict in application code.

The app JSON body limit is 256 KiB. Admin mutations use same-origin and CSRF checks; there is no permissive CORS middleware. Application login/integration/webhook throttles are process-local, so ingress limits and correct client-IP forwarding must be verified at the real proxy. `TRUST_PROXY=true` makes Express trust one hop; the repository's Caddy description is not evidence that the deployed hop count/header normalization matches. Public DNS, TLS certificate, forwarded headers, firewall rules and administrative route exposure were not tested. The checked-in VPS Compose keeps MySQL on an internal network with no host port and binds the app to loopback; the host firewall and any actual production topology remain unknown.

Compose and config defaults set each of `LEARNING_CAPTURE_ENABLED`, `LEARNING_ACTIVATION_ENABLED`, `LEARNING_RETRIEVAL_ENABLED`, `LEARNING_PROMPT_INTEGRATION_ENABLED`, `LEARNING_SHADOW_ENABLED`, and `LEARNING_RETENTION_ENABLED` to false. Missing values resolve false in `loadEnv`; only explicit `true` enables them. The local development container reported all six false. Unit coverage verifies a persisted active rule cannot bypass disabled activation/retrieval flags. **Production's effective values were not inspected**, so the release operator must check them before and after deployment without printing credentials. Shadow remains separately unsafe for paid use until provider/model authorization and external hard spend ceilings are in place.

The template gives the app `512 MiB` and `1 CPU`, restart policy `unless-stopped`, a readiness health check, read-only root filesystem, no-new-privileges and dropped capabilities. MySQL has a persistent named `mysql_data` volume, health check and restart policy, but no Compose CPU/memory cap. Compose has no log rotation policy. The local app had the expected 512 MiB/1 CPU and loopback port; this says nothing about the target host's capacity or Docker daemon log policy.

### Database and recovery evidence

- Migrations present through **019**. Migrations 011–019 are additive in the reviewed SQL; the Learning records use foreign keys/indexes and retain review/source history. Migration 018 adds an index to `slots`, so lock duration and index-build cost depend on production table size and were not measured.
- `runMigrations` uses a database-scoped MySQL advisory lock with a 30-second wait and records a migration after statements succeed. MySQL DDL can commit independently; migration failure is not a transactional schema rollback. The application runs migrations before serving. Production's current `schema_migrations` value and runtime migration privileges are unknown.
- Isolated upgrade test: `NODE_ENV=test ALLOW_DESTRUCTIVE_DB_TESTS=true DB_HOST=127.0.0.1 DB_PORT=33346 DB_USER=root DB_PASSWORD=<disposable-only> DB_NAME=merzz_test_upgrade node --test test/learning-upgrade.mysql.integration.test.js` — **1 passed, 0 failed, 0 skipped**. It upgraded a fresh disposable MySQL 8.4 schema from 011 through 019, simulated partially committed DDL for migration 014, and retained a legacy event with evidence correctly unavailable. The temporary database container was stopped/removed. This is not the production schema or data volume.
- Isolated backup test: created one synthetic row in a disposable MySQL container, streamed `mysqldump --single-transaction` in memory, restored it to a separate empty database, and compared the marker — **PASS**. No production data or dump file was used. This verifies the basic dump/restore mechanics only; it does not verify encryption, offsite retention, production consistency, operator access, or disaster recovery.
- The checked-in staging deploy script makes a compressed, mode-0600 pre-deploy dump on the same VPS and prunes it after 30 days during deployments. It is not encrypted or offsite, and no separate backup retention job is documented. No successful restore of an actual staging/production backup was evidenced. **Production backup/restore remains a release blocker.** Identify the recovery owner and complete an encrypted offsite backup plus an isolated restore rehearsal before deployment.

### Image and CI/CD findings

- `docker buildx build --target runtime --output type=cacheonly .` passed for the current worktree. It did not produce, tag, push, or deploy an image. The runtime stage uses `npm ci --omit=dev`, the lockfile, and non-root `node`. `node:22-bookworm-slim` is a mutable build input, but the publishing workflow records a digest for the resulting app artifact. The Compose VPS file still references mutable `mysql:8.4`; app-only deployment instructions and script pull only `app`. Database image upgrades need their own pinned/controlled backup-and-restore procedure.
- `ci.yml` runs on pull requests and pushes to `main`, with `npm audit --audit-level=high`, syntax checks, unit/integration tests, deployment-script syntax, and a runtime Docker build. `publish.yml` publishes only after successful CI for a `main` push, records commit SHA/digest, and has a staging deploy job only. That job is gated by `STAGING_DEPLOY_ENABLED == 'true'`, uses hosted `ubuntu-latest`, the `staging` GitHub Environment, package-read scope, pinned SSH host keys and a non-cancelling staging concurrency group. There is **no production deploy job or production approval environment** in the repository. Actual GitHub environment protection and secret configuration remain unverified. The browser E2E suite is not part of CI.
- `npm audit --audit-level=high` passed locally: **0 vulnerabilities**. The worktree is dirty and not a release artifact. No image was pushed and no workflow was run.

### Verification commands and results

| Command / method | Result |
| --- | --- |
| `npm test` (latest full run recorded before this preflight; no application source changed during this task) | **394 total / 375 passed / 0 failed / 19 DB-gated skipped**. Skips are not passes. |
| `npm run test:integration` | **75 passed** plus `node --test test/configuration.mysql.js`: **1 passed** on isolated MySQL. |
| Nine serial Learning MySQL integration files recorded in the preceding acceptance report | **25 passed / 0 failed / 0 skipped**. |
| `npm run test:learning:browser` (latest recorded local Chrome run) | **7 passed / 0 failed / 0 skipped**. No live provider or publisher. |
| `node --test test/learning.test.js test/content-service.test.js test/config.test.js test/dispatcher.test.js test/scheduler.test.js` | **118 passed / 0 failed / 0 skipped** in this preflight; includes default-off and active-record bypass checks plus publishing/scheduler invariants. |
| `NODE_ENV=test ALLOW_DESTRUCTIVE_DB_TESTS=true DB_HOST=127.0.0.1 DB_PORT=33346 DB_USER=root DB_PASSWORD=preflight-only-not-a-secret DB_NAME=merzz_test_upgrade node --test test/learning-upgrade.mysql.integration.test.js` | **1 passed / 0 failed / 0 skipped** on disposable MySQL 8.4; temporary container removed. |
| Synthetic disposable database dump/restore using `mysqldump --single-transaction` and a second empty schema | **PASS** for the synthetic marker. No production data, encrypted/offsite backup, or production restore was tested. |
| `docker buildx build --target runtime --output type=cacheonly .` | **Passed**; runtime image built into local BuildKit cache only. No tag, push, or deploy. |
| `npm audit --audit-level=high` | **Passed; 0 vulnerabilities** at audit time. |
| `docker compose` VPS `config --quiet` with synthetic placeholder env values; `bash -n scripts/deploy-staging.sh scripts/retry-command.sh`; `npm run check`; `git diff --check` | **Passed**. The no-placeholder Compose check failed as expected because `APP_IMAGE` is required. |

### Scheduler, publishing and smoke checks

Do not change scheduler or persisted automation state during this preflight. If the deployed scheduler is enabled, app startup performs an immediate tick; with automation enabled and a due slot, deployment can legitimately publish it. Confirm the real schedule, due/ready slots, persisted automation state and Tebar reconciliation status, then choose a release window. Do not add a live publish to the smoke test. Unknown publishing outcomes must be reconciled before retry; ready payloads and idempotency keys must remain unchanged.

After a separately authorized app-only deployment, verify `/health/live`, `/health/ready`, Learning capabilities all false, migration version, provider model identity without displaying keys, logs for safe error codes, container health/resources, and unchanged ready slots/schedule/publisher status. Health, schema, flag and resource checks are read-only. Administrator login is a bounded **state-changing** smoke check: use an approved existing administrator, log out after the check, and account for the session and login-attempt records it creates. Do not create a real post or call Tebar/OpenRouter to test deployment; do not generate production content or start shadow evaluation.

The only supported deployment workflow in this repository is the staging GitHub Actions path, which calls `scripts/deploy-staging.sh` with a commit SHA and GHCR digest. Proposed **staging-only post-deploy checks** (not executed here) are:

```sh
cd /opt/botmerzz-staging
docker compose --env-file .env -p botmerzz-staging -f compose.vps.yaml config --quiet
docker compose --env-file .env -p botmerzz-staging -f compose.vps.yaml ps
docker compose --env-file .env -p botmerzz-staging -f compose.vps.yaml exec -T app node -e 'const c=require("./src/config").loadEnv();const f={capture:c.learningCaptureEnabled,activation:c.learningActivationEnabled,retrieval:c.learningRetrievalEnabled,promptIntegration:c.learningPromptIntegrationEnabled,shadow:c.learningShadowEnabled,retention:c.learningRetentionEnabled};console.log(JSON.stringify(f));if(Object.values(f).some(Boolean))process.exit(1)'
curl --fail --silent --show-error 'https://<verified-staging-origin>/health/live'
curl --fail --silent --show-error 'https://<verified-staging-origin>/health/ready'
```

The repository documents the expected in-place directory/project and image-promotion workflow, but none were verified on the live host. There is no release commit/digest or live-verified target URL, host configuration, or authenticated access from which to produce a safe executable command. Do not treat a placeholder as executable. The command form below describes the existing workflow only; this preflight does not run `git push`, alter `APP_IMAGE`, trigger Actions, or execute Compose `up`.

For this explicitly confirmed **in-place** architecture, the existing staged script is the only repository-supported image-promotion operation. After a reviewed commit has passed CI, its exact remote invocation shape is below. Every angle-bracketed value is supplied by the GitHub workflow at runtime; the line is explanatory and was **not executed**:

```sh
DOCKER_CONFIG=/opt/botmerzz-staging/.ghcr-auth-<run-id> \
  /bin/bash /opt/botmerzz-staging/deploy-staging.sh.next.<run-id> \
  <40-character-commit-sha> \
  ghcr.io/mamay-org/botmerzz@sha256:<64-character-image-digest> \
  /opt/botmerzz-staging/compose.vps.yaml.next.<run-id> \
  /opt/botmerzz-staging/retry-command.sh.next.<run-id>
```

This script path preserves the existing Compose project and database volume, makes its same-host predeploy dump, pulls only the app digest, and starts only the app service. It applies pending migrations automatically during startup. Do not replace it with an unbacked `docker compose up`, run a second app/scheduler, or use `down -v`. Before it is authorized, verify the server Compose diff, live config/flag values, current schema, backup/restore and scheduler/slot state. Because the GitHub workflow's deploy condition is `STAGING_DEPLOY_ENABLED == 'true'`, an enabled staging job is now an in-place production deployment after promotion; confirm its GitHub Environment approval policy before any future push.

### Rollback procedure and commands

The staging deployment script saves the previous digest, matching Compose file, and compressed database dump before replacing the app. On a failed deployment its trap restores the prior app configuration and attempts to restart the prior app. This does **not** reverse MySQL DDL. If the old app is incompatible with the resulting schema, stop app writers and follow an approved restore/forward-recovery plan; do not assume image rollback equals database rollback.

For a future **staging** image-only rollback, after selecting the matching recorded prefix, the documented command pattern is:

```sh
set -euo pipefail
cd /opt/botmerzz-staging
backup_prefix='backups/predeploy-<commit-sha>-<utc-timestamp>'
test -s "$backup_prefix.image" && test -s "$backup_prefix.compose.vps.yaml"
previous_image="$(sed -n 's/^APP_IMAGE=//p' "$backup_prefix.image")"
[[ "$previous_image" =~ ^ghcr\.io/mamay-org/botmerzz@sha256:[a-f0-9]{64}$ ]]
env_tmp="$(mktemp .env.rollback.XXXXXX)"
compose_tmp="$(mktemp compose.vps.yaml.rollback.XXXXXX)"
trap 'test -z "${env_tmp:-}" || rm -- "$env_tmp"; test -z "${compose_tmp:-}" || rm -- "$compose_tmp"' EXIT
awk -v image="$previous_image" 'BEGIN{n=0} /^APP_IMAGE=/ {if(n++) exit 2; print "APP_IMAGE=" image; next} {print} END{if(n!=1) exit 3}' .env > "$env_tmp"
cp -p "$backup_prefix.compose.vps.yaml" "$compose_tmp"
chmod 600 "$env_tmp"
docker compose --env-file "$env_tmp" -p botmerzz-staging -f "$compose_tmp" config --quiet
docker compose --env-file "$env_tmp" -p botmerzz-staging -f "$compose_tmp" pull app
mv "$compose_tmp" compose.vps.yaml
compose_tmp=''
mv "$env_tmp" .env
env_tmp=''
docker compose --env-file .env -p botmerzz-staging -f compose.vps.yaml up -d --no-deps --wait --wait-timeout 240 app
curl --fail --silent --show-error 'https://<verified-staging-origin>/health/ready'
```

These commands use the repository's staging-named identifiers and are only a rollback pattern; under the confirmed in-place decision they would affect the production app if those identifiers match the live host. Do not execute them until the host, project, backup prefix and image compatibility are verified and a rollback is explicitly authorized. Before any app rollback or restart, confirm no generation/publish is in flight, reconcile every `unknown` outcome, inspect due/ready slots, and choose a scheduler-safe window: app startup may immediately tick and publish a due slot when persisted automation is enabled. A production database restore command cannot be safely finalized without the verified database/backup/restore target and change authorization. Never use `docker compose down -v` for rollback. Prefer a reviewed forward migration when safe; do not restore an older database snapshot over newer publishing history without explicit authorization.

### Blockers and required owner actions

| Blocker | Severity | Owner / condition to close |
| --- | --- | --- |
| Live hostname/domain, platform layers, actual project/path/Compose state and running services have not been verified; repository docs contain only expected staging identifiers. | **Critical for deployment** | Release owner supplies an authorized read-only access path; verify the existing host, proxy, firewall, volumes and app/DB services match the in-place target decision. |
| Production environment, effective Learning flags, provider credentials/model, DB grants and schema version are unknown. | **Critical for deployment** | Production operator verifies values in-place without printing secrets; confirm all six Learning flags false and scheduler/persisted automation status without changing it. |
| Encrypted offsite backup, retention/expiry, responsible owner and successful restore rehearsal are not evidenced. | **Critical for deployment** | SRE/DBA establishes backup destination and retention, restores into an isolated compatible database, records verification and recovery owner. |
| Public HTTPS, DNS/TLS, reverse proxy headers/hop count, client-IP spoofing resistance and admin exposure are not verified. | **Critical for deployment** | Network operator supplies actual topology and verifies HTTPS, forwarded-header normalization, trusted hop, firewall and admin access controls. |
| Production migration baseline/privileges, `slots` row count and migration 018 index-build/lock impact are unknown. | **Critical for migration** | DBA inspects target schema/data size and grant, plans a window and backup, then records the exact expected migration list; do not migrate in this task. |
| MySQL resource limits, disk headroom, Docker log rotation and production monitoring are unknown. | **Important; resolve before sustained production use** | SRE sets and verifies host-level CPU/memory/disk/log limits and alert ownership. Compose only caps the app. |
| GitHub's staging-named workflow is now the in-place production path; live `STAGING_DEPLOY_ENABLED`, secrets, reviewer protection and branch rules are not inspected. | **Critical for any push-triggered release** | Repository owner verifies the variable is not unexpectedly enabled and confirms required Environment approvals/branch rules before any future push. A successful `main` push can publish an image and, when the variable is true, replace the production app and run migrations. Do not change the variable or protection in this task. |
| Scheduler startup may immediately dispatch a due slot if enabled. | **Critical publishing safety** | Release owner checks schedule, automation and unknown slots; select a safe window without changing ready payloads or idempotency keys. |
| Manual accessibility (23 rows) and real-model evaluation remain unexecuted. | **Important deferred** | Accessibility owner completes checks before broad admin rollout; provider evaluation requires separate authorization. These are not reported as PASS and do not change the deployment blockers above. |

**Preflight conclusion:** application functional readiness **GO**; actual production deployment readiness **NO-GO** until the critical target, backup, proxy, migration and publishing conditions above are verified; Learning activation **NO-GO**; deployment authorization **NOT GRANTED**. No production migration, credential/configuration change, image push, Threads publish or deployment occurred.

## Earlier risk-based disposition — 2026-11-11 (superseded by the in-place preflight above)

- **Core implementation:** COMPLETE.
- **Functional acceptance:** GO for the automated, mocked, isolated MySQL, and browser-tested critical workflows. Manual accessibility and live-model behavior remain unexecuted, explicitly deferred, and are not reported as passed.
- **Production deployment readiness at that review:** CONDITIONAL GO for app-code deployment with every Learning execution flag off, after environment-specific prerequisites. This was a conditional preparation status, not an authorization. It is superseded by the top-of-report in-place preflight: actual deployment readiness is now **NO-GO** until target inspection and critical evidence are complete.
- **Learning activation readiness:** NO-GO. Keep capture, activation, retrieval, prompt integration, shadow, and retention disabled until their separately authorized rollout stages pass.
- **Administrator policy:** the user confirmed workspace-wide access for all active authorized administrators. Arbitrary-name/address detection remains limited; the minimization warning and bounded inputs remain required.

At the time, this disposition superseded older blanket statements that made manual accessibility evidence or paid real-model evaluation prerequisites for application-code deployment. It did not change those checks to PASS. The later target-specific in-place preflight at the top supersedes its deployment readiness classification. Real provider evaluation remains a controlled rollout follow-up before real-provider shadow or learning prompt integration, and requires separate authorization and provider-side budget controls.

- **Previous strict P1 acceptance record: NO-GO** under the earlier all-checks gate; see the explicit risk-based reclassification above.
- **Production learning activation: NO-GO**
- **Production deployment: not performed**
- **Live Threads publishing: not performed**

This document is a future rollout design. No stage was enabled or deployed. Each stage requires a separate review and explicit authorization; passing a gate never advances the system automatically.

## Current controls and limits

All execution-affecting Learning flags remain server-side and default to `false`: capture, activation, retrieval, prompt integration, shadow evaluation, and retention. A stored active rule cannot bypass disabled execution flags.

Rule activation has an explicit maximum of 500 active versions. The count and candidate rows used for conflict evaluation come from one query snapshot. A new activation at the cap is rejected transactionally; if legacy/out-of-band state is above the cap, retrieval returns no lessons with an explicit incomplete reason until an administrator deactivates rules. This bound prevents silent omission from conflict checks and scoped retrieval; no schema migration was needed.

Shadow admission now uses a MySQL named lock scoped to the current database and a persisted per-admin limit of three start requests per 15 minutes. One evaluation can run per database at a time across application processes. The lock is held on a dedicated optional-pool connection; the shadow pool is capped at two connections and is separate from publishing. If the lock connection is lost, the provider abort signal fires. A recent `running` evaluation row then blocks new work until the 300-second recovery threshold marks it `SHADOW_WORKER_INTERRUPTED`. The system never retries publishing from shadow recovery.

Per evaluation limits are five rules, three sample pairs, 12 provider calls, 30,000 estimated tokens, 180 seconds total, and 15 seconds per provider call. Token estimates are not an actual dollar-cost limit. Any future real-provider run needs an explicitly approved provider/account spend cap and a recorded per-run and daily budget. No real provider shadow evaluation was performed.

The checked-in VPS configuration runs one app service, but the database-backed shadow admission controls now also cover multiple app processes sharing the same MySQL database. A second, separate database is an independent budget and deployment boundary. Shadow remains disabled unless an operator explicitly enables it.

## Proposed staged rollout and exit gates

The thresholds below are proposed future gates, not measured results or current production promises. Record the comparison baseline, release identifier, approver, and evidence before starting each stage.

| Stage | Scope and required controls | Measurable exit gate | Stop or rollback condition |
| --- | --- | --- | --- |
| **A — Inactive deployment verification** | All Learning execution flags off. Apply migrations to a restored non-production copy first. Verify migration 019, application health, authentication, backup/restore procedure, and current scheduler/publisher behavior. | Capabilities API reports all execution flags false; migration and restore checks pass 100%; 24-hour observation has zero Learning prompt injections, shadow calls, Learning-induced slot mutations, duplicate generation attempts, or publishing idempotency changes. | Any flag unexpectedly on, migration/restore failure, new publishing side effect, or unknown authoritative attempt outcome. Return to the last verified app/schema pair and keep flags off. |
| **B — Capture-only observation** | Enable only optional learning capture in an isolated environment after approval. Activation, retrieval, prompt integration, shadow, and retention remain off. Compare capture events with the known eligible attempt population. | At least 7 days and 500 eligible attempts; ≥99% expected capture coverage; zero missing authoritative terminal outcomes in the measured cohort; capture errors <0.1%; generation p95 latency increase ≤5% against the recorded baseline; DB pool use below 70%; zero duplicate attempts or publishes. | Any lost authoritative outcome, unsafe evidence persisted, capture error ≥0.1%, p95 regression >5%, DB saturation, or publishing regression. Turn capture off; retain authoritative attempt records and audit history. |
| **C — Isolated shadow evaluation** | Enable shadow only in an isolated database. Use mock providers first. Real-provider calls require separate explicit authorization, an allowlisted model, and numeric provider-level per-run and daily spend caps. No publishing, slots, schedules, or Tebar calls. | At least 30 paired evaluations across approved scenarios; every run remains within 5-rule/3-pair/12-call/30k-estimated-token/180-second bounds; cross-process lock and restart tests pass; 100% run statuses are terminal or explicitly within recovery window; zero publisher/scheduler/slot calls; no new factual or validation regression in reviewed pairs; actual provider spend, if authorized, stays below the recorded numeric caps. | Any provider spend-cap breach, new factual or validation failure attributable to a lesson, unknown lock/recovery state, limit breach, or any publishing-path call. Disable shadow; allow cancellation/recovery to settle; do not replay uncertain calls. |
| **D — Limited learning integration** | Explicit admin activates one reviewed rule for one narrow product-category/topic scope. Enable activation, retrieval, and prompt integration only in the isolated cohort. Keep deterministic validation and Semantic Auditor unchanged. Before any production cohort, add and test a server-side exposure cap; the current app does not enforce a daily or percentage rollout cap. | At least 30 first-attempt observations per baseline/treatment arm for the exact rule version; at least 10 human ratings per arm for each reported quality comparison; zero new fact/safety violations; 100% snapshots identify the applied rule versions; incomplete or missing outcomes stay disclosed; kill-switch test passes with an in-flight and a subsequent generation. | Any factual/safety regression, missing attribution, validator weakening, unexplained outcome gap, exposure-cap breach, or publishing regression. Disable prompt integration and retrieval for new generations, preserve prior snapshots and ready slots, and review all affected attempts. |
| **E — Expanded activation** | Add scopes/rules incrementally only after the previous cohort is reviewed. Each activation is a new explicit human action; shadow performance never activates a lesson. Keep independent compliance, quality, and effectiveness indicators. | Each new scope passes the same Stage D sample and safety gates; two consecutive review windows meet thresholds; 100% of reported metrics disclose denominators, missing outcomes, and sample sizes; an independent security/browser review has no unresolved critical finding. | Any gate failure or an unexplained deterioration. Deactivate the affected version and return to the last reviewed scope; never delete history or rewrite historical snapshots. |

The current application does not enforce Stage B/C/D observation windows, daily spending limits, or a percentage exposure cohort. Those are preconditions for future rollout work, not guarantees supplied by the present implementation. Do not infer or report a causal improvement from shadow comparisons or uncontrolled before/after observations.

## Kill switch and rollback

The five execution flags are read into server configuration at process startup. Applying a changed environment value requires the normal controlled process restart; a database rule marked active cannot override a false server flag. After restart, new generations use the new flags. A generation already holding an immutable retrieval/snapshot context may finish with that snapshot if the process is not stopped; a graceful process shutdown aborts shadow provider work and follows normal generation-attempt recovery. Disabling Learning never rewrites a prior snapshot, ready payload, schedule, publishing idempotency key, or review decision.

The isolated kill-switch regression compared an in-flight generation that had already snapshotted a rule with a subsequent generation whose execution flags were false. The first retained its exact attribution; the next carried no rules. This did not test a live production flag change.

## Monitoring and remaining limits

Authoritative attempt and validation tables support compliance coverage and unresolved-outcome counts. Learning lifecycle actions have audit rows. Shadow runs persist status, safe failure code, rule versions, provider-call count, estimated token maximum, and paired results. HTTP request failures emit safe error codes.

There is no dedicated dashboard/alert pipeline for shadow lifecycle latency, actual provider spend, or per-rule retrieval rates. Provider tokens and dollar cost are not measured from upstream usage responses. No production-like latency, database growth, lock-contention, or monetary-cost benchmark was run. Add monitoring and measured resource budgets before any live rollout.

Application retention does not expire database backups. Deleted evidence can remain in a backup until the operator's backup window expires. Evidence cleanup is bounded and exposes overdue backlog, but cannot promise a strict maximum age during a persistent backlog.

## Authorization boundary

Automated verification for this closure pass used only disposable local MySQL, mocked providers, and local headless Chrome. Anonymous access, CSRF/cross-origin rejection, invalid/nonexistent identifiers, malformed/oversized inputs, targeted stored/reflected XSS output, default-off flags, a real separate-process shadow quota check, and the isolated shadow recovery path were exercised. A deterministic conflict-check false negative for direct Tebar API-call wording was reproduced and fixed; its regression test now passes. A former 500-row active-rule truncation was also confirmed and fixed with a transactional ceiling and fail-closed retrieval when the active population is over limit.

The workspace authorization model has one role (`admin`) shared by all active administrator accounts. It has no tenant or per-record owner boundary; no multi-tenant isolation guarantee is claimed. A mock OpenRouter contract test demonstrates instruction placement and auditor separation, but does not prove a real model's behavior. No paid provider was called because none was authorized. At the time of the 2026-11-10 report, the Learning-specific output review was incomplete; the 2026-11-11 source and synthetic-canary recheck is recorded below and still does not cover production traces or arbitrary administrator-entered PII.

Manual keyboard-only review, macOS Safari VoiceOver, actual Chrome zoom at 200%/400%, and full visual contrast review remain **NOT EXECUTED**. The manual browser host was unavailable and VoiceOver was off. Complete [AI_LEARNING_MANUAL_ACCEPTANCE_CHECKLIST.md](AI_LEARNING_MANUAL_ACCEPTANCE_CHECKLIST.md) and record evidence before changing P1 acceptance.

This task did not change production configuration, apply a production migration, call a paid model provider, switch an account, publish to Threads, or deploy. P1 acceptance and production activation remain **NO-GO**.

## Final handoff status — 2026-11-10

The acceptance handoff reran the DB-free unit suite (369 passed, 0 failed, 19 MySQL-gated skips), the focused Learning/session security suite (18 passed), and the local Chrome/MySQL browser E2E (7 passed). The manual app is prepared on a disposable schema and reports ready; no human keyboard, native zoom, visual contrast, or VoiceOver test was performed. These results do not change the production decision.

### Remaining release gates

| Gate | Current status | Required evidence before production activation |
| --- | --- | --- |
| Manual accessibility acceptance | NOT EXECUTED; important deferred check | Record the 23 keyboard, native zoom/reflow, contrast, and VoiceOver observations before broad administrator rollout. Current user instruction permits application-code deployment with Learning flags off without treating these rows as passed. |
| Learning-specific secret/output review | PASS for enumerated source/local paths; PARTIAL for arbitrary PII and production traces | The workspace-wide admin audience is confirmed. Keep minimization guidance; arbitrary names/addresses are not detected comprehensively. Inspect production traces and retention before broad Learning use. |
| Real-model adversarial evaluation | NOT EXECUTED; deferred controlled rollout activity | Mock/deterministic tests support functional acceptance, not model reliability. Obtain explicit provider/account/model/scenario/call and provider-enforced spend authorization before real-provider shadow or learning prompt integration. |
| Proxy and login-throttle topology | BLOCKED pending deployment evidence | Verify the actual reverse-proxy hops and forwarded-header normalization. Trust only specific proxy addresses/hops; do not use unrestricted trust. Test that a client cannot choose an arbitrary effective rate-limit IP. |
| Provider spend monitoring | NOT IMPLEMENTED | Establish provider-side hard dollar limits and review the provider's usage report. Application token estimates and call quotas are not a dollar cap. |
| Production migration/restore and backup policy | NOT EXECUTED in this handoff | Complete the existing Stage A restored non-production migration/restore, operational backup expiry and restore evidence, and required recovery checks. Application deletion does not remove records from retained backups. |

The proxy finding is conditional: no deployed topology was inspected, so no exploitable defect is claimed. It is a production-only acceptance gate. The workspace-wide admin model has no tenant or per-record ownership boundary; no multi-tenant guarantee is claimed or required by the current application specification.

During the handoff review, the disposable manual MySQL container's host port was found published on all interfaces. The container was recreated with its existing test volume preserved and port 3306 bound only to host `127.0.0.1:33345`. The database schema, account, and synthetic fixture counts were verified after the change; the test application health/login and Chrome E2E passed again. This corrects the local test environment only and does not modify production infrastructure.

**P1 acceptance remains NO-GO. Production activation and deployment remain NO-GO.** Learning capture, activation, retrieval, prompt integration, shadow execution, scheduler, and provider calls remain disabled in the prepared manual environment. The user must complete the manual checklist and explicitly authorize any provider evaluation separately. No deployment or production action is permitted by these results.

## Earlier production-oriented disposition — 2026-11-11 (superseded by the in-place preflight above)

At the time, this disposition superseded older blanket deployment statements while preserving their evidence. The later in-place preflight at the top now controls the production deployment decision. Risk-based deferral does not convert deferred checks into passes or authorize a production action.

- **Core implementation:** COMPLETE for the implemented P0/P1 workflows.
- **Functional acceptance:** GO for the mocked, deterministic, isolated-MySQL, and browser-tested critical flows listed in `AI_LEARNING_P1_ACCEPTANCE.md`.
- **Production deployment readiness at that review:** CONDITIONAL GO for application code only, with every Learning execution flag off, after target-environment prerequisites. This is superseded by the target-specific **NO-GO** at the top of the report; no deployment was performed or authorized.
- **Learning activation readiness:** NO-GO. Do not enable capture, activation, retrieval, prompt integration, or shadow by implication of a successful deployment. Each stage needs a separate explicit authorization.
- **Manual accessibility:** 23 checks remain NOT EXECUTED. This is an important follow-up before broad administrator rollout; automated Axe and browser evidence are not a manual pass. Fix any high-impact defect found before release.
- **Real-model evaluation:** NOT EXECUTED and not authorized. It is a controlled-rollout prerequisite before real-provider shadow calls or learning prompt integration, not a prerequisite for deploying the application with Learning flags off.

### Target-environment prerequisites for a deployment decision

Before any operator deploys, verify and record:

1. Public HTTPS `BASE_URL`, the actual reverse-proxy hop count and forwarded-header normalization, and a client-spoofing check before enabling `TRUST_PROXY`.
2. An encrypted offsite database backup plus a successful restore rehearsal. The staging deploy script's same-host unencrypted dump is not a production backup guarantee; confirm backup expiry separately because database deletion does not erase retained backups.
3. Host MySQL CPU/memory limits and Docker log rotation/retention. These are not defined or measured by this repository.
4. The exact digest-pinned application image, the controlled MySQL image upgrade plan, and a deployment window that accounts for scheduler startup and due slots.
5. Smoke checks against the intended target: `/health/live`, `/health/ready`, administrator login, Learning capabilities showing all execution flags false, migration state, provider configuration without exposing credentials, and existing publisher/scheduler isolation.

These items are deployment-context evidence, not defects confirmed in the isolated environment. Production ingress, backup/restore, host resource policy, and production traces were not inspected here. Provider-side hard USD limits and usage monitoring are additionally required before any paid provider request; the application quota and token estimate are not a dollar cap.

The application does not have a production-provider allowlist or an application-enforced USD spend ceiling. If an operator explicitly enables shadow evaluation and an administrator starts a run, it uses the currently configured model/provider credentials. Keep shadow disabled until a separate authorization identifies the provider account, model, call ceiling, and externally enforced per-run/aggregate spend limits. This is a controlled-activation condition, not a blocker for deploying with every Learning flag false.

### Latest verification evidence

On 2026-11-11: `npm test` reported **394 total / 375 passed / 0 failed / 19 MySQL-gated skipped**; `npm run test:integration` reported **75 passed**, with the MySQL configuration case **1/1**; nine serial Learning MySQL integration files reported **25/25**; `npm run test:learning:browser` reported **7/7**; Compose configuration, deploy-script syntax, `npm run check`, and `git diff --check` passed. The temporary schema-scoped test grant was revoked after isolated MySQL testing. These are local/mock results; no provider, production database, Threads endpoint, or deployment was used. Skipped tests are not passes.

Operational response remains: disable Learning flags and restart only the application process; deactivate or roll back an exact problematic rule version while preserving its audit trail; rely on baseline fallback on retrieval failure; and reconcile an unknown publishing result before any retry. Never mutate ready slots or retry an unknown publish blindly. Current runtime lacks host-level MySQL pressure alerts, Docker log retention, provider-dollar monitoring, a production metrics exporter, and a provider/account authorization allowlist; configure the operational controls before production use and keep shadow disabled until the separate provider gate is satisfied.

**Historical result at the time of this earlier local readiness review:** production deployment readiness was CONDITIONAL GO pending target checks; Learning activation was NO-GO. This classification is superseded by the target-specific in-place promotion preflight at the top of this report, which is **NO-GO** because authorized live inspection and the critical host, backup, proxy, migration, and scheduler evidence remain unavailable. It never granted deployment permission.

## Acceptance evidence recheck — 2026-11-11

The report above remains the production decision. This addendum updates the Learning-specific output review and test evidence only; it does not authorize any production or provider operation.

- Confirmed legacy current-rule and rule-version response paths could return standalone system-prompt labels because the prior evidence filter checked credentials/contact patterns but not those markers. Synthetic authenticated probes reproduced the output. A shared public mapper now withholds supported sensitive values and explicit system/developer/internal prompt labels, redacts contact details, and distinguishes missing text as unavailable; current-rule and version UIs display fixed text notices. Route, isolated MySQL, and browser regressions passed. Runtime retrieval mapping and stored bytes are unchanged; no migration was added.
- The source review covered Learning route response mappings, browser-visible Learning output, error handling, and runtime logs. Synthetic provider credential, session token, internal prompt, email, phone, database password, and private-host values did not appear in the tested error response, logger fields, or notification event. This is a local tested-path result; production traces were not available or inspected.
- Residual privacy limit: the conservative text filter cannot identify arbitrary names or street addresses in free-form administrator feedback/reasons/instructions. Those fields are authenticated and visible to workspace admins, but the filter cannot establish that they contain no personal information. Treat this as a P1 data-minimization condition for owner policy, not a cross-tenant vulnerability.
- Current focused reruns: `node --test test/learning-security.test.js` 6/6; `npm test` 370 passed, 0 failed, 19 MySQL-gated skips; `node --test test/learning.mysql.integration.test.js` against disposable MySQL 8.4.13 12/12; `npm run test:learning:browser` 7/7 in 16.60 seconds. No paid provider, production credentials, Threads publishing, production migration, or deployment was used.
- The repository checklist still has all manual keyboard, zoom, contrast, and VoiceOver observation/evidence/status cells blank. The user’s statement that the checklist was completed is not represented by recorded results in the current workspace copy, so those checks remain **NOT EXECUTED** until the observations are recorded.

### Updated readiness separation

| Decision area | Current result | Remaining evidence |
| --- | --- | --- |
| P1 acceptance | **NO-GO** | Record the 23 manual accessibility observations, confirm the documented workspace-wide administrator audience, and complete the mandatory model-facing adversarial evaluation after explicit provider and spend authorization. |
| Production activation | **NO-GO** | Actual ingress/proxy topology, provider-side dollar ceilings and monitoring, restored migration/restore and backup-expiry evidence, staged exposure controls, production logs/traces, and production security review remain open. |
| Production deployment at that earlier recheck | **CONDITIONAL GO / not performed; superseded** | The later in-place promotion preflight at the top of this report is **NO-GO** until those target-specific checks are completed through authorized read-only inspection and a reviewed release artifact exists. |

No feature flags or provider credentials were modified by this recheck. The E2E suite temporarily enabled only the explicit activation control in its disposable app process to test lifecycle UI; retrieval, prompt integration, shadow, provider credentials, scheduler, and publishing remained disabled. No live Threads request occurred.

## Final output-security recheck — 2026-11-11

The Learning output review now covers public free-text reasons/explanations, structured audit details, shadow result captions, metadata, and ratings. Explicitly labelled internal prompt text is withheld from those diagnostic fields; action and shadow objects are reconstructed from bounded allowlists. Credential-shaped model IDs are rejected before shadow work starts and hidden in persisted reads; fact/config identifiers that would be changed by contact redaction are not returned. Live-generation rule retrieval and production configuration were not changed. No migration was added.

Latest evidence: `npm test` **391 total / 372 passed / 0 failed / 19 MySQL-gated skipped**; focused output/security/shadow/lifecycle **47/47**; isolated MySQL Learning lifecycle **12/12**; isolated MySQL shadow persistence **1/1**; local Chrome E2E **7/7 in 16.02 seconds**; `npm run check && git diff --check` passed. No manual accessibility observations were entered. All 23 manual result/evidence rows remain blank and are **NOT EXECUTED**.

### P1 acceptance blockers

- Record physical keyboard/focus, actual 100/200/400% Chrome zoom/reflow, rendered-state WCAG contrast, and macOS Safari VoiceOver observations in `AI_LEARNING_MANUAL_ACCEPTANCE_CHECKLIST.md`.
- The working administrator-only free-text/data-minimization policy is recorded. Confirm that workspace-wide administrator visibility is intentional. Arbitrary names and street addresses are not comprehensively detected; the policy does not claim complete PII minimization or require structured-only fields.
- No live-model adversarial request was made. It remains a mandatory P1 and production activation blocker, marked BLOCKED/NOT EXECUTED. Obtain explicit provider/account/model/scenario/call authorization and provider-enforced spend limits before any request.

### Production-only gates

Production activation and deployment remain **NO-GO** until actual ingress/proxy trust is verified, provider-side USD ceilings and monitoring are configured, restore/migration and backup expiration are evidenced, production logs/traces are reviewed, and staged exposure/rollback controls are approved. No production credentials, database, provider, scheduler, or Threads operation was touched in this recheck.

**Implementation status: PARTIAL for acceptance closure. P1 acceptance: NO-GO. Production readiness/activation: NO-GO.**

## Latest P1 acceptance closure evidence — 2026-11-11

The latest full unit run before the current UI-only policy notice/length alignment was `npm test`: **393 total: 374 passed, 0 failed, 19 DB-gated skipped**. For the current UI change, the affected contract test passed **5/5** and local Chrome E2E **7/7 in 16.28 seconds**; `npm run check && git diff --check` passed. Earlier focused Learning security/shadow/rule tests passed **49/49**, isolated MySQL Learning lifecycle **12/12**, and MySQL shadow persistence **1/1**; no backend, authorization, persistence, or retention code changed afterward. The synthetic canary review confirms tested Learning API/output/error/log paths do not return provider/session/prompt/contact/database/private-host markers. This does not inspect production traces or establish arbitrary PII detection. No MySQL schema migration was added in this closure pass.

The E2E test has a synchronization correction: it now waits for the app’s next-frame focus transfer before entering feedback. One prior failure was a test timing race; the final suite passed with the stored-XSS assertion intact. This does not replace human keyboard or focus testing.

The manual checklist is still blank across all 23 keyboard, native zoom/reflow, contrast, and VoiceOver rows. P1 acceptance remains **NO-GO** until those actual results are recorded, the owner confirms the documented workspace-wide admin audience, and the mandatory model-facing adversarial evaluation is authorized and completed.

Production-only gates remain: verify the actual ingress/proxy and forwarded-IP trust; establish provider-side hard dollar limits and spend review; complete restored non-production migration/backup/restore and backup expiration evidence; inspect production logs/traces; and approve staged exposure, monitoring, and rollback controls. These are deployment-context conditions, not defects reproduced in the isolated app. All Learning execution flags remain default-off; no provider request, production database/credential change, Threads post, deployment, or commit occurred. Preserve the unrelated `docs/featv1.md` worktree change.

**Latest decisions: P1 acceptance NO-GO; production readiness/activation NO-GO.**

## Administrator text policy and real-model activation gate — 2026-11-11

The working data policy is administrator-only free text with data minimization, pending owner confirmation of the existing workspace-wide admin model. Existing server-side authorization, CSRF, bounded/type-checked inputs, safe text rendering, synthetic error/log canaries, and audit retention remain in force. The Learning screen now warns that every active workspace admin can read free-text feedback/rules and tells admins not to enter personal information or secrets. This does not claim complete PII detection. Feedback/audit history has no application TTL; evidence cleanup and external backup expiry remain separate retention classes. The pending sign-off is confirmation of the current audience, not a requirement to adopt structured-only fields.

Merged Master §3 requires prompt-injection security testing; §5 directs mock providers/fixtures by default and requires explicit authorization before paid provider calls. The existing P1-06/P1-11 acceptance rows and SEC-PROMPT-02 classify model-facing adversarial behavior as a mandatory P1 criterion. This report preserves that accepted criterion; mock request tests do not satisfy model-facing evaluation. It remains blocked until an isolated evaluation is explicitly authorized, completed, and reviewed with provider-enforced spend limits. Production activation remains **NO-GO** pending this and all other production gates. No provider request occurred; credentials alone do not authorize spend.

The local manual app and disposable loopback database were live and healthy during this recheck. User-executed accessibility checks remain pending; see `AI_LEARNING_MANUAL_ACCEPTANCE_CHECKLIST.md` for exact commands and all 23 procedures. No production environment or credential was changed.

The administrator text notice/description update, including revision rationale and max-length alignment, passed the directly affected automated checks: UI contract **5/5** and local Chrome/MySQL E2E **7/7**, 0 failed/skipped, **16.28 s**. No full backend suite was repeated because no server authorization or persistence code changed. Manual VoiceOver remains unexecuted.

**Previous strict-gate statuses above are historical.** Current decisions are stated at the top of this report and in the risk-based release disposition below.
