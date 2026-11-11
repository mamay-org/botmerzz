# BotMerzz homelab deployment

This is the current deployment procedure. The only target is Proxmox LXC `10027`, hostname `bot-merzz`, on node `mamay`. This change does not deploy to the LXC, modify the ingress gateway, contact the previous VPS, or run an external provider. The live app, database, admin account, and public route must be verified during the separately approved first release.

## Target and traffic path

| Component | Target |
|---|---|
| Proxmox node / LXC | `mamay` / `10027` |
| LXC hostname and address | `bot-merzz` / `192.168.0.27/24` |
| OS and architecture | Debian 13.7 Trixie, AMD64 |
| Resources | 2 CPU cores, 8192 MB RAM, 512 MB swap, 30 GB NVMe |
| Docker | Engine 29.9.3, Compose 5.7.1; already installed and verified |
| GitHub runner | `lxc-10027-botmerzz`, OS user `runner`, already online |
| Runner label | `botmerzz-lxc-10027` |
| App directory | `/opt/botmerzz` |
| Public URL | `https://botmerzz.sequein.my.id` |

Traffic uses the existing Cloudflare Tunnel and Traefik on LXC `10080` (`192.168.0.80`). The existing Traefik file route forwards the BotMerzz hostname to `http://192.168.0.27:3000`. No ingress route, tunnel, or other app is changed here.

```text
Browser -> Cloudflare HTTPS -> existing tunnel -> Traefik (LXC 10080)
        -> 192.168.0.27:3000 -> BotMerzz app -> private Compose network -> MySQL 8.4
```

## CI and release path

Pull-request CI runs on GitHub-hosted runners. It installs dependencies, audits packages, runs code checks and tests, exercises the MySQL integration/migration suites against a disposable MySQL 8.4 service, and validates the runtime image. PR code never runs on the privileged homelab runner.

After CI completes, the separate `.github/workflows/deploy-homelab.yml` workflow receives a `workflow_run` event. Its GitHub-hosted validation job checks the completed run's name (`CI`) and workflow path (`.github/workflows/ci.yml`), `push` event, `main` branch, successful conclusion, same repository and head repository, and a valid full commit SHA using the GitHub API. It does not check out CI source or download/consume artifacts. This validation prevents fork/PR code from reaching the privileged runner.

The self-hosted deployment job uses the validated CI run's `head_sha`. The deploy workflow's own `github.sha` is not the commit that CI tested. After the job acquires its fixed concurrency slot, it checks out that exact validated SHA, then rechecks that it is still current `main` before invoking the deployment script. It passes the validated SHA and provenance values as script inputs; `scripts/deploy-homelab.sh` fails closed if repository, workflow, event, branch, conclusion, tested SHA, or freshness do not match. The deployment job:

1. Requires the completed, successful trusted `CI` push run for `main` and the unique labels `[self-hosted, linux, x64, botmerzz-lxc-10027]`.
2. Serializes releases with a fixed concurrency group and `cancel-in-progress: false`.
3. Checks out the validated CI `head_sha` rather than the deploy workflow's `github.sha`.
4. Rechecks current `main` after acquiring the concurrency slot and before invoking the deployment script or making release changes.
5. Builds `botmerzz:<full-commit-sha>` locally on LXC 10027, without publishing or pulling the app image from GHCR.
6. Validates Compose without printing its resolved environment, starts or reuses only MySQL, and waits for its health check.
7. Stops the app, applies ordered migrations from the candidate image, and recreates only the app service.
8. Checks local LAN readiness at `192.168.0.27:3000`, the existing Traefik Host-header route on `192.168.0.80`, and public HTTPS at `botmerzz.sequein.my.id`. It also verifies readiness, runtime safety flags, and that the running image and OCI revision match the validated SHA.
9. Switches `/opt/botmerzz/active` only after these checks succeed and stores the prior SHA in `/opt/botmerzz/previous-release`.

The deployment entrypoint is `bash scripts/deploy-homelab.sh`, called with the validated CI SHA and provenance outputs. Both workflows use read-only GitHub token permissions. The pipeline uses `workflow_run` only with explicit source-run validation; it does not use GHCR credentials, VPS SSH credentials, or manual dispatch. The runner's Docker-group access is effectively root access to LXC 10027, so only the validated trusted `main` release may reach it.

Docker may fetch a missing upstream base image such as Node or MySQL from its configured image source. BotMerzz runtime images are built and kept locally; no BotMerzz application image is published to or pulled from an external registry.

## Compose and persistent state

Compose uses project name `botmerzz`. The app binds to `192.168.0.27:3000:3000` so Traefik can reach it over the LAN. MySQL 8.4 publishes no host port. The app and database share a private internal network; the app also has an egress network for provider APIs. The database persists in the named volume `botmerzz_mysql_data`.

