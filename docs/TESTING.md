# Testing

## Local checks

Use Node.js 20.6 or newer. Install dependencies with `npm ci`, then run `npm test` and `npm run check`. Tests should use injected provider clients and repositories; automated checks must not publish to a real Threads account or send messages to an operational Telegram group.

## Docker integration checks

Run `docker compose up --build --wait` to start the app and MySQL. The compose health checks verify database readiness and the app's readiness endpoint. Run the test profile against its separate test-only MySQL service; it cannot modify the dashboard's local database. Database integration tests require `NODE_ENV=test`, `DB_NAME=merzz_test`, and the explicit `ALLOW_DESTRUCTIVE_DB_TESTS=true` flag because they reset test-only administrator rows and migration metadata. Never set that flag against a development or production database. Use a test-only Compose environment file, not a deployment `.env`.

## Required coverage

- Policy: Malay text constraints, approved game/fact rendering, stale facts, all price modes, one-hour minimum interval, and 24/7 scheduling regardless of legacy active-hour settings.
- Auth/API: password hashing, login throttling, session rotation/expiry, CSRF and same-origin enforcement, validation and safe errors.
- Dispatcher: concurrent claims, unique slot/idempotency key, immediate first dispatch on activation, cooldown after a recent post, recurring intervals, no catch-up, pause races, generation retry, unknown provider outcome reconciliation, cancellation and a 22:00 Asia/Kuala_Lumpur summary. Unknown outcomes without provider IDs must not be replayed and must block later posts.
- Adapters: mock Tebar/OpenRouter/Telegram responses, redaction, malformed success responses, rate limits and network failures.
- Database: migrations against the supported MySQL version, simultaneous MySQL claims with one winner, durable prepared payload/idempotency-key recovery after a fresh pool connection, and persistence after app restart.
- Container: non-root runtime, health checks, configurable port, graceful termination, image build and restart with durable database volume.

## Live staging acceptance

After automated checks pass and approval is given, configure a separate Tebar staging workspace and authorized test Threads account. Verify API read authorization, one explicitly labeled text post, provider status and permalink, then confirm the post exists on the intended Threads account. Verify webhook delivery, pause/cancel behavior, scheduled-time delta and Telegram messages with non-sensitive test content. Record actual outcomes. Never use client production credentials for this test suite.
