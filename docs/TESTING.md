# Testing

## Local checks

Use Node.js 20.6 or newer. Install dependencies with `npm ci`, then run `npm test` and `npm run check`. Tests should use injected provider clients and repositories; automated checks must not publish to a real Threads account or send messages to an operational Telegram group.

## Docker integration checks

Run `docker compose up --build --wait` to start the app and MySQL. The compose health checks verify database readiness and the app's readiness endpoint. Run the test profile against its separate test-only MySQL service; it cannot modify the dashboard's local database. Database integration tests require `NODE_ENV=test`, `DB_NAME=merzz_test`, and the explicit `ALLOW_DESTRUCTIVE_DB_TESTS=true` flag because they reset test-only administrator rows and migration metadata. Never set that flag against a development or production database. The app container must report unhealthy if it cannot reach the database or migrations are unavailable.

## Required coverage

- Policy: Malay text constraints, approved game/fact rendering, stale facts, all price modes, active hours and IANA timezones.
- Auth/API: password hashing, login throttling, session rotation/expiry, CSRF and same-origin enforcement, validation and safe errors.
- Dispatcher: concurrent claims, unique slot/idempotency key, no catch-up, pause races, generation retry, unknown provider outcome reconciliation, cancellation and summary dedupe.
- Adapters: mock Tebar/OpenRouter/Telegram responses, redaction, malformed success responses, rate limits and network failures.
- Database: migrations against the supported MySQL version, transaction and duplicate-claim behavior, persistence after app restart.
- Container: non-root runtime, health checks, configurable port, graceful termination, image build and restart with durable database volume.

## Live staging acceptance

After automated checks pass, configure a separate Tebar staging workspace and the developer's test Threads account. Verify authorization, one end-to-end text post, webhook delivery, pause/cancel behavior and Telegram messages with non-sensitive test content. Record actual outcomes. Never use client production credentials for this test suite.
