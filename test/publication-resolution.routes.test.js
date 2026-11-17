'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer } = require('../src/server');
const slotId = '5fe16cbd-0249-4bb3-9b67-b5ae1b1e0d30';
const requestId = '11111111-1111-4111-8111-111111111111';
const closeBody = { requestId, reason: 'Checked original account.', evidenceSummary: 'Tebar and Threads checked at the original attempt time.', confirmDelayedPublication: true };
async function fixture(t, overrides = {}) {
  const calls = [];
  const slot = { id: slotId, status: 'unknown', providerStatus: 'unknown', providerPostId: null, profileId: 'old-profile', accountId: 'old-account', resolutionTargetValid: true };
  const repository = {
    listPublicationBlockers: async () => [slot], listClosedUnknownSlots: async () => [], listPublicationResolutionEvents: async () => [],
    getPublicationSlot: async () => slot, getPublicationResolutionByRequest: async () => null,
    closeUnknownPublication: async input => { calls.push(['close', input]); return { ...input, newStatus: 'admin_closed_unknown' }; },
    linkVerifiedProviderPost: async input => { calls.push(['link', input]); return { ...input, newStatus: 'unknown' }; },
    ...overrides.repository,
  };
  const services = {
    verifyProviderPostForSlot: async input => { calls.push(['verify', input]); return { id: 'post-1', status: 'published', targets: [{ accountId: 'old-account', platform: 'threads', status: 'published' }] }; },
    triggerScheduler: () => { throw Error('must not trigger scheduler'); },
    ...overrides.services,
  };
  const config = { nodeEnv: 'test', baseUrl: 'http://localhost', tebar: {} };
  const auth = { authenticate: async token => token === 'valid' ? { admin: { id: 7, email: 'admin@example.test' }, csrfToken: 'csrf' } : null };
  const server = http.createServer(createServer({ config, repository, services, auth }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  config.baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }));
  async function request(path, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(config.baseUrl + path, { method, headers: { cookie: 'merzz_admin=valid', origin: config.baseUrl, 'content-type': 'application/json', 'x-csrf-token': 'csrf', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  return { request, calls, slot };
}

test('publication resolution endpoints require admin auth and CSRF without triggering scheduler', async t => {
  const { request, calls } = await fixture(t);
  assert.equal((await request('/api/publication-resolution/slots', { headers: { cookie: '' } })).status, 401);
  assert.equal((await request(`/api/publication-resolution/${slotId}/close-unverified`, { method: 'POST', body: closeBody, headers: { 'x-csrf-token': 'bad' } })).status, 403);
  const { confirmDelayedPublication, ...linkBase } = closeBody;
  assert.equal((await request(`/api/publication-resolution/${slotId}/link-provider-post`, { method: 'POST', body: { ...linkBase, providerPostId: 'post-1', confirmOriginalTarget: true }, headers: { 'x-csrf-token': 'bad' } })).status, 403);
  assert.equal((await request(`/api/publication-resolution/${slotId}/reconcile`, { method: 'POST', headers: { 'x-csrf-token': 'bad' } })).status, 403);
  assert.equal((await request(`/api/publication-resolution/${slotId}/reconcile`, { method: 'POST', headers: { cookie: '' } })).status, 401);
  assert.equal(calls.length, 0);
  const list = await request('/api/publication-resolution/slots');
  assert.equal(list.status, 200); assert.equal(list.body.slots[0].profileId, 'old-profile');
  assert.deepEqual(Object.keys(list.body).sort(), ['closedSlots', 'events', 'slots']);
  assert.deepEqual(list.body.closedSlots, []);
  const result = await request(`/api/publication-resolution/${slotId}/close-unverified`, { method: 'POST', body: closeBody });
  assert.equal(result.status, 200); assert.equal(result.body.resolution.newStatus, 'admin_closed_unknown');
  assert.equal(calls.length, 1); assert.equal(calls[0][1].actorId, 7); assert.equal(Object.hasOwn(calls[0][1], 'actorEmail'), false);
});

test('manual closure rejects missing evidence, missing confirmation, unexpected fields, and malformed ids', async t => {
  const { request, calls } = await fixture(t);
  for (const body of [{ ...closeBody, reason: '' }, { ...closeBody, evidenceSummary: '' }, { ...closeBody, confirmDelayedPublication: false }, { ...closeBody, extra: 'unsafe' }, { ...closeBody, requestId: 'wrong' }]) {
    assert.equal((await request(`/api/publication-resolution/${slotId}/close-unverified`, { method: 'POST', body })).status, 400);
  }
  assert.equal((await request('/api/publication-resolution/not-a-uuid/close-unverified', { method: 'POST', body: closeBody })).status, 400);
  assert.equal(calls.length, 0);
});

test('legacy slots without a reliable target can be closed, but provider ID linking fails before provider verification', async t => {
  const legacySlot = { id: slotId, status: 'unknown', providerStatus: 'unknown', providerPostId: null,
    profileId: null, accountId: null, resolutionTargetValid: false };
  const { request, calls } = await fixture(t, { repository: { getPublicationSlot: async () => legacySlot } });
  const closed = await request(`/api/publication-resolution/${slotId}/close-unverified`, { method: 'POST', body: closeBody });
  assert.equal(closed.status, 200);
  assert.equal(calls[0][0], 'close');
  const { confirmDelayedPublication, ...linkBase } = closeBody;
  const linked = await request(`/api/publication-resolution/${slotId}/link-provider-post`, { method: 'POST', body: {
    ...linkBase, providerPostId: 'post-1', confirmOriginalTarget: true,
  } });
  assert.equal(linked.status, 409);
  assert.deepEqual(calls.map(([kind]) => kind), ['close']);
});

test('linking uses a provider GET on original profile and confirms the published Threads target', async t => {
  const { request, calls } = await fixture(t);
  const { confirmDelayedPublication, ...base } = closeBody;
  const result = await request(`/api/publication-resolution/${slotId}/link-provider-post`, { method: 'POST', body: { ...base, providerPostId: 'post-1', confirmOriginalTarget: true } });
  assert.equal(result.status, 200);
  assert.deepEqual(calls[0], ['verify', { profileId: 'old-profile', postId: 'post-1' }]);
  assert.equal(calls[1][0], 'link'); assert.equal(calls[1][1].profileId, 'old-profile'); assert.equal(calls[1][1].accountId, 'old-account');
});

test('link verification accepts a case-normalized Threads platform name', async t => {
  const { request } = await fixture(t, { services: { verifyProviderPostForSlot: async () => ({
    id: 'post-1', status: 'published', targets: [{ accountId: 'old-account', platform: 'Threads', status: 'published' }],
  }) } });
  const { confirmDelayedPublication, ...base } = closeBody;
  const result = await request(`/api/publication-resolution/${slotId}/link-provider-post`, { method: 'POST', body: { ...base, providerPostId: 'post-1', confirmOriginalTarget: true } });
  assert.equal(result.status, 200);
});

test('a later publication can be linked from a closed slot using only the verified provider GET', async t => {
  const closedSlot = { id: slotId, status: 'admin_closed_unknown', providerStatus: 'unknown', providerPostId: null,
    profileId: 'old-profile', accountId: 'old-account', resolutionTargetValid: true };
  const { request, calls } = await fixture(t, {
    repository: { getPublicationSlot: async () => closedSlot },
    services: { publishNow: async () => { calls.push(['publish']); throw Error('must not publish'); } },
  });
  const { confirmDelayedPublication, ...base } = closeBody;
  const result = await request(`/api/publication-resolution/${slotId}/link-provider-post`, { method: 'POST', body: { ...base, providerPostId: 'post-1', confirmOriginalTarget: true } });
  assert.equal(result.status, 200);
  assert.deepEqual(calls[0], ['verify', { profileId: 'old-profile', postId: 'post-1' }]);
  assert.equal(calls[1][0], 'link');
  assert.equal(calls.some(([kind]) => kind === 'publish'), false);
});

test('explicit linked-slot reconciliation uses only the scoped GET service and can be retried after an inconclusive result', async t => {
  const serviceCalls = [];
  let attempts = 0;
  const linkedSlot = { id: slotId, status: 'unknown', providerStatus: 'unknown', providerPostId: 'post-1',
    profileId: 'old-profile', accountId: 'old-account', resolutionTargetValid: true };
  const { request } = await fixture(t, {
    repository: { getPublicationSlot: async () => linkedSlot },
    services: {
      reconcileLinkedPublication: async input => {
        serviceCalls.push(['reconcile', input]);
        attempts++;
        return attempts === 1 ? { status: 'unknown', pending: true } : { status: 'published', pending: false };
      },
      verifyProviderPostForSlot: async () => { serviceCalls.push(['verify']); throw Error('must not verify a new link'); },
      publishNow: async () => { serviceCalls.push(['publish']); throw Error('must not publish'); },
    },
  });
  const path = `/api/publication-resolution/${slotId}/reconcile`;
  const first = await request(path, { method: 'POST' });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.reconciliation, { status: 'unknown', pending: true });
  const retry = await request(path, { method: 'POST' });
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.body.reconciliation, { status: 'published', pending: false });
  assert.deepEqual(serviceCalls, [['reconcile', { slotId }], ['reconcile', { slotId }]]);
});

test('explicit reconciliation rejects terminal, missing-ID, and malformed-target slots before calling services', async t => {
  const serviceCalls = [];
  const invalidSlots = [
    { status: 'published', providerPostId: 'post-1', resolutionTargetValid: true },
    { status: 'unknown', providerPostId: null, resolutionTargetValid: true },
    { status: 'unknown', providerPostId: 'bad post id', resolutionTargetValid: true },
    { status: 'unknown', providerPostId: 'post-1', resolutionTargetValid: false },
  ];
  for (const invalidSlot of invalidSlots) {
    const { request } = await fixture(t, {
      repository: { getPublicationSlot: async () => ({ id: slotId, profileId: 'old-profile', accountId: 'old-account', ...invalidSlot }) },
      services: { reconcileLinkedPublication: async input => { serviceCalls.push(input); return { status: 'published' }; } },
    });
    assert.equal((await request(`/api/publication-resolution/${slotId}/reconcile`, { method: 'POST' })).status, 409);
  }
  const missing = await fixture(t, { repository: { getPublicationSlot: async () => null } });
  assert.equal((await missing.request(`/api/publication-resolution/${slotId}/reconcile`, { method: 'POST' })).status, 404);
  assert.equal(serviceCalls.length, 0);
});

test('closed-slot exact lookup validates the ID and forwards it to the repository filter', async t => {
  const searched = [];
  const closed = { id: slotId, status: 'admin_closed_unknown', providerStatus: 'unknown', providerPostId: null,
    profileId: 'old-profile', accountId: 'old-account', lateLinkEligible: true };
  const { request } = await fixture(t, { repository: { listClosedUnknownSlots: async id => { searched.push(id); return id ? [closed] : []; } } });
  const found = await request(`/api/publication-resolution/slots?slotId=${slotId}`);
  assert.equal(found.status, 200);
  assert.deepEqual(found.body.closedSlots, [closed]);
  assert.deepEqual(searched, [slotId]);
  assert.equal((await request('/api/publication-resolution/slots?slotId=not-a-uuid')).status, 400);
  assert.deepEqual(searched, [slotId]);
});

test('linking rejects a different account, platform, provider id, or unconfirmed publication', async t => {
  for (const post of [
    { id: 'post-1', status: 'published', targets: [{ accountId: 'new-account', platform: 'threads', status: 'published' }] },
    { id: 'post-1', status: 'published', targets: [{ accountId: 'old-account', platform: 'instagram', status: 'published' }] },
    { id: 'other', status: 'published', targets: [{ accountId: 'old-account', platform: 'threads', status: 'published' }] },
    { id: 'post-1', status: 'publishing', targets: [{ accountId: 'old-account', platform: 'threads', status: 'publishing' }] },
  ]) {
    const { request, calls } = await fixture(t, { services: { verifyProviderPostForSlot: async () => post } });
    const { confirmDelayedPublication, ...base } = closeBody;
    const result = await request(`/api/publication-resolution/${slotId}/link-provider-post`, { method: 'POST', body: { ...base, providerPostId: 'post-1', confirmOriginalTarget: true } });
    assert.equal(result.status, 409); assert.equal(calls.length, 0);
  }
});

test('link retries return the original decision before any provider request', async t => {
  const event = { slotId, requestId, action: 'link_provider_post', previousStatus: 'admin_closed_unknown', newStatus: 'unknown', replayed: true };
  const { request, calls } = await fixture(t, { repository: { getPublicationResolutionByRequest: async () => event }, services: { verifyProviderPostForSlot: async () => { throw Error('must not repeat verification'); } } });
  const { confirmDelayedPublication, ...base } = closeBody;
  const result = await request(`/api/publication-resolution/${slotId}/link-provider-post`, { method: 'POST', body: { ...base, providerPostId: 'post-1', confirmOriginalTarget: true } });
  assert.equal(result.status, 200); assert.equal(result.body.resolution.replayed, true); assert.equal(calls.length, 0);
});

test('successful provider validation clears only its verified hold and failures keep holds intact', async t => {
  const cleared = []; let failAccount = false; let failModel = false;
  const { request } = await fixture(t, {
    repository: { clearProviderHold: async input => { cleared.push(input); }, listActiveProviderHolds: async () => [{ provider: 'tebar', profileId: 'old-profile', accountId: 'old-account', reasonCode: 'unauthorized' }] },
    services: {
      configuration: { getActive: async () => ({ version: 1 }), history: async () => [], recordValidation: async () => {} },
      configurationValidators: {
        validateAccount: async ({ profileId, accountId }) => { if (failAccount) throw Object.assign(new Error('denied'), { code: 'TEBAR_UNAUTHORIZED', status: 503 }); return { id: accountId, profileId }; },
        validateModel: async () => { if (failModel) throw Object.assign(new Error('denied'), { code: 'OPENROUTER_UNAUTHORIZED', status: 503 }); return { id: 'vendor/model' }; },
      },
    },
  });
  assert.equal((await request('/api/integrations')).body.providerHolds.length, 1);
  assert.equal((await request('/api/integrations/validate-account', { method: 'POST', body: { profileId: 'old-profile', accountId: 'old-account' } })).status, 200);
  assert.deepEqual(cleared[0], { provider: 'tebar', profileId: 'old-profile', accountId: 'old-account', actorId: 7 });
  assert.equal((await request('/api/integrations/validate-model', { method: 'POST', body: { model: 'vendor/model' } })).status, 200);
  assert.deepEqual(cleared[1], { provider: 'openrouter', actorId: 7 });
  failAccount = true; failModel = true;
  assert.equal((await request('/api/integrations/validate-account', { method: 'POST', body: { profileId: 'old-profile', accountId: 'old-account' } })).status, 503);
  assert.equal((await request('/api/integrations/validate-model', { method: 'POST', body: { model: 'vendor/model' } })).status, 503);
  assert.equal(cleared.length, 2);
});

test('link reconciliation runs only after the durable link and leaves an inconclusive result recoverable', async t => {
  for (const inconclusive of [false, true]) {
    let durable = false;
    const { request } = await fixture(t, {
      repository: { linkVerifiedProviderPost: async values => { durable = true; return { ...values, newStatus: 'unknown' }; } },
      services: { reconcileLinkedPublication: async ({ slotId: id }) => { assert.equal(id, slotId); assert.equal(durable, true); if (inconclusive) throw Error('read failed'); return { status: 'published', pending: false }; } },
    });
    const { confirmDelayedPublication, ...base } = closeBody;
    const result = await request(`/api/publication-resolution/${slotId}/link-provider-post`, { method: 'POST', body: { ...base, providerPostId: 'post-1', confirmOriginalTarget: true } });
    assert.equal(result.status, 200); assert.equal(result.body.resolution.newStatus, 'unknown');
    assert.deepEqual(result.body.reconciliation, inconclusive ? { status: 'unknown', pending: true } : { status: 'published', pending: false });
  }
});

test('provider ID must be a string and malformed provider targets remain a safe conflict', async t => {
  const { request, calls } = await fixture(t, { services: { verifyProviderPostForSlot: async () => ({ id: 'post-1', status: 'published', targets: {} }) } });
  const { confirmDelayedPublication, ...base } = closeBody;
  assert.equal((await request(`/api/publication-resolution/${slotId}/link-provider-post`, { method: 'POST', body: { ...base, providerPostId: 123, confirmOriginalTarget: true } })).status, 400);
  assert.equal((await request(`/api/publication-resolution/${slotId}/link-provider-post`, { method: 'POST', body: { ...base, providerPostId: 'post-1', confirmOriginalTarget: true } })).status, 409);
  assert.equal(calls.length, 0);
});

test('malformed publication states and invalid original target snapshots fail before provider GET', async t => {
  for (const invalidSlot of [
    { status: 'published', providerPostId: null, resolutionTargetValid: true },
    { status: 'unknown', providerPostId: 'already-linked', resolutionTargetValid: true },
    { status: 'admin_closed_unknown', providerPostId: null, resolutionTargetValid: false },
  ]) {
    const { request, calls } = await fixture(t, { repository: { getPublicationSlot: async () => ({
      id: slotId, profileId: 'old-profile', accountId: 'old-account', ...invalidSlot,
    }) } });
    const { confirmDelayedPublication, ...base } = closeBody;
    const result = await request(`/api/publication-resolution/${slotId}/link-provider-post`, { method: 'POST', body: { ...base, providerPostId: 'post-1', confirmOriginalTarget: true } });
    assert.equal(result.status, 409);
    assert.equal(calls.length, 0);
  }
});
