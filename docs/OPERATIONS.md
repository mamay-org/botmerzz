# Operations

## Start, stop and health

Use `docker compose up -d --wait` to start and `docker compose down` to stop while preserving the named database volume. Do not use `docker compose down -v` unless intentionally deleting local database data. Check application health at `/health/live` and `/health/ready`; inspect logs with `docker compose logs --tail=200 app` and `docker compose logs --tail=200 db`.

## Recovery

If readiness fails, inspect database health and application logs first. Restarting the app is safe because schedule claims and publication idempotency are stored in MySQL. Do not manually replay a publish request after an unknown provider outcome; reconcile its saved slot and idempotency key with Tebar first. Keep automation paused while restoring provider access or investigating an uncertain publish.

## Emergency pause

Use the authenticated dashboard emergency-pause control. It disables future slot claims before attempting cancellation of provider-scheduled posts. Review each cancellation result; in-flight or already published content cannot be treated as canceled. If the dashboard is unavailable, stop the app dispatcher and disable automation in the database only using a reviewed operational procedure, then reconcile existing provider posts before resuming.

## Secrets and incidents

Keep `.env` outside source control and restrict it to the deployment account. Rotate a leaked credential at its provider, update the deployment environment, restart affected services and inspect audit/application logs. Notifications and logs should contain safe error codes, never provider response bodies, passwords, tokens or full connection strings.

## Daily operations

Review the 22:00 MYT Telegram summary, failed/unknown slots, account connection status, stale product facts, disk/database backup status, and image version. Telegram notifications retry from the database outbox during later dispatcher runs; check pending or failed outbox rows if a message does not arrive. Confirm automation remains disabled until onboarding is complete and a human has verified the intended test account and provider workspace.
