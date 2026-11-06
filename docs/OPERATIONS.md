# Operations

## Start, stop and health

Use the matching Compose project and file to start or stop services while preserving the named database volume. Do not use `down -v` unless intentionally deleting that environment's database. Check application health at `/health/live` and `/health/ready`; readiness includes scheduler enabled/running state and the last safe result code. Inspect logs with `docker compose logs --tail=200 app` and `docker compose logs --tail=200 db`.

## Recovery

If readiness fails, inspect database health and application logs first. Restarting the app is safe because schedule claims and publication idempotency are stored in MySQL. The poller skips work missed by more than 15 minutes. A slot with an uncertain outcome and no provider post ID blocks later publishing; do not replay it. Verify it in Tebar and the target Threads account, then resolve the slot through a reviewed operator procedure before resuming automation.

## Emergency pause

Use the authenticated dashboard emergency-pause control. It disables future slot claims before attempting cancellation of provider-scheduled posts. Review each cancellation result; in-flight or already published content cannot be treated as canceled. If the dashboard is unavailable, set `SCHEDULER_ENABLED=false` and stop the app using Compose; use a reviewed database procedure only if the automation flag also needs to be disabled. Reconcile existing provider posts before resuming.

## Secrets and incidents

Keep the VPS environment file outside source control and restrict it to the deployment account (`0600`). Rotate a leaked credential at its provider, update the deployment environment, restart affected services and inspect audit/application logs. Notifications and logs should contain safe error codes, never provider response bodies, passwords, tokens or full connection strings. Apply request limits for dashboard login and Tebar webhooks at the HTTPS reverse proxy.

## Daily operations

Review the 22:00 MYT Telegram summary, confirmed publishing notices, failed/unknown slots, account connection status, stale product facts, disk/database backup status, and image version. Telegram notifications retry from the database outbox during later scheduler polls; check pending or failed outbox rows if a message does not arrive. Confirm automation remains disabled until onboarding is complete and a human has verified the intended test account and provider workspace.
