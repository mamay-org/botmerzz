'use strict';

const { DateTime } = require('luxon');
const { randomUUID } = require('node:crypto');
const { isInActiveWindow } = require('./policy');
const { contentSafetyHash, legacyContentSafetyHash } = require('./content-safety');
const { formatSlotNotice, formatDailyReport } = require('./telegram-format');
const DAILY_SUMMARY_TIMEZONE = 'Asia/Kuala_Lumpur';

const SAFE_ERROR_CODES = new Set([
  'account_expired', 'account_disconnected', 'account_not_found', 'unauthorized',
  'rate_limited', 'network_error', 'invalid_response', 'provider_error',
  'generation_failed', 'content_validation_failed', 'onboarding_incomplete',
  'automation_paused', 'cancel_failed', 'post_not_editable', 'unknown_outcome',
  'post_published', 'permission_missing', 'profile_not_found',
]);
const SAFE_DIAGNOSTIC_CODES = new Set([
  'invalid_settings', 'approved_content_invalid', 'onboarding_incomplete', 'content_validation_failed',
  'tebar_not_configured',
  'ai_not_configured', 'ai_invalid_request', 'ai_unauthorized', 'ai_rate_limited',
  'ai_provider_error', 'ai_network_error', 'ai_invalid_response', 'ai_request_failed',
  'content_service_error', 'stale_generation', 'stale_facts',
]);
const PROVIDER_HOLD_CODES = new Set(['unauthorized', 'permission_missing', 'account_expired', 'account_disconnected', 'account_not_found', 'profile_not_found']);
const SAFE_TRANSPORT_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'EPIPE', 'ERR_NETWORK', 'ERR_CANCELED', 'ERR_BAD_REQUEST', 'ERR_BAD_RESPONSE']);
const STALE_PUBLISHING_AFTER_MS = 120_000;

function safeCode(value) {
  return SAFE_ERROR_CODES.has(value) ? value : 'system_error';
}

function isOpenRouterNotConfigured(error) {
  return error?.code === 'ai_not_configured'
    || error?.code === 'OPENROUTER_NOT_CONFIGURED'
    || error?.code === 'not_configured' && error?.message === 'AI_NOT_CONFIGURED';
}

function isTebarNotConfigured(error) {
  return error?.unknownOutcome !== true && (error?.code === 'TEBAR_NOT_CONFIGURED'
    || error?.code === 'not_configured' && (error?.message === 'TEBAR_NOT_CONFIGURED' || error?.provider === 'tebar'));
}

function safeProviderFailure(provider, error = {}) {
  const code = SAFE_ERROR_CODES.has(error.code) ? error.code
    : SAFE_DIAGNOSTIC_CODES.has(error.code) ? error.code : 'provider_error';
  const rawStatus = error.httpStatus ?? error.status;
  const httpStatus = Number.isSafeInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : null;
  const transportCode = SAFE_TRANSPORT_CODES.has(error.transportCode) ? error.transportCode : null;
  return { provider, code, httpStatus, transportCode, timedOut: error.timedOut === true };
}

async function persistProviderHold(repository, logger, hold, correlationId, alreadyRecorded = false) {
  if (!alreadyRecorded) {
    if (typeof repository.recordProviderHold !== 'function') return false;
    await repository.recordProviderHold(hold);
  }
  try {
    logger?.warn?.('automation.provider_held', {
      correlationId, provider: hold.provider, profileId: hold.profileId || null,
      accountId: hold.accountId || null, reasonCode: hold.reasonCode, slotId: hold.slotId,
    });
  } catch { /* Logging is secondary to the durable hold. */ }
  return true;
}

