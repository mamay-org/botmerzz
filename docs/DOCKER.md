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

## Production image and VPS

GitHub Actions builds the runtime Docker target and publishes `ghcr.io/mamay-org/botmerzz:<commit-sha>` plus the moving `:main` tag after CI passes on `main`. The workflow summary records the image digest; prefer `ghcr.io/mamay-org/botmerzz@sha256:...` for a digest-pinned deployment. A full commit-SHA tag is the versioned fallback. `compose.vps.yaml` has no build context and requires `APP_IMAGE`, so it pulls the selected GHCR image. Keep staging and production in separate Compose projects with different credentials, databases and volumes. Production VPS deployment is not automated.

For VPS staging, install Docker Engine and Compose v2, authenticate to GHCR using a credential with `read:packages`, then create a private environment file with mode `0600`. Set `APP_IMAGE` to the full commit-SHA tag, `BASE_URL` to the HTTPS origin, and unique DB credentials. Keep `SCHEDULER_ENABLED=false` for initial startup. The app binds only to loopback; a TLS reverse proxy or private access layer must expose the dashboard. Use `TRUST_PROXY=true` only when exactly one trusted reverse proxy sits in front of the loopback-bound app.

```sh
docker compose -p botmerzz-staging -f compose.vps.yaml config
docker compose -p botmerzz-staging -f compose.vps.yaml pull
docker compose -p botmerzz-staging -f compose.vps.yaml up -d --wait
docker compose -p botmerzz-staging -f compose.vps.yaml ps
```

The service applies migrations under a MySQL advisory lock before serving. Initialize the administrator interactively with `docker compose -p botmerzz-staging -f compose.vps.yaml run --rm app node src/cli.js admin:create`. Keep the scheduler disabled until the staging provider workspace, target account, content facts and approval are verified. After that approval, set `SCHEDULER_ENABLED=true` and enable automation through the authenticated dashboard.

To roll back, redeploy the previous known-good SHA image and run the documented database recovery procedure if that release included a migration. Image rollback alone cannot reverse an irreversible schema or data migration.
