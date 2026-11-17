# Manual Publication Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe administrator workflow for unresolved Threads publications and provider-scoped automation holds that let later safe slots continue without replaying uncertain posts.

**Architecture:** Keep provider outcome (`provider_status`) truthful and add the terminal application status `admin_closed_unknown`. Record decisions in an append-only resolution table with an idempotency key, while slot updates and audit records happen in one transaction after a row lock and state recheck. Provider-post linking uses a read-only GET against the slot's immutable profile and account; scheduler dispatch does not resume from a manual action and does not replay a closed slot.

**Tech Stack:** Node.js 20, Express 5, MySQL 8.4, browser JavaScript, Node test runner.

**Spec:** `/Users/macbookpro/.codex/attachments/1aaffe58-e063-47dd-b256-39030e6fccae/Pasted text.txt`

## Global Constraints

- Do not change a production database, resolve a production slot, publish to Threads, enable scheduler or automation, deploy, push to `main`, or delete historical data.
- Keep all edits within this development workspace and preserve all pre-existing local changes.
- Never retry or republish a slot whose provider outcome is unknown or which an administrator closed as unverified.
- Preserve slot payload, idempotency key, original profile/account target, and provider status during manual closure.
- Manual closure must not enable automation or invoke the scheduler.
- A provider-post link must use a read-only provider GET and match the original profile, account, platform, and published target before it is saved.
- Keep account switching paused until all relevant blockers are terminal; automation remains off after a switch.
- Do not log credentials, tokens, raw provider responses, or caption payloads.
- Use mock providers and disposable MySQL only; never make a live Threads publish request.
- Preserve the Proxmox homelab, Cloudflare Tunnel, Traefik, Docker Compose, and existing volume/environment configuration.

---

## File Map

- `migrations/020_manual_publication_resolution.sql`: add the terminal slot status constraint, append-only manual resolution records, and persistent provider-scoped holds; use conditional DDL so a partially applied migration can be retried.
- `src/repository.js`: list blockers, close or link a slot transactionally, expose resolution history/holds, and include the new terminal state in terminal guards and reports.
- `src/http/routes/publication-resolution.js`: strict admin/CSRF-protected read and mutation endpoints.
- `src/server.js`, `src/cli.js`: register routes and inject only safe GET verification plus notifier dependencies.
- `src/dispatcher.js`, `src/configuration-providers.js`, `src/http/routes/integrations.js`: persist and enforce provider-scoped authentication holds; successful explicit validation clears only the matching hold.
- `public/index.html`, `public/app.js`, `public/styles.css`: show all blockers, original target/time/error/evidence, explicit delayed-publication warning, reason/evidence inputs, and resolution outcomes using text nodes.
- `src/telegram-format.js`: report administrator-closed unresolved outcomes separately from confirmed failures.
- `docs/publication-resolution-runbook.md`: describe manual review, link-vs-close decisions, scheduler/account-switch recovery, and delayed-publication risk.
- `test/publication-resolution*.test.js`, `test/dispatcher.test.js`, `test/integrations-ui.test.js`, `test/telegram-format.test.js`: cover API security, concurrency/idempotency, replay safety, scoped holds, account switching, analytics, and UI safety.

## Task 1: Manual Resolution Storage and API

**Interfaces:**

- `GET /api/publication-resolution/slots` returns `{slots, events}` for unresolved publication blockers with `id`, `caption`, `scheduledAt`, `publishStartedAt`, `profileId`, `accountId`, `providerStatus`, `providerPostId`, `errorCode`, and terminal-resolution metadata.
- `POST /api/publication-resolution/:slotId/close-unverified` accepts exactly `{requestId, reason, evidenceSummary, confirmDelayedPublication}`; the confirmation must be `true`.
- `POST /api/publication-resolution/:slotId/link-provider-post` accepts exactly `{requestId, providerPostId, reason, evidenceSummary, confirmOriginalTarget}`; a server-side GET must confirm a published Threads target for the slot's immutable profile/account.
- Repository methods: `listPublicationBlockers()`, `closeUnknownPublication({slotId, requestId, actorId, actorEmail, reason, evidenceSummary})`, `linkVerifiedProviderPost({...})`, and `listPublicationResolutionEvents({slotIds})`.