The deployment script never runs `docker compose down -v`, `docker volume prune`, `docker volume rm`, or a general image-prune command. Routine app releases do not recreate MySQL or remove its named volume. Do not change the Compose project name or volume name after initial setup.

The LXC filesystem separates local secrets, source, release configuration, and backups:

```text
/opt/botmerzz/
├── .env                         # local runtime configuration/secrets; mode 0600
├── source/<full-sha>/           # source/build context for each release
├── releases/<full-sha>/
│   ├── compose.yaml             # Compose config for that immutable image
│   ├── release.env              # non-secret release/image metadata
│   └── metadata.json            # commit and release timestamps
├── active -> releases/<sha>     # current successful release
├── previous-release             # previous full SHA; plain text
├── state/                       # bootstrap/deploy safety metadata
└── backups/                     # protected local recovery files
```

`/opt/botmerzz/.env` is created on the LXC and is never synchronized from Git or replaced by the workflow. `.env`, `.env.*` secrets, backup material, and runtime data are excluded from the Docker build context and source control. Keep release images for the current and previous known-good commits; there is no automatic image cleanup.

## Prepare LXC 10027 once

Docker, the LXC, and the GitHub runner are already installed. Do not recreate the container, reinstall Docker, or re-register the runner. Log into LXC 10027 and prepare the app directories as root:

```sh
install -d -o runner -g runner -m 0750 /opt/botmerzz
install -d -o runner -g runner -m 0750 /opt/botmerzz/source /opt/botmerzz/releases /opt/botmerzz/state
install -d -o root -g root -m 0700 /opt/botmerzz/backups
```

Generate fresh MySQL credentials directly on the LXC. This command writes the values straight to the local runtime file and does not print them. Do not enable shell tracing or paste the file contents into chat or CI logs.

```sh
sudo -u runner bash <<'CREATE_ENV'
set -eu
umask 077
DB_ROOT_PASSWORD="$(openssl rand -hex 32)"
DB_PASSWORD="$(openssl rand -hex 32)"
cat > /opt/botmerzz/.env <<ENV
NODE_ENV=production
PORT=3000
HOST_IP=192.168.0.27
HOST_PORT=3000
BASE_URL=https://botmerzz.sequein.my.id
TIMEZONE=Asia/Kuala_Lumpur
TRUST_PROXY=192.168.0.80
DB_HOST=db
DB_PORT=3306
DB_NAME=botmerzz
DB_USER=botmerzz_app
DB_PASSWORD=$DB_PASSWORD
DB_ROOT_PASSWORD=$DB_ROOT_PASSWORD
DB_POOL_SIZE=5
SCHEDULER_ENABLED=false
LEARNING_CAPTURE_ENABLED=false
LEARNING_ACTIVATION_ENABLED=false
LEARNING_RETRIEVAL_ENABLED=false
LEARNING_PROMPT_INTEGRATION_ENABLED=false
LEARNING_SHADOW_ENABLED=false
LEARNING_RETENTION_ENABLED=false
LEARNING_RETENTION_DAYS=
TEBAR_API_KEY=
TEBAR_PROFILE_ID=
TEBAR_ACCOUNT_ID=
TEBAR_WEBHOOK_SECRET=
OPENROUTER_API_KEY=
OPENROUTER_MODEL=google/gemini-3.8-flash
OPENROUTER_GENERATOR_TEMPERATURE=
OPENROUTER_GENERATOR_TOP_P=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
ENV
unset DB_ROOT_PASSWORD DB_PASSWORD
chmod 600 /opt/botmerzz/.env
CREATE_ENV
```

The generated DB values are new and unrelated to any old VPS credentials. Add provider secrets later, directly on the LXC, after onboarding. The optional Tebar, OpenRouter, Telegram, generator sampling, and learning-retention fields are left empty; the existing OpenRouter model default is retained. Never put real provider or DB values in `.env.example`, GitHub Actions variables, or workflow logs.

Check the file's permissions without printing it:

```sh
stat -c '%a %U:%G %n' /opt/botmerzz/.env
```

Expected permissions are `600` and owner `runner:runner`. Keep a protected encrypted copy for disaster recovery; do not copy it to the repository.

Before opening the deployment PR, confirm the existing runner service is online and idle, has Docker access, and still has label `botmerzz-lxc-10027`. The documented path is `/home/runner/actions-runner`; `./svc.sh status` is the local status check. Do not reinstall or re-register it.

## First release: fresh database and admin bootstrap

The first approved `main` deployment creates a new named volume and a new MySQL 8.4 database. There is no VPS import, backup restore, data synchronization, or fake production history. If the volume name already exists before the deployment process has recorded its own first-bootstrap marker, the script fails closed rather than attaching to or deleting unknown data.

