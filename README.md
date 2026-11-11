# BotMerzz

BotMerzz is a dashboard and scheduled publishing service for Malaysian Malay Threads content. It stores schedules, facts, sessions, learning evidence, and publishing history in MySQL. OpenRouter generates captions and performs semantic review; deterministic checks enforce content policy. Tebar is the publishing adapter, and Telegram notifications use a durable outbox.

The application also includes the AI Learning Center: candidate capture, feedback, approval and rollback, scoped retrieval, prompt integration, shadow evaluation, and quality/compliance analytics. The homelab database starts empty. No VPS records or learning history are copied into it.

## Local Docker

Requirements: Docker Engine with Docker Compose and Node.js 20.6+ for host-based checks. The image uses Node.js 22.

Copy the example environment file, set new local database passwords, and use a loopback host binding for a developer machine:

```sh
cp .env.example .env
# Set DB_PASSWORD and DB_ROOT_PASSWORD; for local-only use, set HOST_IP=127.0.0.1.
docker compose up --build -d --wait
docker compose ps
```

Open [http://localhost:3000](http://localhost:3000). MySQL has no host port and persists in the Compose named volume. Never commit `.env` or use production provider credentials in local development.

Create the first administrator interactively after the app is ready:

```sh
docker compose exec -it app npm run admin:create
```

The email and password are prompted; password entry is hidden. There is no default administrator credential. Authenticated administrators can manage other accounts from the dashboard.

## Checks and tests

```sh
npm ci
npm run check
npm test
```

The database-backed integration suites require a separate disposable MySQL 8.4 instance bound to loopback and the explicit `ALLOW_DESTRUCTIVE_DB_TESTS=true` opt-in. The GitHub-hosted CI job provides that disposable service. Never point destructive tests at a production database or the persistent Compose volume.

AI and publishing tests use mocks. CI does not call paid AI providers, send Telegram messages, or publish Threads posts.

## Homelab deployment

The only deployment target is Proxmox LXC `10027` (`bot-merzz`, `192.168.0.27`) on the Mamay node. A separate `workflow_run` deploy workflow validates a successful trusted `CI` push run for `main`, checks its workflow path, repository/head repository, and full commit SHA, then uses the self-hosted runner label `botmerzz-lxc-10027`. It checks out that validated tested SHA, rechecks current `main`, builds `botmerzz:<full-commit-sha>` locally, and runs Compose from `/opt/botmerzz`; it does not publish to GHCR or SSH to a VPS.

The app is published at `192.168.0.27:3000` for the existing ingress gateway. Traefik on LXC `10080` routes the public hostname [https://botmerzz.sequein.my.id](https://botmerzz.sequein.my.id) to that address. MySQL 8.4 remains private to Docker networking and uses the persistent named volume `botmerzz_mysql_data`.

See [Deployment](docs/DEPLOYMENT.md) for the LXC preparation, first database/admin bootstrap, release flow, backups, rollback limits, and recovery. See [Docker](docs/DOCKER.md) for Compose and local operation details.

Live deployment and public ingress have not been verified by this repository change. Do not merge the deployment workflow until its PR and required CI have been reviewed and the owner explicitly approves release activation. The first installation keeps the scheduler and every AI Learning execution flag disabled.

## Application operations

- `npm start` — run the dashboard server.
- `npm run migrate` — apply ordered, restart-safe MySQL migrations under an advisory lock.
- `npm run admin:create` — create the first administrator with hidden password input.
- `npm run dispatch` — process one due slot for reviewed manual/cron use.
- `npm test` — run unit and HTTP tests.
- `npm run test:integration` — run database-backed checks against explicitly configured disposable MySQL.

The scheduler is in-process and runs only with `SCHEDULER_ENABLED=true`. It polls every 60 seconds by default (minimum 15 seconds); this is separate from the admin-configured posting interval. Enabling automation requests the first dispatch immediately. Missed slots are skipped without catch-up, and unresolved provider outcomes block later publishing until reconciled. Keep automation off until the intended Tebar account, brand facts, schedule, and provider settings have been reviewed.

The AI Learning Center remains available in the application, but its six execution flags are false for initial homelab setup. Do not activate rules or run paid model evaluations as part of deployment validation.

For product requirements and architecture, see [requirements](docs/REQUIREMENTS.md), [architecture](docs/ARCHITECTURE.md), [testing](docs/TESTING.md), and [operations](docs/OPERATIONS.md).