- [x] Write route tests for authentication, CSRF/origin, exact input shape, explicit warning acknowledgment, missing reason/evidence, and provider GET never calling `publishNow`.
- [x] Write repository MySQL tests for unknown/no-ID closure, preserved payload/key/target/provider status, append-only event and audit entry, repeated request ID, different concurrent requests, changed-state conflict, and verified link identity matching.
- [x] Run focused mocked route/repository tests. The MySQL suite is guarded and was skipped because no isolated MySQL 8.4 service was available; the test assertions were not run against MySQL.
- [ ] Run the publication-resolution suite against disposable MySQL 8.4 and verify the DDL restart/concurrency behaviors there. No production DB was used.
- [x] Implement migration 020 with conditional status-constraint update and append-only event/hold tables. Actual MySQL execution and restart-after-individual-DDL verification remain pending the disposable 8.4 rehearsal above.
- [x] Implement row-locked, state-checked, idempotent repository methods. Closure changes only slot status, completion timestamp, and administrative metadata; it keeps `provider_status='unknown'`, `error_code`, request payload, idempotency key, profile, and account unchanged.
- [x] Implement admin routes with bounded strings, UUID request IDs, provider ID validation, authenticated and CSRF middleware, safe error codes, and no scheduler trigger.
- [x] Run focused route tests and the full mocked suite. MySQL integration remains pending the disposable 8.4 rehearsal above.

## Task 2: Provider Holds and Scheduler Continuity

**Interfaces:**

- Persist an OpenRouter authentication hold with scope `global` and a Tebar authentication/permission hold keyed to the exact profile/account.
- `repository.listActiveProviderHolds({profileId, accountId})` returns only global holds and holds matching the active target.
- Successful account/model validation clears only its exact hold and writes an audit event.
- Dispatcher returns before creating/claiming a new slot while the active target has a hold; it still performs ordinary non-mutating reconciliation first.

- [x] Add tests proving AI authentication failure terminalizes one generation slot, records a global hold, and prevents later claims; a successful model validation clears it.
- [x] Add tests proving a definitive Tebar auth/permission response terminalizes the current slot, records only that account's hold, and does not block another account; successful validation clears only the matching account hold.
- [x] Add tests proving network/timeout errors are not misclassified as definitive auth holds, unknown outcomes stay non-replayable, automation OFF stays OFF, pending account switch stays fail-closed, and normal cadence resumes without catch-up after blockers/holds clear.
- [x] Implement allowlisted structured failure metadata in logs (`provider`, safe code, HTTP status, transport code, timeout flag) without raw error text, credentials, or content.
- [x] Enforce holds in the dispatcher before slot planning/claiming; preserve existing single-claim locking, durable idempotency, and skipped missed-slot behavior.
- [x] Clear holds only after successful explicit provider validation and show active holds with their scope/recovery action in integration state.
- [x] Run dispatcher, integration, scheduler, and full mocked test suites.

## Task 3: Dashboard Recovery Workflow

- [x] Add a dashboard panel listing every unresolved blocker and its original account, attempted time, provider state, error code, and caption.
- [x] Render close and link actions only when state permits; offer GET-only reconciliation for linked `unknown` rows, and disable close/link for `publishing`, already-linked, or terminal slots.
- [x] Require a reason and evidence summary, then a second explicit confirmation warning that delayed publication remains possible.
- [x] Generate a UUID request ID client-side for idempotent submission; render all server text through `textContent` and refresh state after mutations.
- [x] Show every remaining account-switch blocker and keep the existing account verification/reconciliation action separate from slot closure.
- [x] Add UI contract and interaction tests for confirmation, escaping, disabled-state, response-loss, retry reconciliation, and exact-ID search paths.
- [x] Run UI tests and inspect modified HTML/CSS/JS for accessibility and mobile layout.

## Task 4: Analytics, Notifications, and Recovery Documentation

- [x] Add an `adminClosedUnknown` daily count that is separate from provider `failed`, `published`, and still-`unknown`; update Telegram daily formatting without affecting success rate.
- [x] Ensure Learning Center effectiveness/quality and candidate training continue to include only confirmed published outcomes; do not convert manual closure into a negative model outcome.
- [x] Queue a deduplicated administrative-resolution notice through the existing notification outbox; do not call Threads publish or trigger the scheduler.
- [x] Document rechecking the exact original account/time in Tebar and Threads, choosing between verified ID linking and unverified closure, and resuming account switch only after all blockers are terminal. Include late-link retry and lookup for older closed slots.
- [x] Add analytics/notification regression tests and run the focused test suites plus the full mocked suite.
- [x] Review the publication-resolution changes and final test/check output. Production deployment remains NO-GO until the MySQL 8.4 disposable migration rehearsal, backup/restore rehearsal, homelab compatibility checks, and separate production approval are complete.
