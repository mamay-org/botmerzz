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

function confirmedCompletedAt(status, post, expectedAccountId, observedAt) {
  if (!['published', 'failed', 'partial', 'canceled'].includes(status)) return null;
  if (status === 'published') {
    const target = post?.targets?.find((candidate) => candidate?.accountId === expectedAccountId
      && String(candidate.platform || '').toLowerCase() === 'threads'
      && candidate.status === 'published');
    const publishedAt = target?.publishedAt;
    if (publishedAt) {
      const providerTime = new Date(publishedAt);
      if (Number.isFinite(providerTime.getTime())) return providerTime.toISOString();
    }
  }
  const observedTime = new Date(observedAt);
  return Number.isFinite(observedTime.getTime()) ? observedTime.toISOString() : null;
}

async function providerOutcomeStatus(repository, slot, post, expectedAccountId) {
  const status = providerSlotStatus(post, expectedAccountId);
  if (post.status !== 'canceled' || !slot?.automationSessionId || typeof repository.isAutomationSessionActive !== 'function') return status;
  try { return await repository.isAutomationSessionActive(slot.automationSessionId) ? 'failed' : 'canceled'; }
  catch { return status; }
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

async function cancelIfSessionRevoked({ repository, publisher, slot, post, status, expectedAccountId }) {
  if (!slot?.automationSessionId || typeof repository.isAutomationSessionActive !== 'function') return { post, status, cancellationStatus: null };
  let active;
  try { active = await repository.isAutomationSessionActive(slot.automationSessionId); }
  catch { return { post, status, cancellationStatus: null }; }
  if (active || status !== 'publishing' || !post?.id) {
    return { post, status, cancellationStatus: null };
  }
  let latest = post;
  try {
    latest = await publisher.getPost(post.id);
    status = providerSlotStatus(latest, expectedAccountId);
    if (status !== 'publishing') return { post: latest, status, cancellationStatus: null };
  } catch {
    // The accepted status is still known; leave it unsettled and let reconciliation check again.
  }
  try {
    const canceled = await publisher.cancelPost(post.id);
    return {
      post: canceled,
      status: providerSlotStatus(canceled, expectedAccountId),
      cancellationStatus: canceled.status === 'canceled' ? 'canceled' : canceled.status === 'publishing' ? 'in_flight' : canceled.status,
    };
  } catch (error) {
    return { post: latest, status, cancellationStatus: error?.code === 'post_not_editable' ? 'in_flight' : 'failed' };
  }
}

async function reconcileUnsettled({ repository, publisher, notifier, counts, clock = () => new Date() }) {
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
      const status = await providerOutcomeStatus(repository, slot, post, expectedAccountId);
      const terminal = ['published', 'failed', 'canceled', 'partial'].includes(status);
      const completedAt = terminal ? confirmedCompletedAt(status, post, expectedAccountId, clock()) : null;
      await repository.updateSlot(slot.id, {
        status,
        providerStatus: post.status,
        providerPostId: post.id,
        errorCode: status === 'failed' || status === 'partial' || post.targets?.some((target) => target.status === 'failed') ? 'provider_error' : null,
        completedAt,
      });
      checked++;
      if (counts && status === 'published') {
        counts.published++;
        await sendNotice(notifier, 'post_published', { slotId: slot.id });
      } else if (counts && (status === 'partial' || status === 'failed')) {
        counts.failed++;
        try { await repository.appendActivity({ event: 'publish_failed', slotId: slot.id, details: { code: 'provider_error' } }); } catch { /* The provider status remains durable on the slot. */ }
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
  timezone = 'Asia/Kuala_Lumpur',
  contentGenerator,
  maxPublishAttempts = 2,
} = {}) {
  if (!repository || !publisher || typeof content !== 'function') {
    throw new TypeError('repository, publisher, and content dependencies are required');
  }
  const minimumIntervalHours = 1;
  const now = clock();
  const result = { claimed: 0, published: 0, skipped: 0, failed: 0, unknown: 0, reconciled: 0, summarySent: false };

  let state = await repository.getRuntimeState();
  if (typeof notifier?.flush === 'function') {
    try { await notifier.flush(); } catch { /* Notification retries must not block publishing safety checks. */ }
  }
  result.reconciled = await reconcileUnsettled({ repository, publisher, notifier, counts: result, clock });
  await maybeSendDailySummary({ repository, notifier, now, counts: result });
  if (!state?.automationEnabled || state.onboardingComplete !== true || !state.accountId) return result;

  // A provider request with no definitive state blocks new posts until an
  // operator can reconcile it. This is deliberately fail-closed.
  if ((await repository.listUnsettledSlots()).length > 0) {
    result.unknown++;
    return result;
  }

  let schedule = { ...(state.settings?.schedule || {}), intervalHours: 1 };
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
    for (const failedSlotId of planned?.failedSlotIds || []) {
      result.failed++;
      await sendNotice(notifier, 'generation_failed', { slotId: failedSlotId });
    }
    if (planned && !planned.slot) return result;
  } else {
    throw new TypeError('repository.ensureNextDueSlot is required for atomic slot planning');
  }

  const slot = await repository.claimDueSlot({ now, minimumIntervalHours });
  if (!slot) return result;
  result.claimed = 1;

  const claimedState = await repository.getRuntimeState();
  if (!claimedState?.automationEnabled || claimedState.onboardingComplete !== true || !claimedState.accountId
    || !slot.automationSessionId || claimedState.settings?.automationSessionId !== slot.automationSessionId) {
    await repository.updateSlot(slot.id, { status: 'canceled', errorCode: 'automation_paused', completedAt: clock().toISOString() });
    await repository.appendActivity({ event: 'slot_not_published', slotId: slot.id, details: { code: 'automation_paused' } });
    result.skipped++;
    return result;
  }
  state = claimedState;
  schedule = { ...(state.settings?.schedule || {}), intervalHours: 1 };

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
    if (slot.automationSessionId && typeof repository.isAutomationSessionActive === 'function'
      && !await repository.isAutomationSessionActive(slot.automationSessionId)) {
      result.skipped++;
      return result;
    }
    await repository.updateSlot(slot.id, { status: 'failed', errorCode: code, completedAt: clock().toISOString() });
    await repository.appendActivity({ event: 'ai_generation_failed', slotId: slot.id, details: { code, attempts: Math.min(2, generated?.attempts || 0) } });
    await sendNotice(notifier, code, { slotId: slot.id });
    result.failed++;
    return result;
  }

  if (!isPrepared) {
    idempotencyKey = makeIdempotencyKey(slot);
    payload = { content: generated.text, targets: [{ account_id: state.accountId }] };
    const saved = await repository.savePreparedSlot(slot.id, {
      requestPayload: payload,
      idempotencyKey,
      caption: generated.text,
      pillar: generated.pillar,
      factBearing: generated.factBearing === true,
      factIds: generated.factIds || [],
    });
    if (saved === false) {
      await repository.appendActivity({ event: 'slot_not_published', slotId: slot.id, details: { code: 'automation_paused' } });
      result.skipped++;
      return result;
    }
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
  if (slot.automationSessionId && typeof repository.isAutomationSessionActive === 'function'
    && !await repository.isAutomationSessionActive(slot.automationSessionId)) {
    await repository.updateSlot(slot.id, { status: 'canceled', errorCode: 'automation_paused', completedAt: clock().toISOString() });
    await repository.appendActivity({ event: 'slot_not_published', slotId: slot.id, details: { code: 'automation_paused' } });
    result.skipped++;
    return result;
  }

  let attempt = 0;
  let acceptedPost = null;
  let retryableFailure = null;
  while (attempt < Math.max(1, Math.min(2, maxPublishAttempts))) {
    if (slot.automationSessionId && typeof repository.isAutomationSessionActive === 'function'
      && !await repository.isAutomationSessionActive(slot.automationSessionId)) {
      if (retryableFailure) {
        const code = safeCode(retryableFailure.code);
        await repository.updateSlot(slot.id, { status: 'failed', providerStatus: 'failed', errorCode: code, completedAt: clock().toISOString() });
        await repository.appendActivity({ event: 'publish_failed', slotId: slot.id, details: { code } });
        await sendNotice(notifier, code, { slotId: slot.id });
        result.failed++;
        return result;
      }
      await repository.updateSlot(slot.id, { status: 'canceled', errorCode: 'automation_paused', completedAt: clock().toISOString() });
      await repository.appendActivity({ event: 'slot_not_published', slotId: slot.id, details: { code: 'automation_paused' } });
      result.skipped++;
      return result;
    }
    attempt++;
    try {
      acceptedPost = await publisher.publishNow(payload, idempotencyKey);
      break;
    } catch (error) {
      const providerPostId = typeof error?.providerPostId === 'string' ? error.providerPostId : null;
      if (providerPostId) {
        try {
          const post = await publisher.getPost(providerPostId);
          const status = await providerOutcomeStatus(repository, slot, post, state.accountId);
          const terminal = ['published', 'failed', 'canceled', 'partial'].includes(status);
          await repository.updateSlot(slot.id, { status, providerStatus: post.status, providerPostId, errorCode: status === 'failed' || status === 'partial' ? 'provider_error' : null, completedAt: terminal ? confirmedCompletedAt(status, post, state.accountId, clock()) : null });
          const cancellation = await cancelIfSessionRevoked({ repository, publisher, slot, post, status, expectedAccountId: state.accountId });
          const finalPost = cancellation.post;
          const finalStatus = cancellation.status;
          if (finalPost !== post || cancellation.cancellationStatus) {
            const finalCompletedAt = ['published', 'failed', 'canceled', 'partial'].includes(finalStatus) ? confirmedCompletedAt(finalStatus, finalPost, state.accountId, clock()) : null;
            await repository.updateSlot(slot.id, { status: finalStatus, providerStatus: finalPost.status, providerPostId, errorCode: finalStatus === 'failed' || finalStatus === 'partial' ? 'provider_error' : null, completedAt: finalCompletedAt, ...(cancellation.cancellationStatus ? { cancellationStatus: cancellation.cancellationStatus } : {}) });
          }
          if (cancellation.cancellationStatus) {
            try { await repository.recordCancellation(providerPostId, { status: cancellation.cancellationStatus, errorCode: cancellation.cancellationStatus === 'canceled' ? null : 'post_not_editable' }); } catch { /* The provider state remains durable on the slot. */ }
          }
          if (finalStatus === 'published') { result.published++; await sendNotice(notifier, 'post_published', { slotId: slot.id }); }
          else if (finalStatus === 'failed' || finalStatus === 'partial') { result.failed++; try { await repository.appendActivity({ event: 'publish_failed', slotId: slot.id, details: { code: 'provider_error' } }); } catch { /* Provider outcome is already durable. */ } await sendNotice(notifier, 'provider_error', { slotId: slot.id }); }
          else if (finalStatus === 'canceled') result.skipped++;
          else result.unknown++;
          return result;
        } catch {
          try { await repository.updateSlot(slot.id, { status: 'unknown', providerStatus: 'unknown', providerPostId, errorCode: 'unknown_outcome' }); } catch { /* Preserve the original publishing row for reconciliation. */ }
          try { await repository.appendActivity({ event: 'publish_outcome_unknown', slotId: slot.id, details: { code: 'unknown_outcome' } }); } catch { /* Slot state remains the primary record. */ }
          await sendNotice(notifier, 'unknown_outcome', { slotId: slot.id });
          result.unknown++;
          return result;
        }
      }
      if (error?.unknownOutcome) {
        await repository.updateSlot(slot.id, { status: 'unknown', providerStatus: 'unknown', providerPostId, errorCode: safeCode(error.code) });
        await repository.appendActivity({ event: 'publish_outcome_unknown', slotId: slot.id, details: { code: safeCode(error.code) } });
        await sendNotice(notifier, 'unknown_outcome', { slotId: slot.id });
        result.unknown++;
        return result;
      }
      if (error?.retryable && attempt < Math.max(1, Math.min(2, maxPublishAttempts))) {
        retryableFailure = error;
        if (slot.automationSessionId && typeof repository.isAutomationSessionActive === 'function'
          && !await repository.isAutomationSessionActive(slot.automationSessionId)) {
          await repository.updateSlot(slot.id, { status: 'failed', providerStatus: 'failed', errorCode: safeCode(error?.code), completedAt: clock().toISOString() });
          await repository.appendActivity({ event: 'publish_failed', slotId: slot.id, details: { code: safeCode(error?.code) } });
          await sendNotice(notifier, safeCode(error?.code), { slotId: slot.id });
          result.failed++;
          return result;
        }
        continue;
      }
      await repository.updateSlot(slot.id, { status: 'failed', providerStatus: 'failed', errorCode: safeCode(error?.code), completedAt: clock().toISOString() });
      await repository.appendActivity({ event: 'publish_failed', slotId: slot.id, details: { code: safeCode(error?.code) } });
      await sendNotice(notifier, safeCode(error?.code), { slotId: slot.id });
      result.failed++;
      return result;
    }
  }
  if (acceptedPost) {
    const initialStatus = await providerOutcomeStatus(repository, slot, acceptedPost, state.accountId);
    const initialTerminal = ['published', 'failed', 'canceled', 'partial'].includes(initialStatus);
    const initialUpdate = {
      status: initialStatus,
      providerStatus: acceptedPost.status,
      providerPostId: acceptedPost.id,
      errorCode: initialStatus === 'failed' || initialStatus === 'partial' ? 'provider_error' : null,
      completedAt: initialTerminal ? confirmedCompletedAt(initialStatus, acceptedPost, state.accountId, clock()) : null,
    };
    try {
      // Persist the provider ID before checking the session so a concurrent pause
      // can find and cancel an accepted but not yet published post.
      await repository.updateSlot(slot.id, initialUpdate);
    } catch {
      // Tebar accepted the publish. Database failure must never fall through to a publish retry.
      try {
        await repository.updateSlot(slot.id, { ...initialUpdate, status: 'unknown', providerStatus: acceptedPost.status, errorCode: 'unknown_outcome' });
      } catch {
        // The previously persisted payload and idempotency key remain the recovery evidence.
      }
      await sendNotice(notifier, 'unknown_outcome', { slotId: slot.id });
      result.unknown++;
      return result;
    }
    const cancellation = await cancelIfSessionRevoked({ repository, publisher, slot, post: acceptedPost, status: initialStatus, expectedAccountId: state.accountId });
    const post = cancellation.post;
    const status = cancellation.status;
    if (post !== acceptedPost || cancellation.cancellationStatus) {
      const finalUpdate = {
        status,
        providerStatus: post.status,
        providerPostId: post.id,
        errorCode: status === 'failed' || status === 'partial' ? 'provider_error' : null,
        completedAt: ['published', 'failed', 'canceled', 'partial'].includes(status) ? confirmedCompletedAt(status, post, state.accountId, clock()) : null,
        ...(cancellation.cancellationStatus ? { cancellationStatus: cancellation.cancellationStatus } : {}),
      };
      try { await repository.updateSlot(slot.id, finalUpdate); }
      catch {
        await repository.updateSlot(slot.id, { ...finalUpdate, status: 'unknown', errorCode: 'unknown_outcome' }).catch(() => {});
        await sendNotice(notifier, 'unknown_outcome', { slotId: slot.id });
        result.unknown++;
        return result;
      }
    }
    if (cancellation.cancellationStatus) {
      try { await repository.recordCancellation(post.id, { status: cancellation.cancellationStatus, errorCode: cancellation.cancellationStatus === 'canceled' ? null : 'post_not_editable' }); }
      catch { /* The durable slot status still records whether Tebar published or canceled it. */ }
    }
    try {
      await repository.appendActivity({ event: status === 'published' ? 'post_published' : status === 'failed' || status === 'partial' ? 'publish_failed' : status === 'canceled' ? 'publish_canceled_after_pause' : 'publish_accepted', slotId: slot.id, details: { status, providerPostId: post.id } });
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