function providerSlotStatus(post, expectedAccountId) {
  if (post.status === 'published') {
    const confirmed = post.targets?.some((target) => target.accountId === expectedAccountId && target.status === 'published' && String(target.platform || '').toLowerCase() === 'threads');
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
  try {
    if (!details.slotId) { await notifier.send(`Kedai Merzz automation: ${safeCode(code)}.`); return true; }
    let state = null;
    try { state = await details.repository?.getRuntimeState(); } catch { /* Use available slot details. */ }
    const slot = (state?.history || []).find((item) => String(item.id) === String(details.slotId)) || {};
    const status = code === 'post_published' ? 'published' : code === 'unknown_outcome' ? 'unknown' : 'failed';
    const message = formatSlotNotice({ status, slotId: details.slotId, brand: state?.settings?.brand?.name,
      time: status === 'published' ? (details.completedAt || slot.completedAt || details.time) : (details.time || slot.completedAt),
      timezone: state?.settings?.schedule?.timezone || 'Asia/Kuala_Lumpur', pillar: details.pillar || slot.pillar,
      caption: details.caption || slot.caption || details.requestPayload?.content,
      postUrl: details.postUrl, nextAt: state?.automationEnabled ? state.settings?.nextSlotAt : null,
      reason: code, diagnosticCode: details.diagnosticCode });
    await notifier.send(message, details.slotId ? `${safeCode(code)}:slot:${details.slotId}` : undefined);
    return true;
  } catch { return false; }
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

async function reconcileUnsettled({ repository, publisher, publisherForProfile, notifier, counts, logger, slotIds, profileId, accountId, correlationId = randomUUID(), clock = () => new Date() }) {
  const hasTargetScope = typeof profileId === 'string' && profileId.length > 0 && typeof accountId === 'string' && accountId.length > 0;
  if (typeof repository.recoverStalePublishing === 'function') {
    const recovered = await repository.recoverStalePublishing({ now: clock(), staleAfterMs: STALE_PUBLISHING_AFTER_MS });
    for (const slotId of recovered || []) {
      try { logger?.warn?.('publication.worker_interrupted', { correlationId, slotId, outcome: 'unknown_outcome' }); } catch { /* Observability must not change publication state. */ }
      await sendNotice(notifier, 'unknown_outcome', { repository, slotId, time: clock() });
    }
  }
  const listedSlots = await repository.listUnsettledSlots(hasTargetScope ? { profileId, accountId } : undefined);
  const selectedIds = Array.isArray(slotIds) ? new Set(slotIds.map(String)) : null;
  const slots = listedSlots.filter((slot) => (!selectedIds || selectedIds.has(String(slot.id)))
    && (!hasTargetScope || slot.profileId === profileId && slot.accountId === accountId
      && slot.requestPayload?.targets?.length === 1 && slot.requestPayload.targets[0]?.account_id === accountId));
  let checked = 0;
  for (const slot of slots) {
    if (!slot.providerPostId && (!slot.requestPayload || !slot.idempotencyKey)) continue;
    try {
      // Without a provider ID, status is ambiguous. Never replay a mutation here:
      // the original request may not have reached Tebar, so replay could create
      // the first post after a pause or a restart.
      if (!slot.providerPostId) continue;
      if (publisherForProfile && (!slot.profileId || !slot.accountId || slot.requestPayload?.targets?.[0]?.account_id !== slot.accountId)) continue;
      const slotPublisher = publisherForProfile ? await publisherForProfile(slot.profileId) : publisher;
      const post = await slotPublisher.getPost(slot.providerPostId);
      const expectedAccountId = slot.accountId || slot.requestPayload?.targets?.[0]?.account_id;
      if (post?.id !== slot.providerPostId || !expectedAccountId
        || !post.targets?.some((target) => target.accountId === expectedAccountId && String(target.platform || '').toLowerCase() === 'threads')) continue;
      const status = await providerOutcomeStatus(repository, slot, post, expectedAccountId);
      const terminal = ['published', 'failed', 'canceled', 'partial'].includes(status);
      const completedAt = terminal ? confirmedCompletedAt(status, post, expectedAccountId, clock()) : null;
      const saved = await repository.updateSlot(slot.id, {
        status,
        providerStatus: post.status,
        providerPostId: post.id,
        errorCode: status === 'failed' || status === 'partial' || post.targets?.some((target) => target.status === 'failed') ? 'provider_error' : null,
        completedAt,
      });
      if (saved === false) { if (counts) counts.unknown++; continue; }
      try { logger?.info('publication.reconciled', { correlationId, slotId: slot.id, profileId: slot.profileId, accountId: expectedAccountId, status }); } catch { /* Observability must not change publishing. */ }
      checked++;
      if (counts && status === 'published') {
        counts.published++;
        await sendNotice(notifier, 'post_published', { repository, slotId: slot.id, completedAt, caption: slot.caption || slot.requestPayload?.content, pillar: slot.pillar, postUrl: post.targets?.find((target) => target.accountId === expectedAccountId && target.status === 'published' && String(target.platform).toLowerCase() === 'threads')?.permalink });
      } else if (counts && (status === 'partial' || status === 'failed')) {
        counts.failed++;
        try { await repository.appendActivity({ event: 'publish_failed', slotId: slot.id, details: { code: 'provider_error' } }); } catch { /* The provider status remains durable on the slot. */ }
        await sendNotice(notifier, 'provider_error', { repository, slotId: slot.id });
      } else if (counts && (status === 'unknown' || status === 'publishing')) { counts.unknown++; await sendNotice(notifier, 'unknown_outcome', { repository, slotId: slot.id, time: clock() }); }
    } catch {
      // Preserve the unknown state and exact persisted request for a later safe reconciliation.
    }
  }
  return checked;
}

async function reconcileSwitch({ repository, publisherForProfile, profileId, accountId, notifier, logger, clock = () => new Date() } = {}) {
  if (!repository || typeof publisherForProfile !== 'function' || !profileId || !accountId) return 0;
  const slots = await repository.listUnsettledSlots({ profileId, accountId });
  for (const slot of slots) {
    if (slot.profileId !== profileId || slot.accountId !== accountId
      || slot.requestPayload?.targets?.length !== 1 || slot.requestPayload.targets[0]?.account_id !== accountId
      || !slot.providerPostId || !['scheduled', 'draft'].includes(slot.providerStatus)) continue;
    try {
      const publisher = await publisherForProfile(profileId);
      const post = await publisher.getPost(slot.providerPostId);
      const hasExpectedTarget = (value) => value?.targets?.some((target) => target?.accountId === accountId
        && String(target.platform || '').toLowerCase() === 'threads');
      if (post?.id !== slot.providerPostId || !['scheduled', 'draft'].includes(post.status) || !hasExpectedTarget(post)) continue;
      const canceled = await publisher.cancelPost(slot.providerPostId);
      if (canceled?.id !== slot.providerPostId || canceled.status !== 'canceled' || !hasExpectedTarget(canceled)) continue;
      await repository.recordCancellation(slot.providerPostId, { status: 'canceled' });
      await repository.updateSlot(slot.id, { status: 'canceled', providerStatus: 'canceled', completedAt: clock().toISOString() });
    } catch { /* Preserve uncertain state; operator can retry reconciliation. */ }
  }
  return reconcileUnsettled({ repository, publisherForProfile, notifier, logger, profileId, accountId, clock });
}

async function runDispatcher({
  repository,
  content,
  publisher,
  publisherForProfile,
  notifier,
  clock = () => new Date(),
  timezone = 'Asia/Kuala_Lumpur',
  contentGenerator,
  generatorForModel,
  logger,
  correlationId = randomUUID(),
  maxPublishAttempts = 2,
} = {}) {
  if (!repository || !publisher || typeof content !== 'function') {
    throw new TypeError('repository, publisher, and content dependencies are required');
  }
  const now = clock();
  const result = { claimed: 0, published: 0, skipped: 0, failed: 0, unknown: 0, reconciled: 0, providerHeld: 0, summarySent: false };

  let state = await repository.getRuntimeState();
  const profileId = state.profileId || state.settings?.profileId || null;
  const targetScope = typeof profileId === 'string' && profileId && typeof state.accountId === 'string' && state.accountId
    ? { profileId, accountId: state.accountId } : undefined;
  if (typeof notifier?.flush === 'function') {
    try { await notifier.flush(); } catch { /* Notification retries must not block publishing safety checks. */ }
  }
  result.reconciled = await reconcileUnsettled({ repository, publisher, publisherForProfile, notifier, counts: result, logger, ...targetScope, correlationId, clock });
  await maybeSendDailySummary({ repository, notifier, now, counts: result });
  if (!state?.automationEnabled || state.onboardingComplete !== true || !state.accountId) return result;

  // A provider request with no definitive state blocks new posts until an
  // operator can reconcile it. This is deliberately fail-closed.
  if ((await repository.listUnsettledSlots(targetScope)).length > 0) {
    result.unknown++;
    return result;
  }

  if (typeof repository.listActiveProviderHolds === 'function') {
    const holds = await repository.listActiveProviderHolds({
      profileId: state.profileId || state.settings?.profileId || null,
      accountId: state.accountId,
    });
    if (holds.length) {
      result.providerHeld = holds.length;
      try {
        logger?.warn?.('automation.provider_hold_active', {
          profileId: state.profileId || state.settings?.profileId || null,
          accountId: state.accountId,
          holds: holds.map((hold) => ({ provider: hold.provider, reasonCode: SAFE_ERROR_CODES.has(hold.reasonCode) ? hold.reasonCode : 'provider_hold' })),
        });
      } catch { /* Logging is secondary to the hold. */ }
      return result;
    }
  }

  let schedule = { ...(state.settings?.schedule || {}) };
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
    const failedSlotDetails = Array.isArray(planned?.failedSlotDetails) && planned.failedSlotDetails.length
      ? planned.failedSlotDetails
      : (planned?.failedSlotIds || []).map((id) => ({ id }));
    for (const failedSlot of failedSlotDetails) {
      result.failed++;
      await sendNotice(notifier, 'generation_failed', { repository, slotId: failedSlot.id, diagnosticCode: failedSlot.diagnosticCode });
    }
    if (planned && !planned.slot) return result;
  } else {
    throw new TypeError('repository.ensureNextDueSlot is required for atomic slot planning');
  }

  const slot = await repository.claimDueSlot({ now });
  if (!slot) return result;
  result.claimed = 1;
  try { logger?.info('publication.claimed', { correlationId, slotId: slot.id, sessionId: slot.automationSessionId, configVersion: slot.configVersion, profileId: slot.profileId, accountId: slot.accountId }); } catch { /* Observability must not change publishing. */ }

  const claimedState = await repository.getRuntimeState();
  if (!claimedState?.automationEnabled || claimedState.onboardingComplete !== true || !claimedState.accountId
    || !slot.automationSessionId || claimedState.settings?.automationSessionId !== slot.automationSessionId) {
    await repository.updateSlot(slot.id, { status: 'canceled', errorCode: 'automation_paused', completedAt: clock().toISOString() });
    await repository.appendActivity({ event: 'slot_not_published', slotId: slot.id, details: { code: 'automation_paused' } });
    result.skipped++;
    return result;
  }
  state = claimedState;
  if (publisherForProfile) {
    if (!slot.profileId || !slot.accountId || slot.profileId !== state.profileId || slot.accountId !== state.accountId) {
      await repository.updateSlot(slot.id, { status: 'canceled', errorCode: 'target_snapshot_missing', completedAt: clock().toISOString() });
      result.skipped++;
      return result;
    }
    try { publisher = await publisherForProfile(slot.profileId); }
    catch (error) {
      if (!isTebarNotConfigured(error)) throw error;
      const profileId = slot.profileId;
      const accountId = slot.accountId;
      await persistProviderHold(repository, logger, {
        provider: 'tebar', profileId, accountId, reasonCode: 'not_configured', slotId: slot.id,
      }, correlationId);
      try { logger?.warn?.('publication.provider_failed', { correlationId, slotId: slot.id, profileId, accountId, provider: 'tebar', code: 'not_configured' }); }
      catch { /* Provider diagnostics must not alter the post result. */ }
      await repository.updateSlot(slot.id, { status: 'failed', errorCode: 'provider_error', completedAt: clock().toISOString() });
      await repository.appendActivity({ event: 'publish_failed', slotId: slot.id, details: { code: 'provider_error', diagnosticCode: 'tebar_not_configured' } });
      await sendNotice(notifier, 'provider_error', { repository, slotId: slot.id, diagnosticCode: 'tebar_not_configured' });
      result.failed++;
      return result;
    }
    state = { ...state, accountId: slot.accountId, profileId: slot.profileId };
  }
  let generated;
  if (generatorForModel && slot.status !== 'ready') {
    if (!slot.model) {
      await repository.updateSlot(slot.id, { status: 'failed', errorCode: 'generation_failed', completedAt: clock().toISOString() });
      result.failed++;
      return result;
    }
    try { contentGenerator = await generatorForModel(slot.model); }
    catch (error) {
      if (!isOpenRouterNotConfigured(error)) throw error;
      generated = { status: 'skipped', reason: 'GENERATION_FAILED', diagnosticCode: 'ai_not_configured', attempts: 0,
        providerFailure: { provider: 'openrouter', code: 'ai_not_configured' } };
    }
  }
  schedule = { ...(state.settings?.schedule || {}) };

  if (schedule && !isInActiveWindow(slot.scheduledAt || now, schedule)) {
    await repository.updateSlot(slot.id, { status: 'skipped', errorCode: 'outside_active_window', completedAt: now.toISOString() });
    await repository.appendActivity({ event: 'slot_skipped', slotId: slot.id, details: { code: 'outside_active_window' } });
    result.skipped++;
    return result;
  }

  let payload;
  let idempotencyKey;
  const isPrepared = slot.status === 'ready' && slot.requestPayload && typeof slot.idempotencyKey === 'string';
  if (isPrepared) {
    // A crash after persistence but before publishing must replay the exact durable request.
    payload = slot.requestPayload;
    idempotencyKey = slot.idempotencyKey;
    generated = { status: 'ready', text: slot.caption || payload.content, pillar: slot.pillar, factBearing: slot.factBearing === true, factIds: slot.factIds || [], factVersions: slot.factVersions || [] };
  } else if (slot.status === 'unknown' || slot.status === 'publishing') {
    await repository.updateSlot(slot.id, { status: 'unknown', providerStatus: 'unknown', errorCode: 'unknown_outcome' });
    result.unknown++;
    return result;
  } else if (!generated) {
    try {
      generated = await content({
        ...state,
        now,
        history: state.history || [],
        facts: state.facts || [],
        slot,
      }, contentGenerator ? { generate: contentGenerator } : undefined);
    } catch {
      generated = { status: 'skipped', reason: 'GENERATION_FAILED', diagnosticCode: 'content_service_error', attempts: 2 };
    }
  }
  if (!generated || generated.status !== 'ready' || typeof generated.text !== 'string') {
    const code = generated?.reason === 'CONTENT_VALIDATION_FAILED' ? 'content_validation_failed'
      : generated?.reason === 'ONBOARDING_INCOMPLETE' ? 'onboarding_incomplete' : 'generation_failed';
    const reasonDiagnostic = generated?.reason === 'INVALID_SETTINGS' ? 'invalid_settings'
      : generated?.reason === 'INVALID_APPROVED_FACTS' ? 'approved_content_invalid'
        : generated?.reason === 'CONTENT_VALIDATION_FAILED' ? 'content_validation_failed'
          : generated?.reason === 'ONBOARDING_INCOMPLETE' ? 'onboarding_incomplete' : null;
    const diagnosticCode = SAFE_DIAGNOSTIC_CODES.has(generated?.diagnosticCode)
      ? generated.diagnosticCode : reasonDiagnostic || 'content_service_error';
    if (slot.automationSessionId && typeof repository.isAutomationSessionActive === 'function'
      && !await repository.isAutomationSessionActive(slot.automationSessionId)) {
      result.skipped++;
      return result;
    }
    if (generated?.providerFailure) {
      try {
        logger?.warn?.('publication.provider_failed', {
          correlationId, slotId: slot.id,
          ...safeProviderFailure(generated.providerFailure.provider === 'openrouter' ? 'openrouter' : 'ai', generated.providerFailure),
        });
      } catch { /* Provider diagnostics must not alter the post result. */ }
    }
    const openRouterHoldReason = diagnosticCode === 'ai_not_configured' ? 'ai_not_configured'
      : diagnosticCode === 'ai_unauthorized' ? 'unauthorized' : null;
    if (openRouterHoldReason) {
      await persistProviderHold(repository, logger, {
        provider: 'openrouter', profileId: null, accountId: null,
        reasonCode: openRouterHoldReason, slotId: slot.id,
      }, correlationId);
    }
    await repository.updateSlot(slot.id, { status: 'failed', errorCode: code, completedAt: clock().toISOString() });
    await repository.appendActivity({ event: 'ai_generation_failed', slotId: slot.id, details: { code, diagnosticCode, attempts: Math.min(2, generated?.attempts || 0) } });
    await sendNotice(notifier, code, { repository, slotId: slot.id, diagnosticCode, time: clock() });
    result.failed++;
    return result;
  }

  const currentSafetyHash = contentSafetyHash(state.settings);
  const previousSafetyHash = legacyContentSafetyHash(state.settings);
  if ((isPrepared && (!slot.contentSafetyHash || ![currentSafetyHash, previousSafetyHash].includes(slot.contentSafetyHash)))
      || (generated.factBearing === true && (!Array.isArray(generated.factIds) || !generated.factIds.length
      || !Array.isArray(generated.factVersions) || generated.factIds.some((id) => !generated.factVersions.some((version) => version?.id === id))))) {
    await repository.updateSlot(slot.id, { status: 'failed', errorCode: 'generation_failed', completedAt: clock().toISOString() });
    await repository.appendActivity({ event: 'ai_generation_failed', slotId: slot.id, details: { code: 'generation_failed', diagnosticCode: 'stale_facts', attempts: 0 } });
    await sendNotice(notifier, 'generation_failed', { repository, slotId: slot.id, diagnosticCode: 'stale_facts' });
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
      ...(generated.factVersions ? { factVersions: generated.factVersions } : {}),
      contentSafetyHash: contentSafetyHash(state.settings),
    });
    if (saved === false) {
      await repository.appendActivity({ event: 'slot_not_published', slotId: slot.id, details: { code: 'automation_paused' } });
      result.skipped++;
      return result;
    }
  }

  const started = await repository.startPublishing(slot.id, { now: clock() });
  if (started === 'provider_hold') {
    result.providerHeld++;
    try { await repository.appendActivity({ event: 'publication_held', slotId: slot.id, details: { code: 'provider_hold' } }); } catch { /* The durable hold remains authoritative. */ }
    return result;
  }
  if (started === 'stale_facts') {
    await repository.updateSlot(slot.id, { status: 'failed', errorCode: 'generation_failed', completedAt: clock().toISOString() });
    await repository.appendActivity({ event: 'ai_generation_failed', slotId: slot.id, details: { code: 'generation_failed', diagnosticCode: 'stale_facts', attempts: 0 } });
    await sendNotice(notifier, 'generation_failed', { repository, slotId: slot.id, diagnosticCode: 'stale_facts' });
    result.failed++;
    return result;
  }
  if (started === 'minimum_cadence') {
    await repository.appendActivity({ event: 'cadence_cooldown_wait', slotId: slot.id, details: { code: 'minimum_cadence' } });
    result.skipped++;
    return result;
  }
  if (started === 'in_flight') {
    await repository.appendActivity({ event: 'dispatch_overlap_wait', slotId: slot.id, details: { code: 'dispatch_overlap_wait' } });
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
  if (typeof repository.withPublicationFence !== 'function') {
    result.skipped++;
    return result;
  }

  let attempt = 0;
  let acceptedPost = null;
  let acceptedInitialUpdate = null;
  let retryableFailure = null;
  const maxAttempts = Math.max(1, Math.min(2, maxPublishAttempts));
  while (attempt < maxAttempts) {
    if (slot.automationSessionId && typeof repository.isAutomationSessionActive === 'function'
      && !await repository.isAutomationSessionActive(slot.automationSessionId)) {
      if (retryableFailure) {
        const code = safeCode(retryableFailure.code);
        await repository.updateSlot(slot.id, { status: 'failed', providerStatus: 'failed', errorCode: code, completedAt: clock().toISOString() });
        await repository.appendActivity({ event: 'publish_failed', slotId: slot.id, details: { code } });
        await sendNotice(notifier, code, { repository, slotId: slot.id });
        result.failed++;
        return result;
      }
      await repository.updateSlot(slot.id, { status: 'canceled', errorCode: 'automation_paused', completedAt: clock().toISOString() });
      await repository.appendActivity({ event: 'slot_not_published', slotId: slot.id, details: { code: 'automation_paused' } });
      result.skipped++;
      return result;
    }
    attempt++;
    let providerCallStarted = false;
    let callbackOutcome = null;
    const publishAttempt = async (recordOutcome) => {
      providerCallStarted = true;
      try { logger?.info('publication.sending', { correlationId, slotId: slot.id, sessionId: slot.automationSessionId, configVersion: slot.configVersion, profileId: slot.profileId, accountId: slot.accountId, attempt }); } catch { /* Do not log request bodies or credentials. */ }
      let providerError;
      let providerThrew = false;
      try { callbackOutcome = { kind: 'accepted', post: await publisher.publishNow(payload, idempotencyKey) }; }
      catch (error) { providerError = error; providerThrew = true; }
      if (providerThrew) {
        const providerPostId = typeof providerError?.providerPostId === 'string' ? providerError.providerPostId : null;
        if (providerPostId) {
          const patch = { status: 'unknown', providerStatus: 'unknown', providerPostId, errorCode: 'unknown_outcome' };
          callbackOutcome = { kind: 'provider_id_error', error: providerError, providerPostId, patch };
          if (await recordOutcome(patch) === false) callbackOutcome = { kind: 'fence_lost' };
          return callbackOutcome;
        }
        if (providerError?.unknownOutcome) {
          const patch = { status: 'unknown', providerStatus: 'unknown', errorCode: safeCode(providerError.code) };
          callbackOutcome = { kind: 'unknown_error', error: providerError, patch };
          if (await recordOutcome(patch) === false) callbackOutcome = { kind: 'fence_lost' };
          return callbackOutcome;
        }
        if (providerError?.retryable && attempt < maxAttempts) {
          const patch = { status: 'publishing', providerStatus: 'failed', errorCode: safeCode(providerError.code), completedAt: null };
          callbackOutcome = { kind: 'retryable_error', error: providerError, patch };
          if (await recordOutcome(patch) === false) callbackOutcome = { kind: 'fence_lost' };
          return callbackOutcome;
        }
        const providerHold = PROVIDER_HOLD_CODES.has(providerError?.code) ? {
          provider: 'tebar', profileId: slot.profileId || state.profileId || null,
          accountId: slot.accountId || state.accountId || null, reasonCode: providerError.code, slotId: slot.id,
        } : null;
        const patch = { status: 'failed', providerStatus: 'failed', errorCode: safeCode(providerError?.code), completedAt: clock().toISOString() };
        callbackOutcome = { kind: 'failed_error', error: providerError, patch, providerHold, providerHoldRecorded: Boolean(providerHold && recordOutcome.supportsProviderHolds) };
        if (await recordOutcome(patch, providerHold ? { providerHold } : undefined) === false) callbackOutcome = { kind: 'fence_lost' };
        return callbackOutcome;
      }
      const post = callbackOutcome.post;
      const status = await providerOutcomeStatus(repository, slot, post, state.accountId);
      const terminal = ['published', 'failed', 'partial', 'canceled'].includes(status);
      const initialUpdate = {
        status,
        providerStatus: post.status,
        providerPostId: post.id,
        errorCode: status === 'failed' || status === 'partial' ? 'provider_error' : null,
        completedAt: terminal ? confirmedCompletedAt(status, post, state.accountId, clock()) : null,
      };
      callbackOutcome = { kind: 'accepted', post, status, initialUpdate, patch: initialUpdate };
      if (await recordOutcome(initialUpdate) === false) callbackOutcome = { kind: 'fence_lost' };
      return callbackOutcome;
    };
    let publicationOutcome;
    try {
      publicationOutcome = await repository.withPublicationFence(slot.id, publishAttempt);
    } catch (error) {
      if (!providerCallStarted) throw error;
      const providerPostId = callbackOutcome?.patch?.providerPostId || callbackOutcome?.post?.id || null;
      try {
        await repository.updateSlot(slot.id, {
          status: 'unknown', providerStatus: 'unknown', ...(providerPostId ? { providerPostId } : {}), errorCode: 'unknown_outcome',
        });
      } catch { /* Keep the exact prepared request for later provider reconciliation. */ }
      try { await repository.appendActivity({ event: 'publish_outcome_unknown', slotId: slot.id, details: { code: 'unknown_outcome' } }); } catch { /* Slot state remains the primary record. */ }
      await sendNotice(notifier, 'unknown_outcome', { repository, slotId: slot.id });
      result.unknown++;
      return result;
    }
    if (publicationOutcome?.kind === 'fence_lost') {
      result.unknown++;
      return result;
    }
    if (publicationOutcome === false) {
      if (retryableFailure) {
        const code = safeCode(retryableFailure.code);
        const saved = await repository.updateSlot(slot.id, { status: 'failed', providerStatus: 'failed', errorCode: code, completedAt: clock().toISOString() });
        if (saved !== false) {
          await repository.appendActivity({ event: 'publish_failed', slotId: slot.id, details: { code } });
          await sendNotice(notifier, code, { repository, slotId: slot.id });
          result.failed++;
        } else result.skipped++;
      } else result.skipped++;
      return result;
    }
    if (publicationOutcome?.kind === 'provider_id_error') {
      const { providerPostId } = publicationOutcome;
      try {
        const post = await publisher.getPost(providerPostId);
        const status = await providerOutcomeStatus(repository, slot, post, state.accountId);
        const terminal = ['published', 'failed', 'canceled', 'partial'].includes(status);
        const saved = await repository.updateSlot(slot.id, { status, providerStatus: post.status, providerPostId, errorCode: status === 'failed' || status === 'partial' ? 'provider_error' : null, completedAt: terminal ? confirmedCompletedAt(status, post, state.accountId, clock()) : null });
        if (saved === false) { result.unknown++; return result; }
        const cancellation = await cancelIfSessionRevoked({ repository, publisher, slot, post, status, expectedAccountId: state.accountId });
        const finalPost = cancellation.post;
        const finalStatus = cancellation.status;
        if (finalPost !== post || cancellation.cancellationStatus) {
          const finalCompletedAt = ['published', 'failed', 'canceled', 'partial'].includes(finalStatus) ? confirmedCompletedAt(finalStatus, finalPost, state.accountId, clock()) : null;
          const savedFinal = await repository.updateSlot(slot.id, { status: finalStatus, providerStatus: finalPost.status, providerPostId, errorCode: finalStatus === 'failed' || finalStatus === 'partial' ? 'provider_error' : null, completedAt: finalCompletedAt, ...(cancellation.cancellationStatus ? { cancellationStatus: cancellation.cancellationStatus } : {}) });
          if (savedFinal === false) { result.unknown++; return result; }
        }
        if (cancellation.cancellationStatus) {
          try { await repository.recordCancellation(providerPostId, { status: cancellation.cancellationStatus, errorCode: cancellation.cancellationStatus === 'canceled' ? null : 'post_not_editable' }); } catch { /* The provider state remains durable on the slot. */ }
        }
        if (finalStatus === 'published') { result.published++; await sendNotice(notifier, 'post_published', { repository, slotId: slot.id, completedAt: confirmedCompletedAt('published', finalPost, state.accountId, clock()), caption: generated.text, pillar: generated.pillar, postUrl: finalPost.targets?.find((target) => target.accountId === state.accountId && target.status === 'published' && String(target.platform).toLowerCase() === 'threads')?.permalink }); }
        else if (finalStatus === 'failed' || finalStatus === 'partial') { result.failed++; try { await repository.appendActivity({ event: 'publish_failed', slotId: slot.id, details: { code: 'provider_error' } }); } catch { /* Provider outcome is already durable. */ } await sendNotice(notifier, 'provider_error', { repository, slotId: slot.id }); }
        else if (finalStatus === 'canceled') result.skipped++;
        else { result.unknown++; await sendNotice(notifier, 'unknown_outcome', { repository, slotId: slot.id, time: clock() }); }
        return result;
      } catch {
        try { await repository.updateSlot(slot.id, { status: 'unknown', providerStatus: 'unknown', providerPostId, errorCode: 'unknown_outcome' }); } catch { /* Preserve the original provider ID for reconciliation. */ }
        try { await repository.appendActivity({ event: 'publish_outcome_unknown', slotId: slot.id, details: { code: 'unknown_outcome' } }); } catch { /* Slot state remains the primary record. */ }
        await sendNotice(notifier, 'unknown_outcome', { repository, slotId: slot.id });
        result.unknown++;
        return result;
      }
    }
    if (publicationOutcome?.kind === 'unknown_error') {
      const error = publicationOutcome.error;
      try {
        logger?.warn?.('publication.provider_failed', {
          correlationId, slotId: slot.id, profileId: slot.profileId || state.profileId || null,
          accountId: slot.accountId || state.accountId || null, ...safeProviderFailure('tebar', error),
        });
      } catch { /* Provider diagnostics must not alter the uncertain post state. */ }
      await repository.appendActivity({ event: 'publish_outcome_unknown', slotId: slot.id, details: { code: safeCode(error.code) } });
      await sendNotice(notifier, 'unknown_outcome', { repository, slotId: slot.id });
      result.unknown++;
      return result;
    }
    if (publicationOutcome?.kind === 'retryable_error') {
      retryableFailure = publicationOutcome.error;
      if (slot.automationSessionId && typeof repository.isAutomationSessionActive === 'function'
        && !await repository.isAutomationSessionActive(slot.automationSessionId)) {
        const code = safeCode(retryableFailure.code);
        await repository.updateSlot(slot.id, { status: 'failed', providerStatus: 'failed', errorCode: code, completedAt: clock().toISOString() });
        await repository.appendActivity({ event: 'publish_failed', slotId: slot.id, details: { code } });
        await sendNotice(notifier, code, { repository, slotId: slot.id });
        result.failed++;
        return result;
      }
      continue;
    }
    if (publicationOutcome?.kind === 'failed_error') {
      const error = publicationOutcome.error;
      const providerFailure = safeProviderFailure('tebar', error);
      try {
        logger?.warn?.('publication.provider_failed', {
          correlationId, slotId: slot.id, profileId: slot.profileId || state.profileId || null,
          accountId: slot.accountId || state.accountId || null, ...providerFailure,
        });
      } catch { /* Provider diagnostics must not alter the post result. */ }
      if (PROVIDER_HOLD_CODES.has(error?.code)) {
        await persistProviderHold(repository, logger, {
          provider: 'tebar', profileId: slot.profileId || state.profileId || null,
          accountId: slot.accountId || state.accountId || null,
          reasonCode: error.code, slotId: slot.id,
        }, correlationId, publicationOutcome.providerHoldRecorded);
      }
      await repository.appendActivity({ event: 'publish_failed', slotId: slot.id, details: { code: safeCode(error?.code) } });
      await sendNotice(notifier, safeCode(error?.code), { repository, slotId: slot.id });
      result.failed++;
      return result;
    }
    if (publicationOutcome?.kind === 'accepted') {
      acceptedPost = publicationOutcome.post;
      acceptedInitialUpdate = publicationOutcome.initialUpdate;
      break;
    }
    if (publicationOutcome) {
      result.unknown++;
      return result;
    }
  }
  if (acceptedPost) {
    const initialStatus = acceptedInitialUpdate.status;
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
      try { const saved = await repository.updateSlot(slot.id, finalUpdate); if (saved === false) { result.unknown++; return result; } }
      catch {
        await repository.updateSlot(slot.id, { ...finalUpdate, status: 'unknown', errorCode: 'unknown_outcome' }).catch(() => {});
        await sendNotice(notifier, 'unknown_outcome', { repository, slotId: slot.id });
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
      await sendNotice(notifier, 'post_published', { repository, slotId: slot.id, completedAt: confirmedCompletedAt('published', post, state.accountId, clock()), caption: generated.text, pillar: generated.pillar, postUrl: post.targets?.find((target) => target.accountId === state.accountId && target.status === 'published' && String(target.platform).toLowerCase() === 'threads')?.permalink });
    }
    else if (status === 'failed' || status === 'partial') {
      result.failed++;
      await sendNotice(notifier, 'provider_error', { repository, slotId: slot.id });
    } else if (status === 'unknown' || status === 'publishing') {
      result.unknown++;
      await sendNotice(notifier, 'unknown_outcome', { repository, slotId: slot.id });
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
    const state = typeof repository.getRuntimeState === 'function' ? await repository.getRuntimeState() : null;
    await notifier.send(formatDailyReport({ ...summary, date: localDate, timezone, brand: state?.settings?.brand?.name, automationEnabled: state?.automationEnabled === true, nextAt: state?.automationEnabled ? state?.settings?.nextSlotAt : null }), `daily-summary:${localDate}:${timezone}`);
    await repository.finishDailySummary({ localDate, timezone, status: 'sent' });
    counts.summarySent = true;
  } catch {
    await repository.finishDailySummary({ localDate, timezone, status: 'failed' });
  }
}

async function pauseAutomation({ repository, publisher, notifier, profileId, accountId, adminId } = {}) {
  if (!repository || !publisher) throw new TypeError('repository and publisher dependencies are required');
  await repository.setAutomationEnabled(false, adminId);
  await repository.appendActivity({ event: 'automation_paused', details: { actor: adminId ? 'admin' : 'system' } });
  const targetScope = typeof profileId === 'string' && profileId && typeof accountId === 'string' && accountId
    ? { profileId, accountId } : undefined;
  const knownSlots = await repository.listUnsettledSlots(targetScope);
  const known = new Set(knownSlots.filter((slot) => !targetScope
    || slot.profileId === profileId && slot.accountId === accountId
      && (!slot.requestPayload || slot.requestPayload.targets?.length === 1 && slot.requestPayload.targets[0]?.account_id === accountId))
    .map((slot) => slot.providerPostId).filter(Boolean));
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

module.exports = { runDispatcher, pauseAutomation, reconcileUnsettled, reconcileSwitch, maybeSendDailySummary, safeCode };
