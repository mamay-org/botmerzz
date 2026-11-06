# Kedai Merzz Threads Marketing Automation — MVP Requirements

## Goal and release boundary

Build a staging-ready dashboard and automation service for publishing approved, AI-assisted Threads text posts for Kedai Merzz. Development may use a developer-owned Tebar account and a separate test Threads account. Production credentials, the client's Threads account, and production posting remain disabled until separate approval and onboarding.

## Confirmed product behavior

- Market: Malaysia. Post language: natural Malaysian Malay, with common English gaming terms allowed.
- Voice: friendly, casual gamer, informative. Content focuses on brand awareness and engagement.
- Content pillars: top-up and Mobile Legends account sales, balanced over time. The client supplies the launch top-up game whitelist during onboarding; AI must not name games outside it. Account sales are Mobile Legends only.
- MVP format: text-only. Images and video are deferred.
- Audience insights: structured manual notes provided by the client. Social listening is out of scope for MVP. The dashboard exposes structured fields, not unrestricted prompt editing.
- Service facts: one editable summary per service, not a detailed inventory. Top-up summaries may include an approved starting denomination and price. Account-sale summaries may include price, availability, and client-approved attributes such as rank or skins. The example “400 Diamond Mobile Legends at MYR 30” is illustrative and must be verified before use.
- Fact freshness: a price or availability fact older than 24 hours is stale and must not be described as current.
- Price/availability modes: OFF, ON, and MIXED. MIXED targets one fact-bearing post per four posts. Missing or stale facts result in evergreen content without prices or availability numbers.
- CTA: all MVP content links to the homepage. Use distinct Tebar tracked links for top-up and account-sale themes. The dashboard shows the provider's 30-day Threads click total when statistics permission and data are available; website analytics and conversion tracking are deferred.
- Publishing: automatic publishing without per-post approval. Automation is disabled by default and may only be enabled after onboarding requirements are complete.
- Cadence: configurable active weekdays/hours, default timezone Asia/Kuala_Lumpur, and minimum interval of six hours. Admin may change timezone. A slot outside an active window is skipped; missed slots are not caught up.
- AI failure: retry content generation once. If generation or validation still fails, skip the slot and record/log the failure.
- Emergency pause: stop future dispatches and attempt to cancel known provider posts that are still scheduled. Show each cancellation result accurately; an in-flight or already published post cannot be represented as canceled.
- Admin: the first administrator is bootstrapped from the CLI. Every active admin has the same dashboard permissions and can create accounts, update email/password, and deactivate/reactivate accounts. Passwords are set directly; first-login rotation and invitation email are not required. Deactivation preserves audit history, cannot target the current admin or the last active admin, and revokes all sessions. Email/password changes revoke all sessions for the affected account.
- Telegram: send AI/publishing/system failures, Threads account disconnection/expiry, and a daily success/failure summary at 22:00 MYT to a private operations group. Never include tokens, passwords, or secret values in messages.
- Provider and operating costs: Tebar is the chosen provider and is owned, managed, and paid for by the developer. Keep development/testing and client production in separate Tebar workspaces and API keys.
- Test account: use the developer's spare Threads profile and a Tebar staging workspace. Do not connect or publish to the client's production account in this implementation.

## Functional requirements

1. Admin can log in, log out, update structured brand knowledge, whitelist top-up games, update service summaries, and configure schedule and price/availability mode.
2. Admin can view automation status, provider account status, upcoming/scheduled posts, post history, safe error details, and audit events.
3. Every application starts with automation disabled. Enabling requires valid schedule settings, timezone, game whitelist, approved guardrails, required service facts, and a connected Threads target.
4. The content engine builds Malay prompts from validated structured inputs, appends the configured tracked homepage link for the selected content pillar, and validates final text before publishing.
5. A provider adapter isolates Tebar details from scheduling and business logic. It supports account lookup, immediate publish, status lookup, scheduled-post cancellation, and documented insights retrieval.
6. Every intended publish slot has a unique durable identifier and idempotency key. The request body and key are stored before calling Tebar. An uncertain network outcome must not trigger a new post blindly; reconcile by provider ID or retry the exact same request with the same idempotency key and body.
7. A one-shot dispatcher claims due slots using a database-backed atomic state transition. Concurrent runs cannot claim the same slot. It respects active windows, the six-hour minimum, no-catch-up behavior, and global pause.
8. Dashboard history stores generation, validation, publish, retry, cancellation, and notification outcomes without storing or displaying provider credentials.
9. Telegram alerts are bounded, retried safely, and redact provider response bodies and secret-like values.
10. Emergency pause disables future job claims first, then attempts cancellation of outstanding Tebar posts. A failed or racing cancellation is shown as pending/unknown rather than canceled.

## Non-functional requirements

- Node.js 20.6 or newer; CommonJS preserves the existing project style and supports both the one-shot dispatcher command and the optional in-process poller.
- MySQL-compatible durable storage shared by the dashboard, dispatcher and scheduler.
- Secrets are read only from environment variables. The local environment file is ignored by Git and the example file contains no credentials.
- HTTPS is required in deployed environments. Sessions use secure, HTTP-only, SameSite cookies, CSRF protection, login throttling, password hashing, and server-side expiry.
- Validate dashboard inputs and provider webhook payloads. Escape user-controlled content in the browser.
- Logs and Telegram messages must not include secrets, full authorization headers, or raw provider response bodies.
- Use Asia/Kuala_Lumpur for product scheduling and daily summaries. Store instants in UTC and convert only at schedule boundaries.
- The app scheduler is opt-in through `SCHEDULER_ENABLED` and polls persisted MySQL jobs. The one-shot command remains available for manual runs or host cron; both paths use the same atomic slot claims.

## Onboarding gates before staging or production publishing

- Client supplies the game whitelist, approved/forbidden claims, Malaysian Malay examples, valid service summaries, account attributes allowed for marketing, active weekdays/hours, homepage/tracked links, and private Telegram group.
- An authorized person connects the selected Threads account through Tebar's official authorization flow and verifies its username in the dashboard.
- Tebar API access and the VPS Docker/Compose runtime and scheduler are verified by the account owner. Confirm the scheduler's minimum interval before promising exact posting times.
- Staging API key, database credentials, OpenRouter key, Telegram token/chat ID, and approved test profile are supplied through the deployment environment. No such credentials are checked into this repository.
- Client approves the initial guardrails and service facts before automation can be enabled.

## Explicitly deferred

Production account linking/publishing, image/video generation, social listening, GA4/conversion analytics, profile-visit analytics, multi-admin roles, live inventory-system integration, and charging the client for Tebar.
