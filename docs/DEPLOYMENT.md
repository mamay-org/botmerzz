# Deployment

## Local Docker

On a fresh checkout, copy `.env.example` to `.env`, set unique local MySQL credentials, then run `docker compose up --build --wait`. Preserve any existing `.env` and review it before starting Compose. The web port is configurable and is bound to localhost by default. MySQL is internal to the compose network and persists in a named volume. Apply schema using `docker compose exec app npm run migrate`; create the initial administrator using the documented bootstrap command.

## VPS preparation

Use `compose.vps.yaml` with the immutable GHCR commit-SHA image published after CI. Install Docker Engine and the Compose plugin, configure a private environment file on the VPS with mode `0600`, and keep database data in a named volume with tested backups. Set a unique `COMPOSE_PROJECT_NAME`, database credentials and `BASE_URL` for each environment. The app binds to loopback; put HTTPS termination and access controls in front of it. The database is on an internal Compose network with no host port. The CLI applies restart-safe migrations under an advisory lock before serving; take a database backup before a release that changes schema or data.

The staging Compose template defaults `SCHEDULER_ENABLED=false`. The app scheduler polls every 60 seconds when explicitly enabled, while the persisted business cadence remains no less than six hours. Do not enable the scheduler or dashboard automation until the staging Tebar profile, Threads account, approved facts and human approval are confirmed. Keep production and staging in separate Compose projects, MySQL volumes, credentials and provider workspaces. `TRUST_PROXY=true` is valid only behind one trusted reverse proxy; configure login and webhook request limits at that proxy.

Production deployment automation is intentionally disabled. VPS address, operating system, ingress/TLS setup, backup destination, monitoring service and GHCR pull credentials still need to be chosen. No deployment credentials belong in GitHub workflow files.

## Backup and restore

Create consistent MySQL dumps with `mysqldump --single-transaction` from the database container or a trusted host, encrypt the dump at rest, and store it separately from the VPS. To restore, stop application writers, restore into a compatible MySQL database, verify tables and migration version, then start the app and confirm readiness. Test this procedure periodically; a Docker volume alone is not a backup.

## Rollback

Pin each deployment to its image tag/digest. Roll back by deploying the previous known-good image and restarting the application. Database migrations must remain backward-compatible with the immediately previous app version where practical. If a migration is not backward-compatible, restore the pre-deployment backup as part of the rollback and keep writers stopped until consistency is confirmed.
