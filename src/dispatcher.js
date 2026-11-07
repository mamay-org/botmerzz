'use strict';

const { DateTime } = require('luxon');
const { randomUUID } = require('node:crypto');
const { isInActiveWindow } = require('./policy');
const DAILY_SUMMARY_TIMEZONE = 'Asia/Kuala_Lumpur';

const SAFE_ERROR_CODES = new Set([
  'account_expired', 'account_disconnected', 'account_not_found', 'unauthorized',
  'rate_limited', 'network_error', 'invalid_response', 'provider_error',
  'generation_failed', 'content_validation_failed', 'onboarding_incomplete',
  'automation_paused', 'cancel_failed', 'post_not_editable', 'unknown_outcome',
  'post_published',
]);

function safeCode(value) {
  return SAFE_ERROR_CODES.has(value) ? value : 'system_error';
}

function providerSlotStatus(post, expectedAccountId) {
  if (post.status === 'published') {
    const confirmed = post.targets?.some((target) => target.accountId === expectedAccountId && target.status === 'published');
    return confirmed ? 'published' : 'unknown';
  }
  if (post.status === 'failed' || post.status === 'canceled') return post.status;
  if (post.status === 'partial') return 'partial';
  return 'publishing';
}

function makeIdempotencyKey(slot) {
  const id = String(slot.id || randomUUID()).replace(/[^A-Za-z0-9_-]/g, '_');
  return `km_${id}`.slice(0, 128);
}

async function sendNotice(notifier, code, details = {}) {
  if (!notifier || typeof notifier.send !== 'function') return false;
  const slotText = details.slotId ? ` Slot: ${String(details.slotId).slice(0, 36)}.` : '';
  try {
    await notifier.send(`Kedai Merzz automation: ${safeCode(code)}.${slotText}`, details.slotId ? `${safeCode(code)}:slot:${details.slotId}` : undefined);
    return true;
  } catch {
    return false;
  }
}

async function reconcileUnsettled({ repository, publisher, notifier, counts }) {
  const slots = await repository.listUnsettledSlots();
  let checked = 0;
  for (const slot of slots) {
    if (!slot.providerPostId && (!slot.requestPayload || !slot.idempotencyKey)) continue;
    try {
      // Without a provider ID, status is ambiguous. Never replay a mutation here:
      // the original request may not have reached Tebar, so replay could create
      // the first post after a pause or a restart.
      if (!slot.providerPostId) continue;
      const post = await publisher.getPost(slot.providerPostId);
      const expectedAccountId = slot.requestPayload?.targets?.[0]?.account_id;
      const status = providerSlotStatus(post, expectedAccountId);
      await repository.updateSlot(slot.id, {
        status,
        providerStatus: post.status,
        providerPostId: post.id,
        errorCode: post.targets?.some((target) => target.status === 'failed') ? 'provider_error' : null,
        completedAt: ['published', 'failed', 'canceled', 'partial'].includes(status) ? new Date().toISOString() : null,
      });
      checked++;
      if (counts && status === 'published') {
        counts.published++;
        await sendNotice(notifier, 'post_published', { slotId: slot.id });
      } else if (counts && (status === 'partial' || status === 'failed')) {
        counts.failed++;
        await sendNotice(notifier, 'provider_error', { slotId: slot.id });
      } else if (counts && status === 'unknown') counts.unknown++;
    } catch {
      // Preserve the unknown state and exact persisted request for a later safe reconciliation.
    }
  }
  return checked;
}