After the workflow has passed readiness and revision checks, use the installed release configuration for the one-time admin prompt:

```sh
docker compose \
  --project-directory /opt/botmerzz \
  --env-file /opt/botmerzz/.env \
  --env-file /opt/botmerzz/active/release.env \
  -p botmerzz \
  -f /opt/botmerzz/active/compose.yaml \
  run --rm --no-deps app npm run admin:create
```

Enter the new administrator email and password interactively. Password entry is hidden; the command does not create default credentials. Do not run `admin:create` on every deploy. The application migration command applies migrations in filename order, including 011–019, and records successful versions under the existing MySQL advisory lock. Migration 018's partial-DDL recovery behavior remains part of the app.

The initial administrator onboarding checklist is:

- Create the admin account and sign in over HTTPS.
- Review brand settings, AI Content Guidelines, and verified product/service facts.
- Configure the OpenRouter key/model only when a paid generation is deliberately authorized.
- Configure the correct Tebar profile/account and webhook secret before any publishing test.
- Set the Tebar webhook callback to the public HTTPS endpoint and configure the same signing secret in Tebar and `/opt/botmerzz/.env`.
- Configure Telegram bot/chat values if notifications are wanted.
- Review the automation schedule and publishing state; do not enable it during deployment checks.
- Review Learning permissions and retention; leave all execution flags disabled and do not activate rules or run paid evaluations.

Do not send real Threads posts, call paid AI APIs, or generate fabricated analytics/history during installation verification.

## Health and ingress verification

The app exposes `/health/live` for process liveness and `/health/ready` for readiness, database connectivity, schema compatibility, and scheduler readiness when enabled. The deployment job also compares the running image and OCI revision label with the full commit SHA.

After first deployment, run these read-only checks in order:

1. On LXC 10027, check Compose state and local readiness:

   ```sh
   docker compose --project-directory /opt/botmerzz --env-file /opt/botmerzz/.env --env-file /opt/botmerzz/active/release.env -p botmerzz -f /opt/botmerzz/active/compose.yaml ps
   curl -fsS http://192.168.0.27:3000/health/ready
   ```

2. From LXC 10080, check LAN reachability:

   ```sh
   curl -fsS http://192.168.0.27:3000/health/ready
   ```

3. From LXC 10080, check Traefik's Host-header route:

   ```sh
   curl -fsS -H 'Host: botmerzz.sequein.my.id' -H 'X-Forwarded-Proto: https' http://192.168.0.80/health/ready
   ```

4. From a client with internet access, check Cloudflare HTTPS:

   ```sh
   curl -fsS https://botmerzz.sequein.my.id/health/ready
   ```

These checks use only health GET requests. Confirm that admin redirects remain on the public HTTPS origin and that session cookies are Secure. `BASE_URL` must stay `https://botmerzz.sequein.my.id`; `TRUST_PROXY=192.168.0.80` scopes forwarded-proxy trust to the existing Traefik LXC. The app port is LAN-reachable by design; restrict LAN access according to the homelab firewall policy. Do not alter Traefik routes for other applications.

## Release, rollback, and failed deployments

Deployments may briefly stop the app while migrations and replacement run. The app is built locally with a full immutable SHA tag. MySQL is not recreated unless its Compose definition changes; the routine workflow updates only the intended app service after migrations.

The workflow checks health and image revision before moving `active`. On a failed build, DB startup, migration, app startup, or readiness check, the job fails and does not promote the candidate release pointer. It does not delete the previous image, restore an old database snapshot, or restart an old app against a possibly changed schema. Inspect the failed run and local DB/app state before an operator chooses a recovery action.

If the new schema is backward-compatible with the previous app, an operator can set the Compose file to the SHA in `previous-release` and recreate only the app service with `--no-deps`. Confirm the previous image still exists locally and verify the database remains healthy. If a migration is backward-incompatible, an old image alone is not a rollback. Keep writers stopped and use a restore rehearsed against a separate volume before considering restoration of production data. Never automatically overwrite newer publishing history.

The app uses the same persistent MySQL state for schedules, automation settings, idempotency records, admin sessions, and Learning data. Scheduler behavior and content state survive app container replacement. If explicitly enabled later, the scheduler may tick immediately at app startup; do not change missed-slot or catch-up behavior during a release.

## Backups and disaster recovery

The Docker volume is persistence, not a backup. Prepare a routine backup job owned outside the deployment workflow:

