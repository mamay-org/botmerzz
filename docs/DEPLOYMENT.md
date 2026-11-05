# Deployment

## Local Docker

On a fresh checkout, copy `.env.example` to `.env`, set unique local MySQL credentials, then run `docker compose up --build --wait`. Preserve any existing `.env` and review it before starting Compose. The web port is configurable and is bound to localhost by default. MySQL is internal to the compose network and persists in a named volume. Apply schema using `docker compose exec app npm run migrate`; create the initial administrator using the documented bootstrap command.

## VPS preparation

Use the same immutable GHCR image digest/tag in staging and production. Install Docker Engine and the Compose plugin, configure a private `.env` on the VPS with restrictive file permissions, and keep database data in a named volume or managed database with tested backups. Put HTTPS termination and access controls in front of the app. Do not expose MySQL to the public network. Run migrations as a one-off deployment step before replacing the app container; take a backup first when a migration changes or removes data.

Production deployment automation is intentionally disabled. VPS address, operating system, ingress/TLS setup, backup destination, and monitoring service still need to be chosen. No production credentials belong in GitHub workflow files.

## Backup and restore

Create consistent MySQL dumps with `mysqldump --single-transaction` from the database container or a trusted host, encrypt the dump at rest, and store it separately from the VPS. To restore, stop application writers, restore into a compatible MySQL database, verify tables and migration version, then start the app and confirm readiness. Test this procedure periodically; a Docker volume alone is not a backup.

## Rollback

Pin each deployment to its image tag/digest. Roll back by deploying the previous known-good image and restarting the application. Database migrations must remain backward-compatible with the immediately previous app version where practical. If a migration is not backward-compatible, restore the pre-deployment backup as part of the rollback and keep writers stopped until consistency is confirmed.
