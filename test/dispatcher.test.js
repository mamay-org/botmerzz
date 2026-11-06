'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runDispatcher, pauseAutomation } = require('../src/dispatcher');

function harness(overrides = {}) {
  const calls = [];
  const slot = { id: 'slot-1', scheduledAt: '2026-11-05T04:00:00Z' };
  const repository = {
    getRuntimeState: async () => ({ automationEnabled: true, onboardingComplete: true, accountId: 'acct-1', settings: { schedule: { intervalHours: 6, timezone: 'Asia/Kuala_Lumpur', activeDays: [1,2,3,4,5,6,7], activeStart: '00:00', activeEnd: '23:59' } }, facts: [], history: [] }),
    ensureNextDueSlot: async () => ({ slot, created: true, skippedCount: 0 }),
    claimDueSlot: async () => slot,
    savePreparedSlot: async (id, data) => calls.push(['prepared', id, data]),
    startPublishing: async () => true,
    updateSlot: async (id, data) => calls.push(['update', id, data]),
    listUnsettledSlots: async () => [],
    appendActivity: async (data) => calls.push(['activity', data]),
    claimDailySummary: async () => false,
    getDailySummary: async () => ({ published: 0, failed: 0, skipped: 0 }),
    finishDailySummary: async () => {},
    setAutomationEnabled: async (enabled) => calls.push(['enabled', enabled]),
    recordCancellation: async (id, data) => calls.push(['cancel', id, data]),
    ...overrides.repository,
  };
  const publisher = {
    publishNow: async () => ({ id: 'post-1', status: 'published', targets: [{ accountId: 'acct-1', status: 'published' }] }),
    getPost: async () => ({ id: 'post-1', status: 'published', targets: [{ accountId: 'acct-1', status: 'published' }] }),
    listScheduledPosts: async () => ({ data: [], nextCursor: null }),
    cancelPost: async () => ({ id: 'post-1', status: 'canceled', targets: [] }),
    ...overrides.publisher,
  };
  return { calls, slot, repository, publisher };
}

const content = async () => ({ status: 'ready', text: 'Jom kongsi pilihan anda!', pillar: 'topup', factBearing: false, factIds: [] });
const fixedClock = () => new Date('2026-11-05T04:00:00Z');

test('dispatcher persists exact payload and idempotency key before one publish', async () => {
  const { calls, repository, publisher } = harness();
  let publishCalls = 0;
  publisher.publishNow = async (payload, key) => {
    publishCalls++;
    assert.deepEqual(calls[0], ['prepared', 'slot-1', { requestPayload: payload, idempotencyKey: key, caption: payload.content, pillar: 'topup', factBearing: false, factIds: [] }]);
    return { id: 'post-1', status: 'published', targets: [{ accountId: 'acct-1', status: 'published' }] };
  };
  const result = await runDispatcher({ repository, publisher, content, clock: fixedClock });
  assert.equal(result.published, 1);
  assert.equal(publishCalls, 1);
  assert.match(calls[0][2].idempotencyKey, /^km_slot-1$/);
});

test('automation off and incomplete onboarding never claim or publish', async () => {
  for (const patch of [{ automationEnabled: false }, { onboardingComplete: false }]) {
    const { repository, publisher } = harness({ repository: { getRuntimeState: async () => ({ automationEnabled: true, onboardingComplete: true, accountId: 'acct-1', ...patch }) } });
    repository.claimDueSlot = async () => assert.fail('should not claim');
    publisher.publishNow = async () => assert.fail('should not publish');
    const result = await runDispatcher({ repository, publisher, content, clock: fixedClock });
    assert.equal(result.claimed, 0);
  }
});

test('invalid AI result is skipped after content retry policy and never published', async () => {
  const { calls, repository, publisher } = harness();
  publisher.publishNow = async () => assert.fail('must not publish');
  const result = await runDispatcher({ repository, publisher, content: async () => ({ status: 'skipped', reason: 'CONTENT_VALIDATION_FAILED', attempts: 2 }), notifier: { send: async (text) => calls.push(['notice', text]) }, clock: fixedClock });
  assert.equal(result.skipped, 1);
  assert.ok(calls.some((c) => c[0] === 'update' && c[2].status === 'skipped'));
  assert.ok(calls.some((c) => c[0] === 'notice' && /content_validation_failed/.test(c[1])));
});

