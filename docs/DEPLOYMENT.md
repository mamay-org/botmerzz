# Deployment

## Local Docker

On a fresh checkout, copy `.env.example` to `.env`, set unique local MySQL credentials, then run `docker compose up --build --wait`. Preserve any existing `.env` and review it before starting Compose. The web port is configurable and is bound to localhost by default. MySQL is internal to the compose network and persists in a named volume. Apply schema using `docker compose exec app npm run migrate`; create the initial administrator using the documented bootstrap command.

## VPS preparation

Use `compose.vps.yaml` with the immutable GHCR commit-SHA image published after CI. Install Docker Engine and the Compose plugin, configure a private environment file on the VPS with mode `0600`, and keep database data in its existing named volume with tested backups. For the operator-confirmed BotMerzz in-place promotion, preserve the currently deployed Compose project, app service, MySQL database/volume, environment, and scheduler; do not create a second production stack or database. Verify their live values before any release instead of inferring them from this template. The app binds to loopback; put HTTPS termination and access controls in front of it. The database is on an internal Compose network with no host port. The CLI applies restart-safe migrations under an advisory lock before serving; take a database backup before a release that changes schema or data.

For the dynamic-configuration migration, pause automation and stop every old-version web, scheduler, and CLI process before migrating or starting the new version. Old binaries do not honor the new account-switch fencing and may overwrite account settings from `.env`. Follow the migration, bootstrap, and image rollback safeguards in [Dynamic integration configuration](DYNAMIC-CONFIGURATION.md); MySQL DDL can commit independently and image rollback is not a database rollback.

The staging Compose template defaults `SCHEDULER_ENABLED=false`. The app scheduler polls every 60 seconds when explicitly enabled (minimum 15 seconds); this polling cadence is separate from the admin-configured posting interval. New schedule settings default to 60 minutes and accept whole hours plus minutes down to a one-minute minimum. Existing `intervalHours` JSON settings are converted to minutes when read; no destructive migration is needed. Publishing runs 24/7 and ignores legacy active-day/hour settings. Enabling automation requests the first dispatch immediately; later slots follow the configured interval from a confirmed post or failure. A short interval can run late by the scheduler polling period, and one automation session permits only one generation/publishing cycle at a time. Unknown provider outcomes block later posts until reconciliation. Evaluate Tebar/OpenRouter quotas, rate limits, latency, and API cost before enabling short intervals. Missed slots are skipped without catch-up. The daily Telegram summary is fixed at 22:00 Asia/Kuala_Lumpur. For this BotMerzz deployment, the operator has explicitly chosen in-place promotion of the existing staging VPS/service/database; that decision overrides generic environment-isolation advice and does not authorize creating separate Compose projects, MySQL volumes, credentials, or schedulers. `TRUST_PROXY=true` is valid only behind one trusted reverse proxy; configure login and webhook request limits at that proxy.

## Staging CI/CD

The pipeline runs CI for pull requests to `main` and pushes to `main`. After a successful CI run caused by a push to `main`, GitHub Actions publishes a commit-SHA image and records its digest in the workflow summary. The existing deployment job is named “staging”, uses the `staging` GitHub Environment and matching `compose.vps.yaml`, and is skipped unless `STAGING_DEPLOY_ENABLED` is exactly `true`. Under the operator-confirmed in-place architecture, this job targets the existing production service once promoted; setting the variable to true and pushing to `main` can replace the production app and run pending migrations. There is no separate production workflow or approval environment in the repository. Treat this variable/environment as a production release gate; its live value and reviewer protections were not inspected.

The repository's staging-named SSH setup below describes the existing deployment account and identifiers. Do not enable `STAGING_DEPLOY_ENABLED` for this in-place target until a separately authorized release has passed the production preflight and the environment's approval protection is verified. The environment secrets are:

- `STAGING_SSH_HOST` — staging VPS host/IP.
- `STAGING_SSH_USER` — dedicated deployment account.
- `STAGING_SSH_PRIVATE_KEY` — private key for that account.
- `STAGING_SSH_KNOWN_HOSTS` — verified SSH host-key line(s).

Only the repository owner may change the Actions variable or environment protection, after explicit release authorization. While the variable is false, pushes may still run CI and publish GHCR images, but do not change the VPS. The workflow uses its short-lived `GITHUB_TOKEN` with package-read permission to pull the image; no long-lived GHCR token is required. Never put private keys or tokens in Git or chat.

### VPS deployment account

