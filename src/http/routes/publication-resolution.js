'use strict';

const { createIpRateLimiter } = require('../../rate-limit');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,128}$/;
function failure(code, status) { return Object.assign(new Error(code), { code, status }); }
function input(req, action) {
  const keys = action === 'close_unverified'
    ? ['requestId', 'reason', 'evidenceSummary', 'confirmDelayedPublication']
    : ['requestId', 'providerPostId', 'reason', 'evidenceSummary', 'confirmOriginalTarget'];
  const body = req.body;
  const bounded = (value, max) => typeof value === 'string' && value.trim().length >= 10 && value.trim().length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
  if (!UUID.test(req.params.slotId) || !body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== keys.length || keys.some(key => !Object.hasOwn(body, key))
    || !UUID.test(body.requestId) || !bounded(body.reason, 1000) || !bounded(body.evidenceSummary, 2000)
    || (action === 'close_unverified' ? body.confirmDelayedPublication !== true : body.confirmOriginalTarget !== true || typeof body.providerPostId !== 'string' || !PROVIDER_ID.test(body.providerPostId))) {
    throw failure('INVALID_REQUEST', 400);
  }
  return { slotId: req.params.slotId.toLowerCase(), requestId: body.requestId.toLowerCase(), actorId: req.admin.id,
    action, reason: body.reason.trim(), evidenceSummary: body.evidenceSummary.trim(),
    ...(action === 'link_provider_post' ? { providerPostId: body.providerPostId } : {}) };
}
function registerPublicationResolutionRoutes(app, { repository, services, authenticated, mutation }) {
  async function reconcileLinked(slotId) {
    try {
      if (typeof services.reconcileLinkedPublication === 'function') return await services.reconcileLinkedPublication({ slotId });
    } catch { /* The verified provider ID stays durable for the next read-only reconciliation. */ }
    return { status: 'unknown', pending: true };
  }
  function flushNotices() {
    try { Promise.resolve(services.flushNotifications?.()).catch(() => {}); } catch { /* Durable outbox retains retryable notices. */ }
  }
  const limit = createIpRateLimiter({ limit: 30, windowMs: 60_000 });
  app.get('/api/publication-resolution/slots', authenticated, async (_req, res, next) => {
    try {
      const slotId = _req.query?.slotId;
      if (slotId !== undefined && (typeof slotId !== 'string' || !UUID.test(slotId))) throw failure('INVALID_REQUEST', 400);
      const closedSlotId = slotId?.toLowerCase();
      const [slots, closedSlots, events] = await Promise.all([
        repository.listPublicationBlockers(), repository.listClosedUnknownSlots(closedSlotId), repository.listPublicationResolutionEvents(),
      ]);
      return res.json({ slots, closedSlots, events });
    } catch (error) { return next(error); }
  });
  app.post('/api/publication-resolution/:slotId/reconcile', authenticated, mutation, limit, async (req, res, next) => {
    try {
      if (!UUID.test(req.params.slotId)) throw failure('INVALID_REQUEST', 400);
      const slotId = req.params.slotId.toLowerCase();
      const slot = await repository.getPublicationSlot(slotId);
      if (!slot) throw failure('PUBLICATION_NOT_FOUND', 404);
      if (slot.status !== 'unknown' || typeof slot.providerPostId !== 'string' || !PROVIDER_ID.test(slot.providerPostId)) {
        throw failure('PUBLICATION_STATE_CONFLICT', 409);
      }
      if (slot.resolutionTargetValid !== true || !PROVIDER_ID.test(slot.profileId || '') || !PROVIDER_ID.test(slot.accountId || '')) {
        throw failure('PUBLICATION_TARGET_MISMATCH', 409);
      }
      if (typeof services.reconcileLinkedPublication !== 'function') throw failure('PUBLICATION_RECONCILIATION_UNAVAILABLE', 503);
      let reconciliation;
      try { reconciliation = await services.reconcileLinkedPublication({ slotId }); }
      catch { throw failure('PUBLICATION_RECONCILIATION_UNAVAILABLE', 503); }
      return res.json({ reconciliation });
    } catch (error) { return next(error); }
  });
  app.post('/api/publication-resolution/:slotId/close-unverified', authenticated, mutation, limit, async (req, res, next) => {
    try {
      const resolution = await repository.closeUnknownPublication(input(req, 'close_unverified'));
      try { services.logger?.info?.('publication.admin_closed_unknown', { slotId: resolution.slotId, actorId: req.admin.id, requestId: resolution.requestId, replayed: resolution.replayed === true }); } catch { /* Decision is already durable. */ }
      flushNotices();
      return res.json({ resolution });
    } catch (error) { return next(error); }
  });
  app.post('/api/publication-resolution/:slotId/link-provider-post', authenticated, mutation, limit, async (req, res, next) => {
    try {
      const values = input(req, 'link_provider_post');
      const replay = await repository.getPublicationResolutionByRequest(values);
      if (replay) { const reconciliation = await reconcileLinked(values.slotId); flushNotices(); return res.json({ resolution: replay, reconciliation }); }
      const slot = await repository.getPublicationSlot(values.slotId);
      if (!slot) throw failure('PUBLICATION_NOT_FOUND', 404);
      if (!['unknown', 'admin_closed_unknown'].includes(slot.status) || slot.providerPostId !== null) throw failure('PUBLICATION_STATE_CONFLICT', 409);
      if (slot.resolutionTargetValid !== true || !PROVIDER_ID.test(slot.profileId || '') || !PROVIDER_ID.test(slot.accountId || '')) throw failure('PUBLICATION_TARGET_MISMATCH', 409);
      if (typeof services.verifyProviderPostForSlot !== 'function') throw failure('PUBLICATION_VERIFICATION_UNAVAILABLE', 503);
      let post;
      try { post = await services.verifyProviderPostForSlot({ profileId: slot.profileId, postId: values.providerPostId }); }
      catch { throw failure('PUBLICATION_VERIFICATION_UNAVAILABLE', 503); }
      if (post?.id !== values.providerPostId || post.status !== 'published'
        || !Array.isArray(post.targets) || !post.targets.some(target => target && target.accountId === slot.accountId
          && String(target.platform || '').toLowerCase() === 'threads' && target.status === 'published')) {
        throw failure('PUBLICATION_TARGET_MISMATCH', 409);
      }
      const resolution = await repository.linkVerifiedProviderPost({ ...values, profileId: slot.profileId, accountId: slot.accountId });
      try { services.logger?.info?.('publication.provider_post_linked', { slotId: values.slotId, actorId: req.admin.id, requestId: values.requestId, providerPostId: values.providerPostId }); } catch { /* Decision is already durable. */ }
      const reconciliation = await reconcileLinked(values.slotId);
      flushNotices();
      return res.json({ resolution, reconciliation });
    } catch (error) { return next(error); }
  });
}
module.exports = { registerPublicationResolutionRoutes };
