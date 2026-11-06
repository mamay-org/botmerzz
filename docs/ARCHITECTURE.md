# Architecture

## Runtime shape

The application is a small Node.js web service with an optional in-process poller that invokes the finite dispatcher. The dashboard, dispatcher and poller share MySQL state. Docker Compose runs the app and MySQL; `SCHEDULER_ENABLED` explicitly controls whether the app polls. The default is disabled so a fresh deployment cannot publish until an operator enables it.

Admin browser -> Node.js HTTP server -> session/CSRF checks -> application services -> MySQL repository and provider adapters.

The dispatcher calls the same application services. OpenRouter generates content; Tebar publishes and reports status; Telegram sends operational notifications. Tebar webhooks return through a signed endpoint and update the same durable state.

## Boundaries

- Domain policy validates schedule settings, active windows, minimum cadence, fact freshness, content length, currency claims, approved account attributes, and onboarding state. It has no network or database code.
- Content service selects a pillar and eligible facts for OFF/ON/MIXED mode, builds a Malaysian Malay prompt from structured knowledge, calls the AI adapter, then validates the text. It retries generation once; invalid output is skipped after that retry.
- Tebar adapter owns API URLs, Bearer authentication, account/status/list/cancel/insights requests, idempotency headers, and response normalization. Other modules use provider-neutral methods.
- Telegram adapter sends bounded notifications and daily summaries. It redacts secrets and never exposes provider response bodies.
- Repository owns SQL, migrations, transactions, durable slot state, sessions, facts, settings, audit events, and webhook deduplication.
- Dispatcher claims one due slot at a time, generates and validates content, persists the exact request and idempotency key, submits the post, then reconciles status. It never blindly creates a new publish request after an uncertain outcome.
- Telegram delivery uses a MySQL outbox with deduplication, retry backoff, and claim leases. Webhook state and its notification enqueue commit together; dispatcher runs retry pending notifications.
- HTTP application serves static dashboard assets, authenticated JSON routes, login/session/logout, provider webhooks, health status, and safe error responses.

## Scheduling model

Schedule settings contain the interval in hours (minimum 6), active weekdays, daily active-time window, and an IANA timezone. The user-facing default is Asia/Kuala_Lumpur; the engine stores due instants in UTC. A dispatcher invocation queries due work, atomically claims its slot, and exits. A slot outside the configured local active window is marked skipped and does not build a backlog.

The product schedule and scheduler poll interval are separate. The poller checks for due work every 60 seconds by default (configurable from 15 to 3,600 seconds), while the product interval remains at least six hours. It runs immediately on startup and then polls; persisted slots survive restarts. The planner skips slots more than 15 minutes late and out-of-window slots instead of catching up. MySQL row locks and uniqueness constraints protect claims if more than one app process runs.

## Publish and recovery states

Each slot has a unique scheduled instant and durable state: pending, generating, ready, publishing, published, failed, unknown, canceled, or skipped. The exact outbound body and Tebar idempotency key are stored before the request. Known provider IDs are reconciled through Tebar's status endpoint. A request with no known provider ID is never replayed automatically; unresolved slots block later publishing until an operator reconciles the outcome. Cancellation requests only target posts Tebar reports as still scheduled/draft; cancellation races are recorded distinctly.

## Authentication and secret boundaries

- The initial administrator is created by a local bootstrap command. Active admins have equal permissions; account changes are audited and password/email changes revoke sessions. Admin deactivation is soft and preserves references in audit history.
- Passwords use Node's scrypt with a random salt. Session tokens are random, stored as hashes in MySQL, expire server-side, and rotate on login.
- Mutating dashboard requests require same-origin validation and a per-session CSRF token. Cookies are secure in deployed HTTPS environments, HTTP-only, and SameSite strict.
- Tebar, OpenRouter, Telegram, and database credentials are environment-only. The dashboard never returns their values.
- Webhook signatures are verified using the raw request body, a timestamp freshness window, constant-time HMAC comparison, and event-ID deduplication.
- Provider errors are normalized to safe codes; raw response bodies and auth headers are not logged or sent through Telegram.

## Storage choice

MySQL is chosen because the dashboard and one-shot dispatcher need durable transactions and uniqueness constraints across separate HTTP and scheduled processes. Docker Compose provides local MySQL; VPS storage can be a managed database or a backed-up private MySQL volume. Migrations are versioned SQL files.

## Deployment constraints

The runtime Docker image is environment-neutral and is the default build target. VPS Compose requires an immutable GHCR commit-SHA image, a private MySQL volume, HTTPS termination and protected environment variables. Publishing remains disabled by default; no VPS deployment workflow is configured.

## Provider capabilities and MVP limits

Tebar documents immediate publishing and scheduled publishing, idempotency keys, per-target status, scheduled-post cancellation, and Threads insights. Threads profile visits are not among the documented insight metrics. MVP awareness measurement is tracked-link clicks; website and conversion analytics are deferred.