Run these commands as root on the VPS. The `docker` group can control Docker and is effectively root-equivalent; protect the account and its private key accordingly.

```sh
adduser --disabled-password --gecos "" botmerzz-deploy
usermod -aG docker botmerzz-deploy
install -d -o botmerzz-deploy -g botmerzz-deploy -m 700 /home/botmerzz-deploy/.ssh
chown -R botmerzz-deploy:botmerzz-deploy /opt/botmerzz-staging
chmod 700 /opt/botmerzz-staging
chmod 600 /opt/botmerzz-staging/.env
```

Generate a dedicated Ed25519 key on a trusted workstation and keep its private half there until it is entered directly into the GitHub Environment secret:

```sh
ssh-keygen -t ed25519 -N '' -f ~/.ssh/botmerzz-staging-deploy -C github-actions-botmerzz-staging
cat ~/.ssh/botmerzz-staging-deploy.pub
```

Install the displayed **public** key on the VPS in `/home/botmerzz-deploy/.ssh/authorized_keys`, then set its owner to `botmerzz-deploy:botmerzz-deploy` and mode to `600`. Never copy the private key into `authorized_keys`.

```sh
install -o botmerzz-deploy -g botmerzz-deploy -m 600 /dev/null /home/botmerzz-deploy/.ssh/authorized_keys
```

Append the public key line from `botmerzz-staging-deploy.pub` to that file using a root editor or `tee`, then reapply owner and mode `600`.

Pin the VPS host key instead of using runtime `ssh-keyscan`. On the VPS, read the SSH server fingerprint:

```sh
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

On the trusted workstation, collect the host key and compare its fingerprint with the VPS value. Put the original full `ssh-keyscan` line(s) from `/tmp/botmerzz-known-hosts` into `STAGING_SSH_KNOWN_HOSTS` in `host ssh-ed25519 base64key` known-hosts format. The stripped `.pub` file is only for fingerprint comparison; it is not valid as the workflow's `known_hosts` secret.

```sh
ssh-keyscan -t ed25519 178.83.188.163 > /tmp/botmerzz-known-hosts
awk '{print $2, $3}' /tmp/botmerzz-known-hosts > /tmp/botmerzz-host-key.pub
ssh-keygen -lf /tmp/botmerzz-host-key.pub
```

Do not enable `STAGING_DEPLOY_ENABLED` until the dedicated user can authenticate and run Compose in `/opt/botmerzz-staging`. GitHub Environment secrets are managed in the repository settings; they are not checked into the repository.

Each deployment keeps the same Compose project and database volume, updates only the app image to the published digest, and recreates the app service. It saves a compressed MySQL dump, the previous image reference, and the previous Compose file in `/opt/botmerzz-staging/backups` before replacing the app. These files use mode `600`; deployments prune files older than 30 days. No separate scheduled retention process is configured. The SQL dump remains on the same VPS and is not encrypted or offsite. This is a recovery aid, not a disaster-recovery backup; configure encrypted offsite backups before production.

The deployment restarts the Node process. When `SCHEDULER_ENABLED=true`, the scheduler starts and performs an immediate tick; if dashboard automation is active and a slot is due, it may publish according to the existing schedule. Deployment does not add a new scheduled slot. Account for this when selecting deployment time.

For manual rollback, choose the `.image` and matching `.compose.vps.yaml` files created for the deployment being rolled back. Their names share the `predeploy-<deployed-commit>-<UTC timestamp>` prefix; `.image` contains only the previous `APP_IMAGE` reference, so it does not expose the rest of `.env`. Restore the matching Compose file, set `APP_IMAGE` in `/opt/botmerzz-staging/.env` to the value in the `.image` file, then pull and recreate only the app with the existing Compose project and database volume. Do not use `docker compose down -v`. Image rollback cannot reverse an incompatible database migration; restore the matching pre-deployment SQL dump if required. Verify `/health/ready` and inspect the dashboard after rollback.

## Backup and restore

Create consistent MySQL dumps with `mysqldump --single-transaction` from the database container or a trusted host, encrypt the dump at rest, and store it separately from the VPS. To restore, stop application writers, restore into a compatible MySQL database, verify tables and migration version, then start the app and confirm readiness. Test this procedure periodically; a Docker volume alone is not a backup.

## Rollback

Pin each deployment to its image tag/digest. Roll back by deploying the previous known-good image and restarting the application. Database migrations must remain backward-compatible with the immediately previous app version where practical. If a migration is not backward-compatible, restore the pre-deployment backup as part of the rollback and keep writers stopped until consistency is confirmed.