async function runDispatcher({
  repository,
  content,
  publisher,
  notifier,
  clock = () => new Date(),
  minimumIntervalHours = 1,
  timezone = 'Asia/Kuala_Lumpur',
  contentGenerator,
  maxPublishAttempts = 2,
} = {}) {
  if (!repository || !publisher || typeof content !== 'function') {
    throw new TypeError('repository, publisher, and content dependencies are required');
  }
  const now = clock();
  const result = { claimed: 0, published: 0, skipped: 0, failed: 0, unknown: 0, reconciled: 0, summarySent: false };

  const state = await repository.getRuntimeState();
  if (typeof notifier?.flush === 'function') {
    try { await notifier.flush(); } catch { /* Notification retries must not block publishing safety checks. */ }
  }
  result.reconciled = await reconcileUnsettled({ repository, publisher, notifier, counts: result });
  await maybeSendDailySummary({ repository, notifier, now, counts: result });
  if (!state?.automationEnabled || state.onboardingComplete !== true || !state.accountId) return result;

  // A provider request with no definitive state blocks new posts until an
  // operator can reconcile it. This is deliberately fail-closed.
  if ((await repository.listUnsettledSlots()).length > 0) {
    result.unknown++;
    return result;
  }

  const schedule = state.settings?.schedule || {};
  if (typeof repository.ensureNextDueSlot === 'function') {
    const planned = await repository.ensureNextDueSlot({
      now,
      timezone: schedule.timezone || timezone,
      schedule,
    });
    if (planned?.skippedCount > 0) {
      result.skipped += planned.skippedCount;
      await repository.appendActivity({ event: 'missed_slots_skipped', details: { count: planned.skippedCount } });
    }
    if (planned && !planned.slot) return result;
  } else {
    throw new TypeError('repository.ensureNextDueSlot is required for atomic slot planning');
  }

  const slot = await repository.claimDueSlot({ now, minimumIntervalHours });
  if (!slot) return result;
  result.claimed = 1;

  if (schedule && !isInActiveWindow(slot.scheduledAt || now, schedule)) {
    await repository.updateSlot(slot.id, { status: 'skipped', errorCode: 'outside_active_window', completedAt: now.toISOString() });
    await repository.appendActivity({ event: 'slot_skipped', slotId: slot.id, details: { code: 'outside_active_window' } });
    result.skipped++;
    return result;
  }

  let generated;
  let payload;
  let idempotencyKey;
  const isPrepared = slot.status === 'ready' && slot.requestPayload && typeof slot.idempotencyKey === 'string';
  if (isPrepared) {
    // A crash after persistence but before publishing must replay the exact durable request.
    payload = slot.requestPayload;
    idempotencyKey = slot.idempotencyKey;
    generated = { status: 'ready', text: slot.caption || payload.content, pillar: slot.pillar, factBearing: slot.factBearing === true, factIds: slot.factIds || [] };
  } else if (slot.status === 'unknown' || slot.status === 'publishing') {
    await repository.updateSlot(slot.id, { status: 'unknown', providerStatus: 'unknown', errorCode: 'unknown_outcome' });
    result.unknown++;
    return result;
  } else {
    try {
      generated = await content({
        ...state,
        now,
        history: state.history || [],
        facts: state.facts || [],
        slot,
      }, contentGenerator ? { generate: contentGenerator } : undefined);
    } catch {
      generated = { status: 'skipped', reason: 'GENERATION_FAILED', attempts: 2 };
    }
  }
  if (!generated || generated.status !== 'ready' || typeof generated.text !== 'string') {
    const code = generated?.reason === 'CONTENT_VALIDATION_FAILED' ? 'content_validation_failed'
      : generated?.reason === 'ONBOARDING_INCOMPLETE' ? 'onboarding_incomplete' : 'generation_failed';
    await repository.updateSlot(slot.id, { status: 'skipped', errorCode: code, completedAt: now.toISOString() });
    await repository.appendActivity({ event: 'ai_generation_failed', slotId: slot.id, details: { code, attempts: Math.min(2, generated?.attempts || 0) } });
    await sendNotice(notifier, code, { slotId: slot.id });
    result.skipped++;
    return result;
  }

  if (!isPrepared) {
    idempotencyKey = makeIdempotencyKey(slot);
    payload = { content: generated.text, targets: [{ account_id: state.accountId }] };
    await repository.savePreparedSlot(slot.id, {
      requestPayload: payload,
      idempotencyKey,
      caption: generated.text,
      pillar: generated.pillar,
      factBearing: generated.factBearing === true,
      factIds: generated.factIds || [],
    });
  }

  const started = await repository.startPublishing(slot.id, { now, minimumIntervalHours });
  if (started === 'minimum_cadence') {
    await repository.appendActivity({ event: 'cadence_cooldown_wait', slotId: slot.id, details: { code: 'minimum_cadence' } });
    result.skipped++;
    return result;
  }
  if (!started) {
    await repository.updateSlot(slot.id, { status: 'canceled', errorCode: 'automation_paused', completedAt: now.toISOString() });
    await repository.appendActivity({ event: 'slot_not_published', slotId: slot.id, details: { code: 'automation_paused' } });
    result.skipped++;
    return result;
  }

  let attempt = 0;
  let acceptedPost = null;
  while (attempt < Math.max(1, Math.min(2, maxPublishAttempts))) {
    attempt++;
    try {
      acceptedPost = await publisher.publishNow(payload, idempotencyKey);
      break;
    } catch (error) {
      const providerPostId = typeof error?.providerPostId === 'string' ? error.providerPostId : null;
      if (providerPostId) {
        try {
          const post = await publisher.getPost(providerPostId);
          const status = providerSlotStatus(post, state.accountId);
          await repository.updateSlot(slot.id, { status, providerStatus: post.status, providerPostId, errorCode: null });
          result[status === 'published' ? 'published' : status === 'failed' ? 'failed' : 'unknown']++;
          if (status === 'published') await sendNotice(notifier, 'post_published', { slotId: slot.id });
          return result;
        } catch {
          // Keep the provider ID and mark the outcome unknown for the next reconciliation run.
        }
      }
      if (error?.unknownOutcome) {
        await repository.updateSlot(slot.id, { status: 'unknown', providerStatus: 'unknown', providerPostId, errorCode: safeCode(error.code) });
        await repository.appendActivity({ event: 'publish_outcome_unknown', slotId: slot.id, details: { code: safeCode(error.code) } });
        await sendNotice(notifier, 'unknown_outcome', { slotId: slot.id });
        result.unknown++;
        return result;
      }
      if (error?.retryable && attempt < Math.max(1, Math.min(2, maxPublishAttempts))) continue;
      await repository.updateSlot(slot.id, { status: 'failed', providerStatus: 'failed', errorCode: safeCode(error?.code), completedAt: clock().toISOString() });
      await repository.appendActivity({ event: 'publish_failed', slotId: slot.id, details: { code: safeCode(error?.code) } });
      await sendNotice(notifier, safeCode(error?.code), { slotId: slot.id });
      result.failed++;
      return result;
    }
  }
  if (acceptedPost) {
    const status = providerSlotStatus(acceptedPost, state.accountId);
    const update = {
      status,
      providerStatus: acceptedPost.status,
      providerPostId: acceptedPost.id,
      errorCode: status === 'failed' ? 'provider_error' : null,
      completedAt: ['published', 'failed', 'canceled', 'partial'].includes(status) ? clock().toISOString() : null,
    };
    try {
      await repository.updateSlot(slot.id, update);
    } catch {
      // Tebar accepted the publish. Database failure must never fall through to a publish retry.
      try {
        await repository.updateSlot(slot.id, { ...update, status: 'unknown', providerStatus: acceptedPost.status, errorCode: 'unknown_outcome' });
      } catch {
        // The previously persisted payload and idempotency key remain the recovery evidence.
      }
      await sendNotice(notifier, 'unknown_outcome', { slotId: slot.id });
      result.unknown++;
      return result;
    }
    try {
      await repository.appendActivity({ event: status === 'published' ? 'post_published' : 'publish_accepted', slotId: slot.id, details: { status, providerPostId: acceptedPost.id } });
    } catch {
      // Activity logging is secondary to the durable slot state.
    }
    if (status === 'published') {
      result.published++;
      await sendNotice(notifier, 'post_published', { slotId: slot.id });
    }
    else if (status === 'failed' || status === 'partial') {
      result.failed++;
      await sendNotice(notifier, 'provider_error', { slotId: slot.id });
    } else if (status === 'unknown') {
      result.unknown++;
      await sendNotice(notifier, 'unknown_outcome', { slotId: slot.id });
    }
  }
  return result;
}

