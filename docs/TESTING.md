# Testing

## Local checks

Use Node.js 20.6 or newer. Install dependencies with `npm ci`, then run `npm run check`, `npm test`, and `npm audit`. Tests should use injected provider clients and repositories; automated checks must not publish to a real Threads account or send messages to an operational Telegram group.

## Docker integration checks

Run `docker compose up --build --wait` to start the app and MySQL. The compose health checks verify database readiness and the app's readiness endpoint. Run the test profile against its separate test-only MySQL service; it cannot modify the dashboard's local database. Database integration tests require `NODE_ENV=test`, `DB_NAME=merzz_test`, and the explicit `ALLOW_DESTRUCTIVE_DB_TESTS=true` flag because they reset test-only administrator rows and migration metadata. Never set that flag against a development or production database. Use a test-only Compose environment file, not a deployment `.env`.

For the isolated suite, create a separate test-only environment file containing values for the Compose-required `DB_NAME`, `DB_USER`, `DB_PASSWORD`, and `DB_ROOT_PASSWORD`; optionally set `TEST_DB_PASSWORD` and `TEST_DB_ROOT_PASSWORD`. Choose a unique project name so its MySQL volume is separate from every development or production volume. Then run:

```sh
docker compose --env-file /path/to/test-only.env -p botmerzz-dynamic-test --profile test up --build --exit-code-from tests tests
```

The test service runs syntax checks, the full unit suite, and `npm run test:integration` with empty provider credentials. Review the exit status and test totals. When finished, remove **only that disposable project and its test data** using `docker compose --env-file /path/to/test-only.env -p botmerzz-dynamic-test --profile test down -v`; do not use that cleanup command on a project containing persistent data.

## Required coverage

- Policy: Malay text constraints, approved game/fact rendering, stale facts, all price modes, hour/minute validation (minimum one minute), legacy-hour conversion, and 24/7 scheduling regardless of legacy active-hour settings.
- Auth/API: password hashing, login throttling, session rotation/expiry, CSRF and same-origin enforcement, validation and safe errors.
- Dispatcher: concurrent claims across independent MySQL pools, one active generation/publish per session, unique slot/idempotency key, immediate first dispatch on activation, configured-minute cooldown after a recent post, exact 1/5/15/30/60/90/135 minute planning, no catch-up, pause races, generation retry, unknown provider outcome reconciliation, cancellation and a 22:00 Asia/Kuala_Lumpur summary. Unknown outcomes without provider IDs must not be replayed and must block later posts.
- Adapters: mock Tebar/OpenRouter/Telegram responses, redaction, malformed success responses, rate limits and network failures.
- Database: migrations against the supported MySQL version, simultaneous MySQL claims with one winner, durable prepared payload/idempotency-key recovery after a fresh pool connection, and persistence after app restart.
- Container: non-root runtime, health checks, configurable port, graceful termination, image build and restart with durable database volume.
- Dynamic configuration: one-time and concurrent bootstrap, restart without environment override, version conflict and separate rollback, account validation, paused switching with concurrent dispatch, legacy/unknown and delayed webhook reconciliation, model snapshot across generator and semantic audit, and preservation of a ready payload. Provider requests must use mocks or a verified isolated test workspace.

Use [Dynamic integration configuration](DYNAMIC-CONFIGURATION.md) for the switching invariants and recovery boundaries. A passing mock suite does not verify provider permissions, deployed proxy behavior, or the staging account.

## Local evidence — 9 November 2026

An isolated Docker Compose project with a fresh MySQL test volume and empty provider credentials completed `npm run check`, `npm test` (231 passed, 0 failed, 0 skipped), and `npm run test:integration` (67 passed plus the separate configuration MySQL test, 1 passed; 0 failed or skipped). `npm audit` reported 0 vulnerabilities. The MySQL cases include concurrent account switching versus publication start, delayed webhooks, and conflicting cancellation/publication outcomes. A separate runtime smoke test verified migration, `NOT_CONFIGURED` bootstrap, authenticated configuration read, CSRF rejection, missing-provider failure, and persistence after recreating the container with different environment values. The runtime smoke test preceded the final status-conflict and correlation-logging changes; the full suite and runtime image build were repeated afterward.

The dashboard markup and control contracts have automated checks; complete browser interaction, screen-reader and mobile-device verification, real provider validation, and deployment/staging recovery tests remain pending. The separate security-review agent was unavailable due to a usage limit; the changes have not received an independent security approval.

## Live staging acceptance

After automated checks pass and approval is given, configure a separate Tebar staging workspace and authorized test Threads account. Verify API read authorization, one explicitly labeled text post, provider status and permalink, then confirm the post exists on the intended Threads account. Verify webhook delivery, pause/cancel behavior, scheduled-time delta and Telegram messages with non-sensitive test content. Record actual outcomes. Never use client production credentials for this test suite.