test('uncertain publishing outcome is recorded unknown and is not blindly retried', async () => {
  const { calls, repository, publisher } = harness();
  let sends = 0;
  publisher.publishNow = async () => { sends++; throw Object.assign(new Error('safe'), { code: 'network_error', unknownOutcome: true }); };
  const result = await runDispatcher({ repository, publisher, content, clock: fixedClock });
  assert.equal(sends, 1);
  assert.equal(result.unknown, 1);
  assert.ok(calls.some((c) => c[0] === 'update' && c[2].status === 'unknown'));
});

test('known retryable provider error replays exactly the same request and idempotency key once', async () => {
  const { repository, publisher } = harness();
  const sent = [];
  publisher.publishNow = async (body, key) => {
    sent.push({ body, key });
    if (sent.length === 1) throw Object.assign(new Error('safe'), { code: 'rate_limited', retryable: true, unknownOutcome: false });
    return { id: 'p2', status: 'published', targets: [{ accountId: 'acct-1', status: 'published' }] };
  };
  const result = await runDispatcher({ repository, publisher, content, clock: fixedClock });
  assert.equal(result.published, 1);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], sent[1]);
});

test('duplicate/concurrent slot claim outcome means no publish', async () => {
  const { repository, publisher } = harness();
  repository.claimDueSlot = async () => null;
  publisher.publishNow = async () => assert.fail('must not publish');
  const result = await runDispatcher({ repository, publisher, content, clock: fixedClock });
  assert.equal(result.claimed, 0);
});

test('first active run atomically plans the first slot using persisted schedule and timezone', async () => {
  const { repository, publisher, slot } = harness();
  let plan;
  repository.ensureNextDueSlot = async (input) => { plan = input; return { slot, created: true, skippedCount: 0 }; };
  const result = await runDispatcher({ repository, publisher, content, clock: fixedClock });
  assert.equal(result.claimed, 1);
  assert.equal(plan.timezone, 'Asia/Kuala_Lumpur');
  assert.deepEqual(plan.schedule, { intervalHours: 6, timezone: 'Asia/Kuala_Lumpur', activeDays: [1,2,3,4,5,6,7], activeStart: '00:00', activeEnd: '23:59' });
});

test('missed slots are recorded as skipped by the atomic planner and are not caught up', async () => {
  const { calls, repository, publisher } = harness();
  let claims = 0;
  repository.ensureNextDueSlot = async () => ({ slot: null, created: false, skippedCount: 2 });
  repository.claimDueSlot = async () => { claims++; return null; };
  publisher.publishNow = async () => assert.fail('missed slots must not be caught up');
  const result = await runDispatcher({ repository, publisher, content, clock: fixedClock });
  assert.equal(result.skipped, 2);
  assert.equal(claims, 0);
  assert.ok(calls.some((call) => call[0] === 'activity' && call[1].event === 'missed_slots_skipped'));
});

test('planner duplicate return and empty atomic claim on repeated cron runs cannot duplicate publish', async () => {
  const { repository, publisher, slot } = harness();
  let plannerCreates = 0;
  let claimed = false;
  let publishes = 0;
  repository.ensureNextDueSlot = async () => {
    if (plannerCreates++ === 0) return { slot, created: true, skippedCount: 0 };
    return { slot, created: false, skippedCount: 0 };
  };
  repository.claimDueSlot = async () => { if (claimed) return null; claimed = true; return slot; };
  publisher.publishNow = async () => { publishes++; return { id: 'post-1', status: 'published', targets: [{ accountId: 'acct-1', status: 'published' }] }; };
  const first = await runDispatcher({ repository, publisher, content, clock: fixedClock });
  const second = await runDispatcher({ repository, publisher, content, clock: fixedClock });
  assert.equal(first.published, 1);
  assert.equal(second.claimed, 0);
  assert.equal(publishes, 1);
});

