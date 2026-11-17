# Publication Resolution Runbook

This runbook covers an unresolved Threads publication whose provider response was lost or could not be verified. An `unknown` result is not proof that Tebar rejected the request; the post may appear later.

## Review Before Acting

1. Pause account changes and keep automation off while reviewing an unresolved publication.
2. Open the blocker in **Integrasi Tebar**. Review its immutable profile ID, account ID, caption, attempt time, provider status, and error code. If the original target is missing or conflicts with the saved request, do not link a provider ID; the dashboard exposes only the audited close action for that row.
3. Search Tebar post history and the exact original Threads account around the attempt time. Repeat the search after a short delay if a request may still be processing. Do not use the replacement account to search for the old post.
4. If a matching published Threads post is found, use **Link verified post ID**. Enter the provider post ID and evidence. The server performs a read-only GET and accepts the link only when the returned published Threads target matches the slot's original profile/account. Normal reconciliation then records the provider outcome. If the first check remains `unknown` or cannot finish, use **Periksa ulang status Tebar** on the linked row to retry the GET against that same original profile/account; retry later if Tebar still has no final status.
5. If no matching post is found after the operator's checks, use **Close as Unverified — Not Found** only after recording a reason and evidence summary and acknowledging that delayed publication remains possible. This is an administrative terminal decision, not a provider-confirmed failure. For a legacy row without a valid original target, the audit record retains whatever target fields are available (including NULL) and provider-ID linking remains unavailable unless a valid original target can be established.
6. If a post appears after closure, open the **Publikasi terlambat ditemukan** follow-up list and use **Kaitkan ID post tanpa mengirim ulang**. The server rechecks the ID on the original profile and account before appending a second audit event and returning the slot to `unknown` with the ID attached. Normal read-only reconciliation then checks its provider state. If that first reconciliation remains `unknown` or fails, use **Periksa ulang status Tebar** on the linked row to retry the GET on the same original target. The follow-up list shows the 100 most recently closed slots; use its exact **Slot ID** search to find an older closed slot. This path never sends a post; if Tebar cannot confirm the exact published Threads target, the slot stays closed and the operator must not try to reopen it manually.

## State and Safety Rules

- `admin_closed_unknown` means the application has closed the slot after administrator review while the provider outcome remains unverified. `provider_status` stays `unknown`; the original error, caption, request payload, idempotency key, and account target remain available for audit. A later provider-verified post ID can append a separate link event and return the slot to `unknown` for normal reconciliation; the closure event is retained.
- Closed slots are terminal for dispatch and are never sent again. The closure endpoint does not call the scheduler, create a new slot, or enable automation.
- Linking a real post ID only makes read-only provider reconciliation possible. It does not publish or cancel provider content.
- A linked `unknown` slot can be explicitly checked again from its dashboard row. The action validates the existing provider ID and immutable target, then calls only the read-only reconciliation service; it cannot publish or change the target scope.
- The closed-slot follow-up defaults to the 100 newest rows. Exact Slot ID search can retrieve a single older closed row without removing the default list cap.
- Every remaining `unknown`, `publishing`, or known scheduled/draft provider post must be reviewed. Account switching remains blocked while any relevant blocker remains. Continue the existing account reconciliation only after that list is clear.
- Before the POST, the dispatcher takes MySQL locks on the automation settings, active integration target, and slot. It holds them through the provider request until the initial outcome or provider ID is stored. Admin closure uses the same settings and slot locks; stale recovery locks the selected slot row, so it serializes with those operations through the slot lock. A worker that resumes after a committed close fails the fence check before the provider call.
- Reconciliation converts any `publishing` slot with no provider ID to `unknown` only after it has been stale for at least two minutes. Tebar requests time out at 30 seconds; the extra margin avoids treating a normal in-flight request as abandoned. The transition is logged, preserves any saved target/payload/key, and never retries the POST. Legacy rows with incomplete snapshots become close-only blockers; review and resolve them through the dashboard.
- Completing an account switch leaves automation off. Verify the new Threads profile/account and explicitly enable automation later. The regular scheduler follows its next normal cadence; it does not bulk-catch-up missed slots.
- An OpenRouter authentication hold is global because the credential is shared. A Tebar authentication/permission hold is limited to the exact profile/account. Clear a hold only after successful provider validation; enabling automation alone does not clear a hold.
- A manual closure is excluded from confirmed provider failure and Learning Center outcome samples. Only confirmed published posts feed publication quality analytics.

## `network_error` Interpretation

The Tebar adapter reports `network_error` when an HTTP response status is unavailable. That can mean timeout, DNS or connection failure, TLS/socket interruption, or another transport error. It cannot establish whether Tebar received the request. Historical records contain the normalized code but do not retain a transport code or raw provider response, so the original slot cannot be classified more narrowly from that row alone. New safe logs may include an allowlisted transport code, HTTP status, and timeout flag without storing credentials, response bodies, or caption payloads.

## Deployment Preflight (Separate Approval Required)

Deployment is **NO-GO** until all of these checks pass and a separate production deployment approval is given:

- Confirm the current BotMerzz app, scheduler, database, Compose project, `.env`, and persistent MySQL volume inside Proxmox LXC `10027`; do not infer production values from templates.
- Take and verify an encrypted off-host MySQL backup before applying the additive migration.
- Rehearse migration 020 on a disposable MySQL 8.4 copy of the current schema and data shape. Verify that restart/retry leaves one status constraint, both new tables, and no changed slot history.
- Review the exact production `SHOW CREATE TABLE slots` constraint name and migration preconditions before running the release. Do not run migrations from this development session.
- Confirm the app-only in-place release preserves the existing Compose project, MySQL volume, `.env`, scheduler setting, automation flag, Cloudflare Tunnel, and Traefik routes. Do not start a second scheduler or recreate the database service.
- Do not activate the legacy GHCR/VPS workflow, change ingress, prune volumes, or use `docker compose down -v`.
- Keep scheduler disabled during initial code/schema verification. Review the blocker panel and holds before deciding whether to restore scheduler operation. Automation must remain off until the new Threads account is verified and an administrator explicitly enables it.
- Verify `/health/ready`, migration version, manual-resolution audit rows, account-switch state, notification outbox, and that a closed slot remains terminal after an application restart. Use mock providers for all publication tests.
- Keep the previous app image and schema backup available. An app rollback does not reverse migration 020; do not run old application code after `admin_closed_unknown` rows exist unless a compatibility rollback has been separately tested.

Deployment remains **NO-GO** if the migration rehearsal, backup restore check, target identity review, or explicit production approval is missing.