- Run `mysqldump --single-transaction` from the MySQL 8.4 container to create a consistent InnoDB dump.
- Write archives with restrictive permissions to `/opt/botmerzz/backups`; encrypt them and copy them to NAS/off-host storage.
- Back up `/opt/botmerzz/.env` separately in encrypted form. Never include secrets in a CI artifact.
- Keep a documented retention policy (for example, daily short-term copies plus weekly/monthly copies) that fits available capacity and off-host storage.
- Record the app SHA and migration table version with each backup, without including credentials.
- Rehearse restore into a disposable named volume, verify schema/migration history and `/health/ready`, then discard only that disposable test volume.

No real database or environment backup is created by this change. A Proxmox snapshot alone is not a verified MySQL restore. For full recovery, restore the encrypted `.env`, source/release metadata or repository revision, and a tested MySQL backup; preserve publishing/idempotency state. Do not restore a stale snapshot over newer history without explicit owner approval.

## Recovery guide

| Failure | Safe first checks |
|---|---|
| Runner offline | Check `/home/runner/actions-runner/./svc.sh status`, Docker access, and repository runner label. Do not re-register an existing runner. |
| Disk exhaustion | Check `df -h` and `docker system df`; review build cache and retained current/previous images. Do not prune volumes or remove the only rollback image. |
| Docker build fails | Inspect the build error and available disk/RAM. The existing app/database containers and DB volume are not replaced before a successful build. |
| Fresh DB fails | Inspect `docker compose ... logs --tail=100 db` and confirm `.env` permissions. Do not remove the named volume or print the environment. |
| Migration fails | Keep writers stopped; inspect migration history and the failed migration. Migration 018 has special recovery logic. Do not start an old app until schema compatibility is established. |
| App readiness fails | Inspect `docker compose ... logs --tail=100 app` for safe error codes, then test DB readiness and image revision. Do not automatically restore a backup. |
| LAN health fails | Check app container health, binding `192.168.0.27:3000`, and LXC firewall. MySQL must remain unpublished. |
| Traefik/public check fails | Check from LXC 10080 to `192.168.0.27:3000`, then inspect only BotMerzz's existing route and Cloudflare hostname. Do not change other ingress routes. |
| Host reboot | Confirm Proxmox LXC `onboot`, Docker daemon, `unless-stopped` app/db policy, and runner service status. Verify `/health/ready` before resuming any automation. |

Use backups and recovery steps only after reviewing which publication/scheduler state is newer. No live recovery action was performed during repository preparation.

## Operator execution checklist

Use this order for the first release. The repository work is prepared before the PR; MySQL initialization and migration happen only after the approved merge starts the deployment job.

1. On LXC 10027, create `/opt/botmerzz` and its `source`, `releases`, `state`, and protected `backups` directories with the ownership above.
2. Generate new DB credentials directly on the LXC and write the full initial runtime configuration to `/opt/botmerzz/.env`. Verify mode `0600` without displaying the file. Keep the scheduler and all six Learning execution flags false.
3. Confirm the already-installed runner is online, idle, able to use Docker, and has custom label `botmerzz-lxc-10027`. Do not reinstall/re-register it.
4. Open the homelab deployment PR. Review the diff and wait for hosted CI, including fresh-schema MySQL tests, Docker build, workflow checks, and deployment-script tests. No deployment occurs from the PR.
5. After explicit owner approval, merge the PR to `main`. The workflow checks the exact SHA and current `main` head, builds the local image, creates/starts the new `botmerzz_mysql_data` volume and MySQL 8.4 database, applies migrations 001–019, starts the app, and verifies readiness/revision. A failed check leaves the release unpromoted and does not delete DB state or the prior image.
6. After a successful first deployment, run `npm run admin:create` using the Compose command above. Use a new unique admin password; entry is hidden and no default account is created.
7. Verify local readiness on LXC 10027 and LAN reachability from LXC 10080 using the commands in [Health and ingress verification](#health-and-ingress-verification).
8. Check the existing Traefik Host-header route from LXC 10080, then check the public HTTPS health URL. These are read-only GET requests; no provider or publishing call is needed.
9. Complete the onboarding checklist. Keep scheduler and Learning disabled until a separate operator decision; configure Tebar/OpenRouter/Telegram only when their use is authorized.

## Approval and readiness

The repository change is intended to be PR-ready once its CI and local validation pass. The LXC directories and `.env` still require operator preparation. No live LXC deployment, MySQL initialization, administrator creation, LAN request, Traefik request, or public HTTPS request has been performed by this task. Scheduler and AI Learning activation are separate operator decisions after onboarding.

To activate automatic deployment, review and validate the homelab deployment PR, confirm the existing runner is online with the custom label, and obtain explicit approval to merge to `main`. Merging enables CI followed by the local deployment job only when required CI succeeds. This task does not open, approve, or merge a PR, change GitHub settings, or trigger deployment.