test('planner uses stored regional timezone even when process timezone differs', async () => {
  const { repository, publisher } = harness({ repository: { getRuntimeState: async () => ({
    automationEnabled: true, onboardingComplete: true, accountId: 'acct-1',
    settings: { schedule: { intervalHours: 6, timezone: 'America/Los_Angeles', activeDays: [1,2,3,4,5,6,7], activeStart: '09:00', activeEnd: '22:00' } },
    facts: [], history: [],
  }) } });
  let plannerArgs;
  repository.ensureNextDueSlot = async (args) => { plannerArgs = args; return { slot: null, created: false, skippedCount: 0 }; };
  repository.claimDueSlot = async () => null;
  await runDispatcher({ repository, publisher, content, clock: fixedClock, timezone: 'Asia/Kuala_Lumpur' });
  assert.equal(plannerArgs.timezone, 'America/Los_Angeles');
});

test('prepared ready slot reuses persisted payload and idempotency key without generating again', async () => {
  const { calls, repository, publisher } = harness();
  const durablePayload = { content: 'Jom kongsi pilihan anda!\nTop-up ML.\nhttps://example.test/t', targets: [{ account_id: 'acct-1' }] };
  repository.claimDueSlot = async () => ({ id: 'slot-ready', status: 'ready', requestPayload: durablePayload, idempotencyKey: 'persisted-key', caption: durablePayload.content, pillar: 'topup', factBearing: true, factIds: [9] });
  const generatedContent = async () => assert.fail('prepared content must not be regenerated');
  publisher.publishNow = async (payload, key) => {
    assert.equal(payload, durablePayload);
    assert.equal(key, 'persisted-key');
    return { id: 'post-ready', status: 'published', targets: [{ accountId: 'acct-1', status: 'published' }] };
  };
  const result = await runDispatcher({ repository, publisher, content: generatedContent, clock: fixedClock });
  assert.equal(result.published, 1);
  assert.equal(calls.some((call) => call[0] === 'prepared'), false);
});

test('database persistence failure after Tebar accepts publish never triggers a second publish', async () => {
  const { calls, repository, publisher } = harness();
  let publishes = 0;
  let slotUpdates = 0;
  publisher.publishNow = async () => { publishes++; return { id: 'accepted-post', status: 'published', targets: [{ accountId: 'acct-1', status: 'published' }] }; };
  repository.updateSlot = async (id, patch) => {
    slotUpdates++;
    calls.push(['update', id, patch]);
    if (slotUpdates === 1) throw new Error('database unavailable');
  };
  const result = await runDispatcher({ repository, publisher, content, clock: fixedClock });
  assert.equal(publishes, 1);
  assert.equal(result.unknown, 1);
  assert.ok(calls.some((call) => call[0] === 'update' && call[2].providerPostId === 'accepted-post' && call[2].status === 'unknown'));
});

test('paused automation does not plan or claim a new slot', async () => {
  const { repository, publisher } = harness({ repository: { getRuntimeState: async () => ({ automationEnabled: false, onboardingComplete: true, accountId: 'acct-1', settings: { schedule: {} } }) } });
  repository.ensureNextDueSlot = async () => assert.fail('paused automation must not plan');
  repository.claimDueSlot = async () => assert.fail('paused automation must not claim');
  const result = await runDispatcher({ repository, publisher, content, clock: fixedClock });
  assert.equal(result.claimed, 0);
});

test('a claimed slot outside its active window is skipped without publication', async () => {
  const { calls, repository, publisher } = harness();
  repository.claimDueSlot = async () => ({ id: 'slot-late', scheduledAt: '2026-11-05T15:00:00Z' });
  repository.getRuntimeState = async () => ({ automationEnabled: true, onboardingComplete: true, accountId: 'acct-1', settings: { schedule: { intervalHours: 6, timezone: 'Asia/Kuala_Lumpur', activeDays: [1,2,3,4,5,6,7], activeStart: '09:00', activeEnd: '22:00' } }, facts: [], history: [] });
  publisher.publishNow = async () => assert.fail('outside-window slots must not publish');
  const result = await runDispatcher({ repository, publisher, content, clock: fixedClock });
  assert.equal(result.skipped, 1);
  assert.ok(calls.some((call) => call[0] === 'update' && call[2].errorCode === 'outside_active_window'));
});