async function maybeSendDailySummary({ repository, notifier, now, counts }) {
  const timezone = DAILY_SUMMARY_TIMEZONE;
  const local = DateTime.fromJSDate(now instanceof Date ? now : new Date(now), { zone: 'utc' }).setZone(timezone);
  if (!local.isValid || local.hour < 22) return;
  const localDate = local.toISODate();
  if (!await repository.claimDailySummary({ localDate, timezone })) return;
  try {
    const summary = await repository.getDailySummary({ localDate, timezone });
    if (!notifier || typeof notifier.send !== 'function') {
      await repository.finishDailySummary({ localDate, timezone, status: 'failed' });
      return;
    }
    await notifier.send(`Kedai Merzz · Ringkasan ${localDate} (${timezone})\nBerjaya: ${Number(summary.published) || 0}\nGagal: ${Number(summary.failed) || 0}\nDilangkau: ${Number(summary.skipped) || 0}`, `daily-summary:${localDate}:${timezone}`);
    await repository.finishDailySummary({ localDate, timezone, status: 'sent' });
    counts.summarySent = true;
  } catch {
    await repository.finishDailySummary({ localDate, timezone, status: 'failed' });
  }
}

async function pauseAutomation({ repository, publisher, notifier, accountId, adminId } = {}) {
  if (!repository || !publisher) throw new TypeError('repository and publisher dependencies are required');
  await repository.setAutomationEnabled(false, adminId);
  await repository.appendActivity({ event: 'automation_paused', details: { actor: adminId ? 'admin' : 'system' } });
  const known = new Set((await repository.listUnsettledSlots()).map((slot) => slot.providerPostId).filter(Boolean));
  const outcomes = [];
  let cursor;
  try {
    do {
      const page = await publisher.listScheduledPosts({ accountId, cursor, limit: 100 });
      for (const post of page.data) {
        if (!known.has(post.id) || post.status !== 'scheduled' && post.status !== 'draft') continue;
        try {
          const canceled = await publisher.cancelPost(post.id);
          const status = canceled.status === 'canceled' ? 'canceled' : canceled.status === 'publishing' ? 'in_flight' : canceled.status;
          await repository.recordCancellation(post.id, { status, errorCode: status === 'canceled' ? null : 'post_not_editable' });
          outcomes.push({ postId: post.id, status });
        } catch (error) {
          const status = error?.code === 'post_not_editable' ? 'in_flight' : 'failed';
          await repository.recordCancellation(post.id, { status, errorCode: safeCode(error?.code || 'cancel_failed') });
          outcomes.push({ postId: post.id, status });
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
  } catch (error) {
    outcomes.push({ status: 'listing_failed', errorCode: safeCode(error?.code) });
  }
  const failed = outcomes.some((entry) => !['canceled'].includes(entry.status));
  if (failed) await sendNotice(notifier, 'cancel_failed');
  return { enabled: false, outcomes };
}

module.exports = { runDispatcher, pauseAutomation, reconcileUnsettled, maybeSendDailySummary, safeCode };
