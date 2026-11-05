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

Compose waits for MySQL health before starting the app, applies migrations, then starts the dashboard. The app health check calls `/health/ready`; `/health/live` reports process liveness. Automation is disabled by default and the example file contains no provider credentials.

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

GitHub Actions builds `ghcr.io/<owner>/<repo>:<commit-sha>` and also updates `:main` after pushes to `main`. Use the immutable SHA tag when deploying the same image to staging and production; environment settings and database remain external to the image. Production VPS deployment is not automated. Configure a separate protected deployment workflow only after the VPS, secrets, backup policy, health checks, and rollback procedure have been approved.

To roll back, redeploy the previous known-good SHA image and run the documented database recovery procedure if that release included a migration. Image rollback alone cannot reverse an irreversible schema or data migration.