test('pause disables automation before listing and cancels only locally known scheduled posts', async () => {
  const order = [];
  const { repository, publisher } = harness({ repository: {
    setAutomationEnabled: async (enabled) => order.push(`enabled:${enabled}`),
    listUnsettledSlots: async () => [{ providerPostId: 'owned-1' }],
  }, publisher: {
    listScheduledPosts: async () => { order.push('list'); return { data: [{ id: 'owned-1', status: 'scheduled' }, { id: 'manual-1', status: 'scheduled' }], nextCursor: null }; },
    cancelPost: async (id) => { order.push(`cancel:${id}`); return { id, status: 'canceled' }; },
  } });
  const result = await pauseAutomation({ repository, publisher });
  assert.deepEqual(order, ['enabled:false', 'list', 'cancel:owned-1']);
  assert.deepEqual(result.outcomes, [{ postId: 'owned-1', status: 'canceled' }]);
});

test('pause records a cancellation race as in_flight instead of canceled', async () => {
  const { calls, repository, publisher } = harness({ repository: { listUnsettledSlots: async () => [{ providerPostId: 'p1' }] }, publisher: { listScheduledPosts: async () => ({ data: [{ id: 'p1', status: 'scheduled' }], nextCursor: null }), cancelPost: async () => ({ id: 'p1', status: 'publishing' }) } });
  const result = await pauseAutomation({ repository, publisher });
  assert.equal(result.outcomes[0].status, 'in_flight');
  assert.ok(calls.some((call) => call[0] === 'cancel' && call[2].status === 'in_flight'));
});

test('reconciliation reads known provider IDs and persists provider status', async () => {
  const { calls, repository, publisher } = harness({ repository: { listUnsettledSlots: async () => [{ id: 'slot-2', providerPostId: 'p2', requestPayload: { targets: [{ account_id: 'acct-1' }] } }] }, publisher: { getPost: async () => ({ id: 'p2', status: 'published', targets: [{ accountId: 'acct-1', status: 'published' }] }) } });
  const result = await runDispatcher({ repository, publisher, content, clock: fixedClock });
  assert.equal(result.reconciled, 1);
  assert.ok(calls.some((c) => c[0] === 'update' && c[1] === 'slot-2' && c[2].status === 'published'));
});

test('unknown publish without provider ID is not replayed and blocks new slots', async () => {
  const { calls, repository, publisher } = harness({ repository: {
    listUnsettledSlots: async () => [{ id: 'slot-unknown', status: 'unknown', requestPayload: { content: 'same payload', targets: [{ account_id: 'acct-1' }] }, idempotencyKey: 'same-key' }],
  } });
  let sends = 0;
  repository.claimDueSlot = async () => assert.fail('unresolved publish must block new slots');
  publisher.publishNow = async () => { sends++; assert.fail('ambiguous publish must not be replayed'); };
  const result = await runDispatcher({ repository, publisher, content, clock: fixedClock });
  assert.equal(result.reconciled, 0);
  assert.equal(result.unknown, 1);
  assert.equal(sends, 0);
  assert.equal(calls.some((call) => call[0] === 'update'), false);
});

test('confirmed publication sends one deduplicated success notice', async () => {
  const { repository, publisher } = harness();
  const notices = [];
  const result = await runDispatcher({ repository, publisher, content, notifier: { send: async (...args) => notices.push(args) }, clock: fixedClock });
  assert.equal(result.published, 1);
  assert.equal(notices.length, 1);
  assert.match(notices[0][0], /post_published/);
  assert.equal(notices[0][1], 'post_published:slot:slot-1');
});

test('reconciled partial post is counted as failure and sends a safe alert', async () => {
  const { calls, repository, publisher } = harness({ repository: {
    listUnsettledSlots: async () => [{ id: 'slot-partial', providerPostId: 'p-partial' }],
    getRuntimeState: async () => ({ automationEnabled: false }),
  }, publisher: { getPost: async () => ({ id: 'p-partial', status: 'partial', targets: [] }) } });
  const result = await runDispatcher({ repository, publisher, content, notifier: { send: async (message) => calls.push(['notice', message]) }, clock: fixedClock });
  assert.equal(result.reconciled, 1);
  assert.equal(result.failed, 1);
  assert.ok(calls.some((call) => call[0] === 'notice' && call[1].includes('provider_error')));
});

test('top-level published status without a published target stays unknown', async () => {
  const { repository, publisher } = harness({ publisher: { publishNow: async () => ({ id: 'p-uncertain', status: 'published', targets: [] }) } });
  const result = await runDispatcher({ repository, publisher, content, clock: fixedClock });
  assert.equal(result.published, 0);
  assert.equal(result.unknown, 1);
});
