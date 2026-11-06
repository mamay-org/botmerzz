# Local Docker workflow

## Prerequisites

- Docker Engine/Desktop with Docker Compose v2.
- Node.js 22 is used in the image; local Node.js 20.6 or newer is supported by the app.

## Start

On a fresh checkout, copy `.env.example` to `.env` and replace both local database passwords with different random values. If `.env` already exists, verify its values and preserve it. Then run:

```sh
docker compose up --build -d
docker compose ps
docker compose logs -f app
```

The app binds to `127.0.0.1:3000` by default. Set `HOST_PORT` to change the host port or `PORT` to change the container port. MySQL has no published host port; the app reaches it on the private Compose network. The named `mysql_data` volume persists database contents across container restarts and rebuilds.

To run quality checks and tests inside an isolated test image against a separate test-only MySQL service and named volume:

```sh
docker compose --env-file .env.example --profile test run --build --rm tests
```

The test target includes test/development files and dependencies. The default runtime image excludes them. The test profile uses `db-test` and `mysql_test_data`; it cannot write to the dashboard's `mysql_data` database.

Compose waits for MySQL health before starting the app. The CLI applies versioned migrations under a MySQL advisory lock before serving. The app health check calls `/health/ready`; `/health/live` reports process liveness. Automation and the in-process scheduler are disabled by default.

## Common operations

```sh
docker compose --env-file .env.example --profile test run --build --rm tests
docker compose exec app npm run migrate
docker compose restart app
docker compose down                 # keeps mysql_data
docker compose down -v              # DESTRUCTIVE: deletes local database data
```

Do not use `down -v` when you need to retain local test data. Back up a database before removing or migrating persistent volumes.

## GHCR image and VPS staging

GitHub Actions runs CI for pull requests to `main` and pushes to `main`. After CI passes for a push, the publish workflow pushes the runtime image tagged with the full commit SHA and `main`, and records its immutable digest in the workflow summary. `compose.vps.yaml` has no build context and requires `APP_IMAGE`, so VPS deployments use the digest-pinned GHCR reference. The optional staging deployment job runs after image publication only when the repository Actions variable `STAGING_DEPLOY_ENABLED` is exactly `true`. No production deployment is configured.

Before enabling the deployment variable, configure the GitHub Environment `staging` secrets `STAGING_SSH_HOST`, `STAGING_SSH_USER`, `STAGING_SSH_PRIVATE_KEY`, and `STAGING_SSH_KNOWN_HOSTS`, then prepare the VPS deployment user and `/opt/botmerzz-staging` permissions. The job uses a short-lived `GITHUB_TOKEN` with `packages: read` to pull the image; it does not require a long-lived GHCR token. Follow [Deployment](DEPLOYMENT.md#staging-cicd) for key generation, host-key verification, one-time VPS setup, and rollback.

Keep the VPS environment file private with mode `0600`. Set `BASE_URL` to the HTTPS origin, `TRUST_PROXY=true` only behind the single trusted Caddy reverse proxy, and use unique database credentials. MySQL remains on the internal Compose network; the app binds to loopback. Keep `SCHEDULER_ENABLED=false` on initial startup and keep automation off until account, content facts, schedule, and publishing approval are verified.

```sh
docker compose -p botmerzz-staging -f compose.vps.yaml config
docker compose -p botmerzz-staging -f compose.vps.yaml pull
docker compose -p botmerzz-staging -f compose.vps.yaml up -d --wait
docker compose -p botmerzz-staging -f compose.vps.yaml ps
```

The service applies migrations under a MySQL advisory lock before serving. Initialize the administrator interactively with `docker compose -p botmerzz-staging -f compose.vps.yaml run --rm app node src/cli.js admin:create`. Keep the scheduler disabled until the staging provider workspace, target account, content facts and approval are verified. After that approval, set `SCHEDULER_ENABLED=true` and enable automation through the authenticated dashboard. A redeployed app with the scheduler enabled performs an immediate startup tick; if automation is active and a slot is due, it can publish according to the existing schedule.

For staging rollback, restore the matching saved image reference and Compose file described in [Deployment](DEPLOYMENT.md#staging-cicd), then recreate only the app. Image rollback alone cannot reverse an irreversible schema or data migration; restore the pre-deployment database dump if needed.
