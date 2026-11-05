# Kedai Merzz Threads Automation

An MVP dashboard and one-shot publishing service for Malaysian Malay Threads content. It stores schedules, facts, sessions and publish history in MySQL; OpenRouter generates a constrained conversation hook, while the application composes approved product facts and links. Tebar is the publishing adapter. Automation is off by default.

## Run locally with Docker

Requirements: Docker Engine/Desktop with Docker Compose v2. The image uses Node.js 22.

On a fresh checkout, copy `.env.example` to `.env` and replace the local database passwords. If a `.env` already exists, keep it and verify its values before using Compose. Never commit `.env`.

```sh
docker compose up --build -d --wait
docker compose ps
```

Open [http://localhost:3000](http://localhost:3000). The app is bound to localhost by default; change `HOST_PORT` to choose another host port, or `PORT` to change the container port. MySQL is private to the Compose network and persists in the `mysql_data` named volume.

Create the first administrator interactively:

```sh
docker compose exec -it app npm run admin:create
```

The password prompt is hidden. Use a unique password of at least 12 characters. Provider credentials are optional until staging onboarding; add only development/staging credentials to `.env` when needed.

## Migrations and tests

Compose applies migrations before starting the dashboard. To apply them manually:

```sh
docker compose exec app npm run migrate
```

Run the Docker test profile against an isolated test MySQL service and volume. Test mutations cannot affect the local dashboard database:

```sh
docker compose --profile test run --rm tests
```

For host-based checks, use Node.js 20.6 or newer:

```sh
npm ci
npm run check
npm test
npm run test:integration
```

`npm test` uses mocked providers for AI/publishing tests. The database integration smoke test runs when database environment variables are configured. It does not publish to Threads or message Telegram.

## Environment and application commands

See [.env.example](.env.example) for database, port, timezone and optional provider settings. The local example starts with automation disabled and no provider credentials. Production must use HTTPS, a private database, unique credentials and a separately provisioned Tebar account. Do not use client production credentials for local tests.

- `npm start` — run the dashboard server.
- `npm run migrate` — apply versioned MySQL migrations.
- `npm run admin:create` — create the single administrator with hidden password input.
- `npm run dispatch` — process one due slot and exit; invoke from a scheduler/cron, not as a persistent worker.
- `npm test` — run unit and HTTP tests.
- `npm run test:integration` — run database-backed integration checks when DB settings are present.

## Architecture

The Express dashboard and one-shot dispatcher use the same MySQL repository. Domain policy and content generation are isolated from the Tebar, OpenRouter and Telegram adapters. The dispatcher persists exact post payloads and idempotency keys before publishing, atomically claims slots, and reconciles uncertain outcomes without blindly sending duplicates. Telegram delivery uses a durable outbox with deduplication and retries. Emergency pause disables new claims before attempting provider cancellation.

See [requirements](docs/REQUIREMENTS.md), [architecture](docs/ARCHITECTURE.md), [testing](docs/TESTING.md), [Docker workflow](docs/DOCKER.md), [deployment](docs/DEPLOYMENT.md), and [operations](docs/OPERATIONS.md).

## CI/CD and VPS

GitHub Actions runs dependency audit, syntax checks, unit/integration tests against MySQL, and Docker build validation. After a successful CI run on `main`, a separate workflow publishes the tested commit to GHCR using its full commit SHA plus a moving `main` tag. Deploy the same immutable SHA image to staging and production when the VPS is configured.

No VPS deployment workflow is enabled. Host, SSH credentials, TLS/ingress, backup destination and monitoring have not been configured. Follow [deployment and rollback](docs/DEPLOYMENT.md) after those decisions are made; do not put production secrets in GitHub workflow files.

## Current limits

- MVP posts text only; social listening, media generation, live inventory integration, website analytics and multi-admin roles are deferred.
- Staging credentials and a test Threads account are needed for a live provider acceptance test. Automated tests use mocks.
- Profile-visit metrics are not available from the documented Threads insights adapter; the dashboard shows Tebar's 30-day account click total when statistics permission and data are available.
- Confirm the chosen VPS scheduler frequency before promising exact posting time. The dispatcher itself is finite and safe to invoke repeatedly.
