# Docker and Compose

The multi-stage Dockerfile keeps the runtime image separate from dependencies and test tooling. Runtime images use Node.js 22 and run the application as the non-root `node` user. Homelab release images are built locally and tagged with the full source commit SHA.

## Compose services

The primary Compose project is named `botmerzz` and contains:

- `app`: dashboard, API, in-process scheduler, and dispatch endpoints.
- `db`: MySQL `8.4`, health checked, with no published host port.

The app listens on container port `3000` and is published only at `192.168.0.27:3000` for the existing ingress LXC. It joins an internal app/database network and a separate egress network so provider calls originate from the app. MySQL joins only the internal network. Persistent data lives in the named volume `botmerzz_mysql_data`.

Compose applies conservative CPU and memory limits suitable for the 2-core, 8 GiB LXC shared with the runner and operating system. Builds run locally on that LXC. Avoid overlapping manual builds with deployments.

## Local development

For a developer machine, use unique local MySQL passwords and set `HOST_IP=127.0.0.1` and `BASE_URL=http://localhost:3000` in your local `.env`. The homelab example values use the LXC address and HTTPS origin.

```sh
cp .env.example .env
# Edit .env with local DB passwords and loopback HOST_IP/BASE_URL.
docker compose up --build -d --wait
docker compose ps
curl -fsS http://localhost:3000/health/ready
```

Compose waits for MySQL health before starting the app. The app CLI runs ordered, advisory-locked migrations before serving. You can also apply them explicitly:

```sh
docker compose exec app npm run migrate
docker compose exec -it app npm run admin:create
```

`admin:create` prompts for the first administrator interactively and hides password entry. It never creates default credentials.

The environment template carries production-ready defaults for the homelab target, but placeholders for DB and provider secrets remain empty. Validate Compose syntax with synthetic values only; the `--quiet` option prevents resolved environment values from being printed:

```sh
DB_PASSWORD=compose-check DB_ROOT_PASSWORD=compose-check \
  docker compose --env-file .env.example config --quiet
```

Never run Compose against the homelab production `.env` from a development checkout.

## Integration testing

The destructive MySQL suites require `ALLOW_DESTRUCTIVE_DB_TESTS=true` and loopback `DB_HOST`. CI supplies an isolated, disposable MySQL 8.4 service for each job; its test account can create/drop only disposable test databases for the suite. Tests do not use the production Compose volume. For local integration runs, create a separate disposable MySQL container bound to `127.0.0.1` on a test-only port and use a test account with create/drop privileges on that disposable server. Do not attach a test container to `botmerzz_mysql_data` or use a live database hostname.

```sh
npm ci
npm run check
npm test
# Set DB_HOST=127.0.0.1, a test-only DB_PORT/DB_NAME/DB_USER/DB_PASSWORD,
# and ALLOW_DESTRUCTIVE_DB_TESTS=true only for an isolated disposable DB.
npm run test:integration
```

Unit/HTTP tests use mocked providers. They do not call OpenRouter, send Telegram messages, or publish Threads content.

## Homelab release and maintenance

The deployment workflow invokes `bash scripts/deploy-homelab.sh` on the runner in LXC 10027 after hosted CI succeeds for a trusted `main` push. It checks out the tested SHA, builds a local `botmerzz:<full-sha>` image, validates Compose, applies migrations, updates only the app service, checks readiness/revision, and promotes the active release pointer only after success. There is no active GHCR publish/pull or VPS SSH deployment path.

Operations use the current release configuration under `/opt/botmerzz/active`, the local runtime file `/opt/botmerzz/.env`, and stable Compose project `botmerzz`. The full runbook is [Deployment](DEPLOYMENT.md).

```sh
docker compose \
  --project-directory /opt/botmerzz \
  --env-file /opt/botmerzz/.env \
  --env-file /opt/botmerzz/active/release.env \
  -p botmerzz \
  -f /opt/botmerzz/active/compose.yaml \
  ps
```

Container health endpoints are `/health/live` and `/health/ready`. Readiness checks database availability and schema compatibility, and scheduler readiness when enabled. The release job separately verifies the image's revision label against the tested SHA.

`docker compose down` preserves named volumes, but routine releases do not need to stop the whole project. Never run `docker compose down -v`, `docker volume prune`, or `docker volume rm` during deployment or routine maintenance. A volume is persistent state, not a backup; use the tested database backup and restore procedure in [Deployment](DEPLOYMENT.md#backups-and-disaster-recovery).

The first homelab release keeps `SCHEDULER_ENABLED=false` and all six AI Learning execution flags false. The deployment itself makes no provider calls and publishes no posts. The scheduler can tick immediately when enabled, so activation is a separate operator decision after onboarding.
