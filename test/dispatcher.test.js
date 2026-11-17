'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runDispatcher, pauseAutomation, maybeSendDailySummary, reconcileUnsettled, reconcileSwitch } = require('../src/dispatcher');
const { contentSafetyHash, legacyContentSafetyHash } = require('../src/content-safety');

function harness(overrides = {}) {
  const calls = [];
  const slot = { id: 'slot-1', scheduledAt: '2026-11-05T04:00:00Z', automationSessionId: 'session-1' };
  const repository = {
    getRuntimeState: async () => ({ automationEnabled: true, onboardingComplete: true, accountId: 'acct-1', settings: { automationSessionId: 'session-1', schedule: { intervalHours: 6, timezone: 'Asia/Kuala_Lumpur', activeDays: [1,2,3,4,5,6,7], activeStart: '00:00', activeEnd: '23:59' } }, facts: [], history: [] }),
    ensureNextDueSlot: async () => ({ slot, created: true, skippedCount: 0 }),
    claimDueSlot: async () => slot,
    savePreparedSlot: async (id, data) => calls.push(['prepared', id, data]),
    startPublishing: async () => true,
    updateSlot: async (id, data) => calls.push(['update', id, data]),
    withPublicationFence: async (id, publish) => publish((patch) => repository.updateSlot(id, patch)),
    listUnsettledSlots: async () => [],
    appendActivity: async (data) => calls.push(['activity', data]),
    claimDailySummary: async () => false,
    getDailySummary: async () => ({ published: 0, failed: 0, skipped: 0 }),
    finishDailySummary: async () => {},
    setAutomationEnabled: async (enabled) => calls.push(['enabled', enabled]),
    isAutomationSessionActive: async () => true,
    recordCancellation: async (id, data) => calls.push(['cancel', id, data]),
    ...overrides.repository,
  };
  const publisher = {
    publishNow: async () => ({ id: 'post-1', status: 'published', targets: [{ accountId: 'acct-1', platform: 'threads', status: 'published' }] }),
    getPost: async () => ({ id: 'post-1', status: 'published', targets: [{ accountId: 'acct-1', platform: 'threads', status: 'published' }] }),
    listScheduledPosts: async () => ({ data: [], nextCursor: null }),
    cancelPost: async () => ({ id: 'post-1', status: 'canceled', targets: [] }),
    ...overrides.publisher,
  };
  return { calls, slot, repository, publisher };
}

const content = async () => ({ status: 'ready', text: 'Jom kongsi pilihan anda!', pillar: 'topup', factBearing: false, factIds: [] });
const fixedClock = () => new Date('2026-11-05T04:00:00Z');

test('dynamic dispatcher binds publication and both AI calls to the slot snapshot', async () => {
  const { slot, repository, publisher } = harness();
  Object.assign(slot, { profileId: 'old-profile', accountId: 'acct-1', model: 'vendor/model-old' });
  const state = await repository.getRuntimeState();
  state.profileId = 'old-profile';
  repository.getRuntimeState = async () => state;
  const models=[]; const profiles=[]; const aiCalls=[]; const logs=[];
  const result = await runDispatcher({ repository, publisher, clock: fixedClock,
    publisherForProfile: async profile => { profiles.push(profile); return publisher; },
    generatorForModel: async model => { models.push(model); return async input => { aiCalls.push(input); return 'ok'; }; },
    logger: { info: (event, details) => logs.push({ event, details }) }, correlationId: 'correlation-test',
    content: async (_context, { generate }) => { await generate('generation'); await generate('audit'); return content(); },
  });
  assert.equal(result.published,1);
  assert.deepEqual(models,['vendor/model-old']);
  assert.deepEqual(profiles,['old-profile']);
  assert.deepEqual(aiCalls,['generation','audit']);
  assert.ok(logs.some(entry=>entry.event==='publication.sending' && entry.details.correlationId==='correlation-test' && entry.details.slotId==='slot-1'));
  assert.doesNotMatch(JSON.stringify(logs),/Jom kongsi|authorization|password/i);
});

test('reconciliation uses original profile and refuses missing or inconsistent snapshots', async () => {
  const { repository } = harness(); const selected=[]; const updates=[];
  repository.listUnsettledSlots=async()=>[
    { id:'old',profileId:'old-profile',accountId:'old-account',providerPostId:'post-old',requestPayload:{targets:[{account_id:'old-account'}]} },
    { id:'legacy',providerPostId:'post-legacy',requestPayload:{targets:[{account_id:'old-account'}]} },
    { id:'mismatch',profileId:'old-profile',accountId:'old-account',providerPostId:'post-mismatch',requestPayload:{targets:[{account_id:'new-account'}]} },
  ];
  repository.updateSlot=async(id,patch)=>updates.push({id,patch});
  const checked=await reconcileUnsettled({repository,clock:fixedClock,publisherForProfile:async profile=>{
    selected.push(profile); return { getPost:async()=>({id:'post-old',status:'published',targets:[{accountId:'old-account',platform:'threads',status:'published'}]}) };
  }});
  assert.equal(checked,1); assert.deepEqual(selected,['old-profile']);
  assert.deepEqual(updates.map(update=>update.id),['old']);
});

test('reconciliation does not report success when a concurrent status change rejects its update', async () => {
  const { repository } = harness(); const notices=[];
  repository.listUnsettledSlots=async()=>[{id:'slot',profileId:'profile',accountId:'acct',providerPostId:'post',requestPayload:{targets:[{account_id:'acct'}]}}];
  repository.updateSlot=async()=>false;
  const counts={published:0,failed:0,unknown:0};
  const checked=await reconcileUnsettled({repository,counts,notifier:{send:async message=>notices.push(message)},publisherForProfile:async()=>({getPost:async()=>({id:'post',status:'published',targets:[{accountId:'acct',platform:'threads',status:'published'}]})})});
  assert.equal(checked,0); assert.deepEqual(counts,{published:0,failed:0,unknown:1}); assert.deepEqual(notices,[]);
});

test('stale publishing without a provider ID becomes an operator-review blocker without any provider mutation', async () => {
  const { repository, publisher } = harness();
  const recoveries = [];
  const notices = [];
  const log = [];
  repository.recoverStalePublishing = async ({ now }) => {
    recoveries.push(now);
    return ['interrupted-slot'];
  };
  repository.listUnsettledSlots = async () => [{
    id: 'interrupted-slot', status: 'unknown', providerStatus: 'unknown', providerPostId: null,
    profileId: 'original-profile', accountId: 'original-account',
    requestPayload: { content: 'saved payload', targets: [{ account_id: 'original-account' }] },
    idempotencyKey: 'saved-key',
  }];
  publisher.publishNow = async () => assert.fail('stale publication must never be replayed');
  publisher.getPost = async () => assert.fail('a missing provider ID cannot be reconciled by provider GET');

  const checked = await reconcileUnsettled({
    repository, publisher, clock: fixedClock,
    notifier: { send: async (...args) => notices.push(args) },
    logger: { warn: (...args) => log.push(args) },
  });

  assert.equal(checked, 0);
  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0].toISOString(), fixedClock().toISOString());
  assert.equal(notices.length, 1);
  assert.match(notices[0][0], /belum dapat dipastikan|konfirmasi/i);
  assert.ok(log.some(([event]) => event === 'publication.worker_interrupted'));
});

test('slot-scoped reconciliation reads and updates only the linked publication without a provider mutation', async () => {
  const { repository, publisher } = harness();
  const reads = []; const updates = []; const recoveryCalls = [];
  repository.recoverStalePublishing = async options => { recoveryCalls.push(options); return []; };
  repository.listUnsettledSlots = async () => [
    { id: 'linked-slot', profileId: 'original-profile', accountId: 'original-account', providerPostId: 'verified-post', requestPayload: { targets: [{ account_id: 'original-account' }] } },
    { id: 'other-slot', profileId: 'other-profile', accountId: 'other-account', providerPostId: 'other-post', requestPayload: { targets: [{ account_id: 'other-account' }] } },
  ];
  repository.updateSlot = async (id, patch) => { updates.push({ id, patch }); return true; };
  publisher.getPost = async (id) => { reads.push(id); return { id, status: 'published', targets: [{ accountId: 'original-account', platform: 'threads', status: 'published' }] }; };
  publisher.publishNow = async () => assert.fail('manual linking must never republish');
  const checked = await reconcileUnsettled({ repository, publisher, slotIds: ['linked-slot'], clock: fixedClock });
  assert.equal(checked, 1);
  assert.deepEqual(recoveryCalls.map(call => call.slotIds), [['linked-slot']]);
  assert.deepEqual(reads, ['verified-post']);
  assert.deepEqual(updates.map((update) => update.id), ['linked-slot']);
  assert.equal(updates[0].patch.status, 'published');
});

test('reconciliation refuses mismatched provider IDs and non-original Threads targets', async () => {
  const { repository } = harness();
  const updates = [];
  repository.listUnsettledSlots = async () => [
    { id: 'id-mismatch', profileId: 'profile', accountId: 'acct', providerPostId: 'requested-post', requestPayload: { targets: [{ account_id: 'acct' }] } },
    { id: 'target-mismatch', profileId: 'profile', accountId: 'acct', providerPostId: 'failed-other-account', requestPayload: { targets: [{ account_id: 'acct' }] } },
  ];
  repository.updateSlot = async (...args) => { updates.push(args); return true; };
  const checked = await reconcileUnsettled({ repository, publisherForProfile: async () => ({ getPost: async (id) => id === 'requested-post'
    ? { id: 'different-post', status: 'published', targets: [{ accountId: 'acct', platform: 'threads', status: 'published' }] }
    : { id, status: 'failed', targets: [{ accountId: 'other-acct', platform: 'threads', status: 'failed' }] } }), clock: fixedClock });
  assert.equal(checked, 0);
  assert.deepEqual(updates, []);
});

test('dispatcher persists exact payload and idempotency key before one publish', async () => {
  const { calls, repository, publisher } = harness();
  let publishCalls = 0;
  publisher.publishNow = async (payload, key) => {
    publishCalls++;
    assert.deepEqual(calls[0], ['prepared', 'slot-1', { requestPayload: payload, idempotencyKey: key, caption: payload.content, pillar: 'topup', factBearing: false, factIds: [], contentSafetyHash: contentSafetyHash((await repository.getRuntimeState()).settings) }]);
    return { id: 'post-1', status: 'published', targets: [{ accountId: 'acct-1', platform: 'threads', status: 'published' }] };
  };
  const result = await runDispatcher({ repository, publisher, content, clock: fixedClock });
  assert.equal(result.published, 1);
  assert.equal(publishCalls, 1);
  assert.match(calls[0][2].idempotencyKey, /^km_slot-1$/);
});

test('authoritative attempt persistence failure fails the slot before ready payload or publishing', async () => {
  const { calls, repository, publisher } = harness();
  publisher.publishNow = async () => assert.fail('must not publish after attempt persistence failure');
  const result = await runDispatcher({
    repository,
    publisher,
    content: async () => { throw Object.assign(new Error('attempt database unavailable'), { code: 'ER_CON_COUNT_ERROR' }); },
    clock: fixedClock,
  });
  assert.equal(result.failed, 1);
  assert.equal(calls.some(([kind]) => kind === 'prepared'), false);
  assert.ok(calls.some(([kind, , patch]) => kind === 'update' && patch.status === 'failed'));
});

test('dispatcher persists and publishes the exact final caption including hashtags', async () => {
  const finalText = 'Jom kongsi pilihan anda!\nhttps://example.test/topup\n#KedaiMerzz';
  const { calls, repository, publisher } = harness();
  const saved = async () => ({ status: 'ready', text: finalText, pillar: 'topup', factBearing: false, factIds: [] });
  let sentPayload;
  publisher.publishNow = async (payload) => { sentPayload = payload; return { id: 'post-hashtag', status: 'published', targets: [{ accountId: 'acct-1', platform: 'threads', status: 'published' }] }; };
  const result = await runDispatcher({ repository, publisher, content: saved, clock: fixedClock });
  const prepared = calls.find(([kind]) => kind === 'prepared')[2];
  assert.equal(result.published, 1);
  assert.equal(prepared.requestPayload.content, finalText);
  assert.equal(prepared.caption, finalText);
  assert.deepEqual(sentPayload, prepared.requestPayload);
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

test('invalid AI result is recorded as a confirmed failure after content retry policy', async () => {
  const { calls, repository, publisher } = harness();
  publisher.publishNow = async () => assert.fail('must not publish');
  let clockCalls = 0;
  const result = await runDispatcher({ repository, publisher, content: async () => ({ status: 'skipped', reason: 'CONTENT_VALIDATION_FAILED', attempts: 2 }), notifier: { send: async (text) => calls.push(['notice', text]) }, clock: () => new Date(clockCalls++ === 0 ? '2026-11-05T04:00:00Z' : '2026-11-05T04:02:00Z') });
  assert.equal(result.failed, 1);
  assert.equal(result.skipped, 0);
  assert.ok(calls.some((c) => c[0] === 'update' && c[2].status === 'failed' && c[2].completedAt === '2026-11-05T04:02:00.000Z'));
  assert.ok(calls.some((c) => c[0] === 'activity' && c[1].event === 'ai_generation_failed'));
  assert.ok(calls.some((c) => c[0] === 'notice' && /tidak memenuhi aturan validasi/i.test(c[1])));
});

test('generation failure diagnostics are persisted and only allowlisted codes reach Telegram', async () => {
  const { calls, repository, publisher } = harness();
  publisher.publishNow = async () => assert.fail('must not publish');
  const notices = [];
  const runFailure = (diagnosticCode) => runDispatcher({
    repository, publisher,
    content: async () => ({ status: 'skipped', reason: 'GENERATION_FAILED', diagnosticCode, attempts: 2 }),
    notifier: { send: async (message) => notices.push(message) },
    clock: fixedClock,
  });

  assert.equal((await runFailure('ai_network_error')).failed, 1);
  const safeActivity = calls.find((call) => call[0] === 'activity' && call[1].event === 'ai_generation_failed');
  assert.equal(safeActivity[1].details.diagnosticCode, 'ai_network_error');
  assert.ok(notices.some((message) => /tidak dapat dihubungi/i.test(message)));

  calls.length = 0;
  notices.length = 0;
  await runFailure('provider secret response');
  const unsafeActivity = calls.find((call) => call[0] === 'activity' && call[1].event === 'ai_generation_failed');
  assert.equal(unsafeActivity[1].details.diagnosticCode, 'content_service_error');
  assert.ok(notices.every((message) => !/provider secret response/.test(message)));
});

test('stale generation slot details appear as a safe Telegram diagnostic', async () => {
  const { repository, publisher } = harness({ repository: {
    ensureNextDueSlot: async () => ({
      slot: null, created: false, skippedCount: 0,
      failedSlotIds: ['slot-stale'],
      failedSlotDetails: [{ id: 'slot-stale', diagnosticCode: 'stale_generation' }],
    }),
  } });
  const notices = [];
  const result = await runDispatcher({
    repository, publisher, content,
    notifier: { send: async (message) => notices.push(message) },
    clock: fixedClock,
  });
  assert.equal(result.failed, 1);
  assert.ok(notices.some((message) => /melewati batas waktu/i.test(message) && /slot-stale/.test(message)));
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

test('a terminal failed slot does not stop the next scheduled dispatcher run', async () => {
  const { calls, slot, repository, publisher } = harness();
  const nextSlot = { ...slot, id: 'slot-after-failure' };
  let publishCalls = 0;
  publisher.publishNow = async () => {
    publishCalls++;
    if (publishCalls === 1) throw Object.assign(new Error('definitive provider rejection'), { code: 'invalid_response', status: 400, unknownOutcome: false, retryable: false });
    return { id: 'post-after-failure', status: 'published', targets: [{ accountId: 'acct-1', platform: 'threads', status: 'published' }] };
  };

  const failed = await runDispatcher({ repository, publisher, content, clock: fixedClock });
  assert.equal(failed.failed, 1);
  assert.ok(calls.some(([kind, id, patch]) => kind === 'update' && id === slot.id && patch.status === 'failed'));
  repository.ensureNextDueSlot = async () => ({ slot: nextSlot, created: true, skippedCount: 0 });
  repository.claimDueSlot = async () => nextSlot;

  const next = await runDispatcher({ repository, publisher, content, clock: fixedClock });
  assert.equal(next.published, 1);
  assert.equal(next.failed, 0);
  assert.equal(publishCalls, 2);
  assert.equal((await repository.listUnsettledSlots()).length, 0);
});

test('minimum cadence race waits with the prepared slot instead of canceling or publishing it', async () => {
  const { calls, repository, publisher } = harness({ repository: { startPublishing: async () => 'minimum_cadence' } });
  publisher.publishNow = async () => assert.fail('must respect actual publication cooldown');
  const result = await runDispatcher({ repository, publisher, content, clock: fixedClock });
  assert.equal(result.published, 0);
  assert.equal(result.skipped, 1);
  assert.ok(calls.some((call) => call[0] === 'activity' && call[1].event === 'cadence_cooldown_wait'));
  assert.equal(calls.some((call) => call[0] === 'update' && call[2].status === 'canceled'), false);
});

test('an overlapping dispatcher leaves its prepared slot ready without publishing', async () => {
  const { calls, repository, publisher } = harness({ repository: { startPublishing: async () => 'in_flight' } });
  publisher.publishNow = async () => assert.fail('an overlapping slot must wait');
  const result = await runDispatcher({ repository, publisher, content, clock: fixedClock });
  assert.equal(result.published, 0);
  assert.equal(result.skipped, 1);
  assert.ok(calls.some((call) => call[0] === 'activity' && call[1].event === 'dispatch_overlap_wait'));
  assert.equal(calls.some((call) => call[0] === 'update' && call[2].status === 'canceled'), false);
});

test('known retryable provider error replays exactly the same request and idempotency key once', async () => {
  const { repository, publisher } = harness();
  const sent = [];
  publisher.publishNow = async (body, key) => {
    sent.push({ body, key });
    if (sent.length === 1) throw Object.assign(new Error('safe'), { code: 'rate_limited', retryable: true, unknownOutcome: false });
    return { id: 'p2', status: 'published', targets: [{ accountId: 'acct-1', platform: 'threads', status: 'published' }] };
  };
  const result = await runDispatcher({ repository, publisher, content, clock: fixedClock });
  assert.equal(result.published, 1);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], sent[1]);
});

test('pause between retry attempts records the confirmed provider failure without retrying', async () => {
  let activeChecks = 0;
  let publishCalls = 0;
  const notices = [];
  const { calls, repository, publisher } = harness({ repository: {
    isAutomationSessionActive: async () => {
      activeChecks++;
      // The retry check sees the session active, then pause lands before the next loop check.
      if (activeChecks === 3) return true;
      return activeChecks < 3;
    },
  } });
  publisher.publishNow = async () => {
    publishCalls++;
    throw Object.assign(new Error('definitive retryable rejection'), { code: 'rate_limited', retryable: true, unknownOutcome: false });
  };
  const result = await runDispatcher({ repository, publisher, content, notifier: { send: async (message) => notices.push(message) }, clock: fixedClock });

  assert.equal(publishCalls, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.skipped, 0);
  assert.ok(calls.some((call) => call[0] === 'update' && call[2].status === 'failed' && call[2].errorCode === 'rate_limited' && call[2].completedAt === fixedClock().toISOString()));
  assert.ok(calls.some((call) => call[0] === 'activity' && call[1].event === 'publish_failed' && call[1].details.code === 'rate_limited'));
  assert.ok(notices.some((message) => /membatasi permintaan/i.test(message)));
  assert.equal(calls.some((call) => call[0] === 'update' && call[2].status === 'canceled'), false);
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
  publisher.publishNow = async () => { publishes++; return { id: 'post-1', status: 'published', targets: [{ accountId: 'acct-1', platform: 'threads', status: 'published' }] }; };
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

test('daily summary is sent at 22:00 Malaysia time regardless of legacy schedule timezone', async () => {
  const calls = [];
  await maybeSendDailySummary({
    repository: {
      claimDailySummary: async (input) => { calls.push(['claim', input]); return true; },
      getDailySummary: async (input) => { calls.push(['summary', input]); return { published: 3, failed: 1, skipped: 0 }; },
      finishDailySummary: async (input) => calls.push(['finish', input]),
    },
    notifier: { send: async (_message, dedupeKey) => calls.push(['send', dedupeKey]) },
    now: new Date('2026-11-06T14:00:00.000Z'),
    timezone: 'America/Los_Angeles',
    counts: {},
  });
  assert.deepEqual(calls[0], ['claim', { localDate: '2026-11-06', timezone: 'Asia/Kuala_Lumpur' }]);
  assert.deepEqual(calls[1], ['summary', { localDate: '2026-11-06', timezone: 'Asia/Kuala_Lumpur' }]);
  assert.equal(calls[2][0], 'send');
  assert.equal(calls[2][1], 'daily-summary:2026-11-06:Asia/Kuala_Lumpur');
  assert.deepEqual(calls[3], ['finish', { localDate: '2026-11-06', timezone: 'Asia/Kuala_Lumpur', status: 'sent' }]);
});

test('prepared ready slot reuses persisted payload and idempotency key without generating again', async () => {
  const { calls, repository, publisher } = harness();
  const durablePayload = { content: 'Jom kongsi pilihan anda!\nTop-up ML.\nhttps://example.test/t', targets: [{ account_id: 'acct-1' }] };
  const safetyHash = contentSafetyHash((await repository.getRuntimeState()).settings);
  repository.claimDueSlot = async () => ({ id: 'slot-ready', automationSessionId: 'session-1', status: 'ready', requestPayload: durablePayload, idempotencyKey: 'persisted-key', caption: durablePayload.content, pillar: 'topup', factBearing: true, factIds: ['topup'], factVersions: [{ id: 'topup', updatedAt: '2026-11-05T03:00:00Z' }], contentSafetyHash: safetyHash });
  const generatedContent = async () => assert.fail('prepared content must not be regenerated');
  publisher.publishNow = async (payload, key) => {
    assert.equal(payload, durablePayload);
    assert.equal(key, 'persisted-key');
    return { id: 'post-ready', status: 'published', targets: [{ accountId: 'acct-1', platform: 'threads', status: 'published' }] };
  };
  const result = await runDispatcher({ repository, publisher, content: generatedContent, clock: fixedClock });
  assert.equal(result.published, 1);
  assert.equal(calls.some((call) => call[0] === 'prepared'), false);
});

test('prepared legacy slot remains publishable after an interval configuration update', async () => {
  const { repository, publisher } = harness();
  const savedSettings = (await repository.getRuntimeState()).settings;
  const payload = { content: 'Prepared before the interval change.', targets: [{ account_id: 'acct-1' }] };
  repository.claimDueSlot = async () => ({
    id: 'legacy-ready', automationSessionId: 'session-1', status: 'ready', requestPayload: payload,
    idempotencyKey: 'legacy-key', caption: payload.content, pillar: 'topup', factBearing: false,
    factIds: [], factVersions: [], contentSafetyHash: legacyContentSafetyHash(savedSettings),
  });
  const updatedSchedule = { ...savedSettings.schedule, intervalMinutes: 15 };
  delete updatedSchedule.intervalHours;
  repository.getRuntimeState = async () => ({
    automationEnabled: true, onboardingComplete: true, accountId: 'acct-1',
    settings: { ...savedSettings, schedule: updatedSchedule }, facts: [], history: [],
  });
  let sent;
  publisher.publishNow = async (body, key) => {
    sent = { body, key };
    return { id: 'legacy-post', status: 'published', targets: [{ accountId: 'acct-1', platform: 'threads', status: 'published' }] };
  };
  const result = await runDispatcher({ repository, publisher, content: async () => assert.fail('legacy payload must not regenerate'), clock: fixedClock });
  assert.equal(result.published, 1);
  assert.deepEqual(sent, { body: payload, key: 'legacy-key' });
});

test('legacy ready caption without safety snapshot is failed without publishing', async () => {
  const { calls, repository, publisher } = harness();
  repository.claimDueSlot = async () => ({ id: 'old', automationSessionId: 'session-1', status: 'ready', requestPayload: { content: 'Lama', targets: [{ account_id: 'acct-1' }] }, idempotencyKey: 'old-key', factBearing: true, factIds: ['topup'] });
  publisher.publishNow = async () => assert.fail('legacy facts must not be published');
  const result = await runDispatcher({ repository, publisher, content, clock: fixedClock });
  assert.equal(result.failed, 1);
  assert.ok(calls.some((entry) => entry[0] === 'activity' && entry[1].details.diagnosticCode === 'stale_facts'));
});

test('repository freshness rejection fails prepared content before Tebar', async () => {
  const { calls, repository, publisher } = harness({ repository: { startPublishing: async () => 'stale_facts' } });
  publisher.publishNow = async () => assert.fail('stale facts must not publish');
  const result = await runDispatcher({ repository, publisher, content, clock: fixedClock });
  assert.equal(result.failed, 1);
  assert.ok(calls.some((entry) => entry[0] === 'activity' && entry[1].details.diagnosticCode === 'stale_facts'));
});

test('database persistence failure after Tebar accepts publish never triggers a second publish', async () => {
  const { calls, repository, publisher } = harness();
  let publishes = 0;
  let slotUpdates = 0;
  publisher.publishNow = async () => { publishes++; return { id: 'accepted-post', status: 'published', targets: [{ accountId: 'acct-1', platform: 'threads', status: 'published' }] }; };
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

test('a claimed slot at night publishes despite legacy active hours', async () => {
  const { repository, publisher } = harness();
  repository.claimDueSlot = async () => ({ id: 'slot-late', automationSessionId: 'session-1', scheduledAt: '2026-11-05T15:00:00Z' });
  repository.getRuntimeState = async () => ({ automationEnabled: true, onboardingComplete: true, accountId: 'acct-1', settings: { automationSessionId: 'session-1', schedule: { intervalHours: 1, timezone: 'Asia/Kuala_Lumpur', activeDays: [1,2,3,4,5,6,7], activeStart: '09:00', activeEnd: '22:00' } }, facts: [], history: [] });
  let publishes = 0;
  publisher.publishNow = async () => { publishes++; return { id: 'night-post', status: 'published', targets: [{ accountId: 'acct-1', platform: 'threads', status: 'published' }] }; };
  const result = await runDispatcher({ repository, publisher, content, clock: fixedClock });
  assert.equal(result.skipped, 0);
  assert.equal(result.published, 1);
  assert.equal(publishes, 1);
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

test('pause lists only unsettled slots for the active profile and account', async () => {
  const scopes = [];
  const order = [];
  const { repository, publisher } = harness({ repository: {
    listUnsettledSlots: async (scope) => {
      scopes.push(scope);
      return scope?.profileId === 'profile-current' && scope?.accountId === 'acct-1'
        ? [
          { providerPostId: 'owned-current', profileId: 'profile-current', accountId: 'acct-1', requestPayload: { targets: [{ account_id: 'acct-1' }] } },
          { providerPostId: 'ambiguous-other', profileId: null, accountId: null },
        ]
        : [{ providerPostId: 'owned-other' }];
    },
  }, publisher: {
    listScheduledPosts: async () => ({ data: [{ id: 'owned-current', status: 'scheduled' }, { id: 'ambiguous-other', status: 'scheduled' }, { id: 'owned-other', status: 'scheduled' }], nextCursor: null }),
    cancelPost: async (id) => { order.push(id); return { id, status: 'canceled' }; },
  } });
  await pauseAutomation({ repository, publisher, profileId: 'profile-current', accountId: 'acct-1' });
  assert.deepEqual(scopes, [{ profileId: 'profile-current', accountId: 'acct-1' }]);
  assert.deepEqual(order, ['owned-current']);
});

test('reconciliation reads known provider IDs and persists provider status', async () => {
  const { calls, repository, publisher } = harness({ repository: { listUnsettledSlots: async () => [{ id: 'slot-2', providerPostId: 'p2', requestPayload: { targets: [{ account_id: 'acct-1' }] } }] }, publisher: { getPost: async () => ({ id: 'p2', status: 'published', targets: [{ accountId: 'acct-1', platform: 'threads', status: 'published' }] }) } });
  const result = await runDispatcher({ repository, publisher, content, clock: fixedClock });
  assert.equal(result.reconciled, 1);
  assert.ok(calls.some((c) => c[0] === 'update' && c[1] === 'slot-2' && c[2].status === 'published'));
});

test('reconciliation anchors cadence to the confirmed Threads target publication time', async () => {
  const publishedAt = '2026-11-05T03:41:12.000Z';
  const { calls, repository, publisher } = harness({ repository: {
    listUnsettledSlots: async () => [{ id: 'slot-provider-time', providerPostId: 'p-provider-time', requestPayload: { targets: [{ account_id: 'acct-1' }] } }],
  }, publisher: {
    getPost: async () => ({ id: 'p-provider-time', status: 'published', targets: [{ accountId: 'acct-1', platform: 'threads', status: 'published', publishedAt }] }),
  } });
  const result = await runDispatcher({ repository, publisher, content, clock: fixedClock });
  assert.equal(result.reconciled, 1);
  assert.ok(calls.some((call) => call[0] === 'update' && call[1] === 'slot-provider-time'
    && call[2].status === 'published' && new Date(call[2].completedAt).toISOString() === publishedAt));
});

test('direct provider confirmation anchors cadence to its confirmed Threads target time', async () => {
  const publishedAt = '2026-11-05T03:52:30.000Z';
  const { calls, repository, publisher } = harness({ publisher: {
    publishNow: async () => ({ id: 'p-direct-provider-time', status: 'published', targets: [{ accountId: 'acct-1', platform: 'threads', status: 'published', publishedAt }] }),
  } });
  const result = await runDispatcher({ repository, publisher, content, clock: fixedClock });
  assert.equal(result.published, 1);
  assert.ok(calls.some((call) => call[0] === 'update' && call[2].providerPostId === 'p-direct-provider-time'
    && call[2].status === 'published' && call[2].completedAt === publishedAt));
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

test('unrelated account unsettled slots do not block dispatch for the active account', async () => {
  const scopes = [];
  const { repository, publisher } = harness({ repository: {
    getRuntimeState: async () => ({ automationEnabled: true, onboardingComplete: true, profileId: 'profile-current', accountId: 'acct-1', settings: { automationSessionId: 'session-1', schedule: { intervalHours: 6, timezone: 'Asia/Kuala_Lumpur', activeDays: [1,2,3,4,5,6,7], activeStart: '00:00', activeEnd: '23:59' } }, facts: [], history: [] }),
    listUnsettledSlots: async (scope) => { scopes.push(scope); return scope?.accountId === 'acct-1' ? [] : [{ id: 'other-slot', profileId: 'profile-other', accountId: 'acct-other', providerPostId: 'other-post' }]; },
  } });
  const result = await runDispatcher({ repository, publisher, content, clock: fixedClock });
  assert.equal(result.published, 1);
  assert.ok(scopes.length >= 2);
  assert.ok(scopes.every((scope) => scope?.profileId === 'profile-current' && scope?.accountId === 'acct-1'));
});

test('an unsettled slot for the active account still blocks dispatch', async () => {
  const { repository, publisher } = harness({ repository: {
    getRuntimeState: async () => ({ automationEnabled: true, onboardingComplete: true, profileId: 'profile-current', accountId: 'acct-1', settings: { automationSessionId: 'session-1' }, facts: [], history: [] }),
    listUnsettledSlots: async (scope) => scope?.profileId === 'profile-current' && scope?.accountId === 'acct-1'
      ? [{ id: 'current-slot', profileId: 'profile-current', accountId: 'acct-1', providerPostId: 'current-post', requestPayload: { targets: [{ account_id: 'acct-1' }] } }]
      : [],
    claimDueSlot: async () => assert.fail('the active account blocker must stop slot claiming'),
  }, publisher: { getPost: async () => ({ id: 'current-post', status: 'publishing', targets: [{ accountId: 'acct-1', platform: 'threads', status: 'publishing' }] }) } });
  const result = await runDispatcher({ repository, publisher, content, clock: fixedClock });
  assert.equal(result.claimed, 0);
  assert.ok(result.unknown >= 1);
});

test('AI authentication failure stores a global hold before terminalizing one slot and blocks later claims', async () => {
  const order = [];
  const { calls, repository, publisher } = harness({ repository: {
    recordProviderHold: async (hold) => { order.push(['hold', hold]); },
    listActiveProviderHolds: async () => [],
    updateSlot: async (id, patch) => { order.push(['update', id, patch]); calls.push(['update', id, patch]); },
  } });
  publisher.publishNow = async () => assert.fail('AI authentication failure must happen before publication');
  const failed = await runDispatcher({ repository, publisher,
    content: async () => ({ status: 'skipped', reason: 'GENERATION_FAILED', diagnosticCode: 'ai_unauthorized', attempts: 2 }),
    clock: fixedClock,
  });
  assert.equal(failed.failed, 1);
  assert.equal(order[0][0], 'hold');
  assert.deepEqual(order[0][1], { provider: 'openrouter', profileId: null, accountId: null, reasonCode: 'unauthorized', slotId: 'slot-1' });
  assert.equal(order[1][0], 'update');
  assert.equal(order[1][2].status, 'failed');

  let holdLookups = 0;
  repository.listActiveProviderHolds = async ({ profileId, accountId }) => {
    holdLookups++;
    assert.equal(profileId, null);
    assert.equal(accountId, 'acct-1');
    return [{ provider: 'openrouter', scopeKey: 'global', reasonCode: 'ai_unauthorized' }];
  };
  repository.ensureNextDueSlot = async () => assert.fail('active AI hold must prevent planning a later slot');
  repository.claimDueSlot = async () => assert.fail('active AI hold must prevent claiming a later slot');
  const held = await runDispatcher({ repository, publisher, content, clock: fixedClock });
  assert.equal(held.claimed, 0);
  assert.equal(holdLookups, 1);
  assert.equal(held.providerHeld, 1);
});

test('missing OpenRouter configuration stores a global hold and fails only the claimed slot', async () => {
  const holds = [];
  const { calls, slot, repository, publisher } = harness({ repository: {
    recordProviderHold: async (hold) => holds.push(hold),
  } });
  slot.model = 'vendor/model';
  const notices = [];
  let contentCalls = 0;
  publisher.publishNow = async () => assert.fail('missing OpenRouter configuration must stop before publishing');
  const result = await runDispatcher({ repository, publisher,
    content: async () => { contentCalls++; return content(); },
    generatorForModel: async () => { throw Object.assign(new Error('AI_NOT_CONFIGURED'), { code: 'not_configured' }); },
    notifier: { send: async (message) => notices.push(message) },
    clock: fixedClock,
  });
  assert.equal(result.failed, 1);
  assert.equal(contentCalls, 0);
  assert.deepEqual(holds, [{ provider: 'openrouter', profileId: null, accountId: null, reasonCode: 'ai_not_configured', slotId: 'slot-1' }]);
  assert.ok(calls.some((call) => call[0] === 'update' && call[1] === 'slot-1' && call[2].status === 'failed'));
  assert.ok(calls.some((call) => call[0] === 'activity' && call[1].event === 'ai_generation_failed' && call[1].details.diagnosticCode === 'ai_not_configured'));
  assert.equal(notices.length, 1);
  assert.match(notices[0], /belum dikonfigurasi/i);
});

test('unrecognized model initialization errors are not reclassified as missing OpenRouter configuration', async () => {
  const holds = [];
  const { calls, slot, repository, publisher } = harness({ repository: {
    recordProviderHold: async (hold) => holds.push(hold),
  } });
  slot.model = 'vendor/model';
  const failure = Object.assign(new Error('unexpected initialization failure'), { code: 'not_configured' });
  await assert.rejects(runDispatcher({ repository, publisher, content,
    generatorForModel: async () => { throw failure; }, clock: fixedClock,
  }), error => error === failure);
  assert.deepEqual(holds, []);
  assert.equal(calls.some((call) => call[0] === 'update' && call[2]?.status === 'failed'), false);
});

test('missing Tebar configuration stores a target-scoped hold and fails only the claimed slot', async () => {
  const holds = [];
  const { calls, slot, repository, publisher } = harness({ repository: {
    getRuntimeState: async () => ({ automationEnabled: true, onboardingComplete: true, profileId: 'profile-1', accountId: 'acct-1', settings: { automationSessionId: 'session-1' }, facts: [], history: [] }),
    recordProviderHold: async (hold) => holds.push(hold),
  } });
  Object.assign(slot, { profileId: 'profile-1', accountId: 'acct-1' });
  publisher.publishNow = async () => assert.fail('missing Tebar configuration must stop before publishing');
  const notices = [];
  const result = await runDispatcher({ repository, publisher, content,
    publisherForProfile: async () => { throw Object.assign(new Error('TEBAR_NOT_CONFIGURED'), { code: 'not_configured' }); },
    notifier: { send: async (message) => notices.push(message) },
    clock: fixedClock,
  });
  assert.equal(result.failed, 1);
  assert.deepEqual(holds, [{ provider: 'tebar', profileId: 'profile-1', accountId: 'acct-1', reasonCode: 'not_configured', slotId: 'slot-1' }]);
  assert.ok(calls.some((call) => call[0] === 'update' && call[1] === 'slot-1' && call[2].status === 'failed' && call[2].errorCode === 'provider_error' && !Object.hasOwn(call[2], 'providerStatus')));
  assert.ok(calls.some((call) => call[0] === 'activity' && call[1].event === 'publish_failed' && call[1].details.diagnosticCode === 'tebar_not_configured'));
  assert.equal(notices.length, 1);
});

test('Tebar initialization network failures are not converted to configuration holds', async () => {
  const holds = [];
  const { calls, slot, repository, publisher } = harness({ repository: {
    getRuntimeState: async () => ({ automationEnabled: true, onboardingComplete: true, profileId: 'profile-1', accountId: 'acct-1', settings: { automationSessionId: 'session-1' }, facts: [], history: [] }),
    recordProviderHold: async (hold) => holds.push(hold),
  } });
  Object.assign(slot, { profileId: 'profile-1', accountId: 'acct-1' });
  const failure = Object.assign(new Error('network detail'), { code: 'network_error', unknownOutcome: true });
  await assert.rejects(runDispatcher({ repository, publisher, content,
    publisherForProfile: async () => { throw failure; }, clock: fixedClock,
  }), error => error === failure);
  assert.deepEqual(holds, []);
  assert.equal(calls.some((call) => call[0] === 'update' && call[2]?.status === 'failed'), false);
});

test('switch reconciliation leaves scheduled blockers when provider GET or DELETE IDs mismatch', async () => {
  const calls = [];
  const providerCalls = [];
  const scopes = [];
  const recoveryScopes = [];
  const slots = [
    { id: 'wrong-get', profileId: 'profile-old', accountId: 'acct-old', providerPostId: 'post-get-expected', providerStatus: 'scheduled', requestPayload: { targets: [{ account_id: 'acct-old' }] } },
    { id: 'wrong-delete', profileId: 'profile-old', accountId: 'acct-old', providerPostId: 'post-delete-expected', providerStatus: 'scheduled', requestPayload: { targets: [{ account_id: 'acct-old' }] } },
    { id: 'other-account', profileId: 'profile-other', accountId: 'acct-other', providerPostId: 'post-other', providerStatus: 'scheduled', requestPayload: { targets: [{ account_id: 'acct-other' }] } },
  ];
  const repository = {
    listUnsettledSlots: async (scope) => {
      scopes.push(scope);
      return slots.filter(slot => slot.profileId === scope?.profileId && slot.accountId === scope?.accountId);
    },
    recoverStalePublishing: async ({ slotIds }) => { recoveryScopes.push(slotIds); return []; },
    recordCancellation: async (...args) => calls.push(['recordCancellation', ...args]),
    updateSlot: async (...args) => calls.push(['updateSlot', ...args]),
    isAutomationSessionActive: async () => false,
  };
  const publisherForProfile = async (profileId) => ({
    getPost: async (id) => { providerCalls.push(['get', id]); return { id: id === 'post-get-expected' ? 'different-get-id' : id, status: 'scheduled', targets: [{ accountId: profileId === 'profile-old' ? 'acct-old' : 'acct-other', platform: 'threads', status: 'scheduled' }] }; },
    cancelPost: async (id) => { providerCalls.push(['cancel', id]); return { id: id === 'post-delete-expected' ? 'different-delete-id' : id, status: 'canceled', targets: [{ accountId: 'acct-old', platform: 'threads', status: 'canceled' }] }; },
  });
  await reconcileSwitch({ repository, publisherForProfile, profileId: 'profile-old', accountId: 'acct-old' });
  assert.ok(scopes.length >= 1);
  assert.ok(scopes.every((scope) => scope?.profileId === 'profile-old' && scope?.accountId === 'acct-old'));
  assert.deepEqual(recoveryScopes, [['wrong-get', 'wrong-delete']], 'stale recovery must be fenced to the outgoing account slots');
  assert.deepEqual(providerCalls.filter((call) => call[0] === 'cancel').map((call) => call[1]), ['post-delete-expected']);
  assert.equal(calls.some((call) => call[0] === 'recordCancellation' || call[0] === 'updateSlot' && call[2]?.status === 'canceled'), false);
});

test('definitive Tebar authentication failure stores a hold for only the immutable original target', async () => {
  const holds = [];
  const logs = [];
  const { calls, slot, repository, publisher } = harness({ repository: {
    recordProviderHold: async (hold) => holds.push(hold),
    listActiveProviderHolds: async () => [],
  } });
  Object.assign(slot, { profileId: 'profile-old', accountId: 'acct-old' });
  repository.getRuntimeState = async () => ({ automationEnabled: true, onboardingComplete: true, profileId: 'profile-old', accountId: 'acct-old', settings: { automationSessionId: 'session-1', schedule: { intervalHours: 6, timezone: 'Asia/Kuala_Lumpur', activeDays: [1,2,3,4,5,6,7], activeStart: '00:00', activeEnd: '23:59' } }, facts: [], history: [] });
  publisher.publishNow = async () => { throw Object.assign(new Error('do-not-log-this-secret'), { code: 'unauthorized', status: 401, unknownOutcome: false, retryable: false, transportCode: 'ERR_BAD_REQUEST', timedOut: false }); };
  const result = await runDispatcher({ repository, publisher, content, clock: fixedClock, logger: { warn: (event, details) => logs.push({ event, details }) } });
  assert.equal(result.failed, 1);
  assert.equal(holds.length, 1);
  assert.deepEqual(holds[0], { provider: 'tebar', profileId: 'profile-old', accountId: 'acct-old', reasonCode: 'unauthorized', slotId: 'slot-1' });
  assert.ok(calls.some((call) => call[0] === 'update' && call[2].status === 'failed' && call[2].providerStatus === 'failed'));
  const logText = JSON.stringify(logs);
  assert.match(logText, /publication\.provider_failed/);
  assert.match(logText, /401/);
  assert.doesNotMatch(logText, /do-not-log-this-secret/);
});

test('transport timeout is recorded as network failure and does not create an authentication hold', async () => {
  const holds = [];
  const { repository, publisher } = harness({ repository: {
    recordProviderHold: async (hold) => holds.push(hold),
    listActiveProviderHolds: async () => [],
  } });
  publisher.publishNow = async () => { throw Object.assign(new Error('raw transport detail'), { code: 'network_error', status: null, unknownOutcome: false, retryable: false, transportCode: 'ETIMEDOUT', timedOut: true }); };
  const logs = [];
  const result = await runDispatcher({ repository, publisher, content, clock: fixedClock, logger: { warn: (event, details) => logs.push({ event, details }) } });
  assert.equal(result.failed, 1);
  assert.deepEqual(holds, []);
  assert.match(JSON.stringify(logs), /ETIMEDOUT/);
  assert.match(JSON.stringify(logs), /true/);
  assert.doesNotMatch(JSON.stringify(logs), /raw transport detail/);
});

test('a hold detected while starting a publish is treated as a wait and never publishes', async () => {
  const { calls, repository, publisher } = harness({ repository: {
    listActiveProviderHolds: async () => [],
    startPublishing: async () => 'provider_hold',
  } });
  publisher.publishNow = async () => assert.fail('a hold race must stop before the provider mutation');
  const result = await runDispatcher({ repository, publisher, content, clock: fixedClock });
  assert.equal(result.providerHeld, 1);
  assert.equal(result.claimed, 1);
  assert.equal(calls.some((call) => call[0] === 'update' && call[2].errorCode === 'automation_paused'), false);
});

test('confirmed publication sends one deduplicated success notice', async () => {
  const { repository, publisher } = harness();
  const notices = [];
  const result = await runDispatcher({ repository, publisher, content, notifier: { send: async (...args) => notices.push(args) }, clock: fixedClock });
  assert.equal(result.published, 1);
  assert.equal(notices.length, 1);
  assert.match(notices[0][0], /POSTING BERHASIL/);
  assert.equal(notices[0][1], 'post_published:slot:slot-1');
});

test('reconciled partial post is counted as failure and sends a safe alert', async () => {
  const { calls, repository, publisher } = harness({ repository: {
    listUnsettledSlots: async () => [{ id: 'slot-partial', accountId: 'acct-1', providerPostId: 'p-partial', requestPayload: { targets: [{ account_id: 'acct-1' }] } }],
    getRuntimeState: async () => ({ automationEnabled: false }),
  }, publisher: { getPost: async () => ({ id: 'p-partial', status: 'partial', targets: [{ accountId: 'acct-1', platform: 'threads', status: 'failed' }] }) } });
  const result = await runDispatcher({ repository, publisher, content, notifier: { send: async (message) => calls.push(['notice', message]) }, clock: fixedClock });
  assert.equal(result.reconciled, 1);
  assert.equal(result.failed, 1);
  assert.ok(calls.some((call) => call[0] === 'notice' && call[1].includes('melaporkan kegagalan')));
});

test('reconciled provider cancellation in the active session is counted as a failed attempt', async () => {
  let unsettledLookups = 0;
  const { calls, repository, publisher } = harness({ repository: {
    getRuntimeState: async () => ({ automationEnabled: true, onboardingComplete: true, accountId: 'acct-1', settings: { automationSessionId: 'session-1', schedule: { intervalHours: 1, timezone: 'Asia/Kuala_Lumpur', activeDays: [1,2,3,4,5,6,7], activeStart: '00:00', activeEnd: '23:59' } }, facts: [], history: [] }),
    listUnsettledSlots: async () => unsettledLookups++ === 0 ? [{ id: 'slot-canceled', automationSessionId: 'session-1', providerPostId: 'p-canceled', requestPayload: { targets: [{ account_id: 'acct-1' }] } }] : [],
    ensureNextDueSlot: async () => ({ slot: null, created: false, skippedCount: 0 }),
  }, publisher: {
    getPost: async () => ({ id: 'p-canceled', status: 'canceled', targets: [{ accountId: 'acct-1', platform: 'threads', status: 'canceled' }] }),
  } });
  const notices = [];
  const result = await runDispatcher({ repository, publisher, content, notifier: { send: async (message) => notices.push(message) }, clock: fixedClock });
  assert.equal(result.failed, 1);
  assert.ok(calls.some((call) => call[0] === 'update' && call[1] === 'slot-canceled' && call[2].status === 'failed'));
  assert.ok(notices.some((message) => /melaporkan kegagalan/i.test(message)));
});

test('top-level published status without a published target stays unknown', async () => {
  const { repository, publisher } = harness({ publisher: { publishNow: async () => ({ id: 'p-uncertain', status: 'published', targets: [] }) } });
  const result = await runDispatcher({ repository, publisher, content, clock: fixedClock });
  assert.equal(result.published, 0);
  assert.equal(result.unknown, 1);
});

test('provider acceptance as scheduled is not reported as a successful publication', async () => {
  const { repository, publisher, calls } = harness({ publisher: { publishNow: async () => ({ id: 'p-scheduled', status: 'scheduled', targets: [{ accountId: 'acct-1', status: 'scheduled' }] }) } });
  const result = await runDispatcher({ repository, publisher, content, clock: fixedClock });
  assert.equal(result.published, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.unknown, 1);
  assert.ok(calls.some((call) => call[0] === 'update' && call[2].status === 'publishing' && call[2].providerPostId === 'p-scheduled'));
  assert.equal(calls.some((call) => call[0] === 'notice' && /POSTING BERHASIL/.test(call[1])), false);
});

test('provider-confirmed cancellation during an active session is recorded and notified as failure', async () => {
  const { calls, repository, publisher } = harness({ publisher: {
    publishNow: async () => ({ id: 'p-canceled-active', status: 'canceled', targets: [] }),
  } });
  const notices = [];
  const result = await runDispatcher({ repository, publisher, content, notifier: { send: async (message) => notices.push(message) }, clock: fixedClock });
  assert.equal(result.failed, 1);
  assert.ok(calls.some((call) => call[0] === 'update' && call[2].status === 'failed' && call[2].completedAt === fixedClock().toISOString()));
  assert.ok(notices.some((message) => /melaporkan kegagalan/i.test(message)));
});

test('a provider acceptance arriving after pause is canceled when still scheduled', async () => {
  let sessionActive = true;
  const { calls, repository, publisher } = harness({ repository: {
    isAutomationSessionActive: async () => sessionActive,
  }, publisher: {
    publishNow: async () => { sessionActive = false; return { id: 'p-after-pause', status: 'scheduled', targets: [{ accountId: 'acct-1', status: 'scheduled' }] }; },
    getPost: async (id) => ({ id, status: 'scheduled', targets: [{ accountId: 'acct-1', status: 'scheduled' }] }),
    cancelPost: async (id) => ({ id, status: 'canceled', targets: [] }),
  } });
  const result = await runDispatcher({ repository, publisher, content, clock: fixedClock });
  assert.equal(result.published, 0);
  assert.equal(result.failed, 0);
  assert.ok(calls.some((call) => call[0] === 'cancel' && call[1] === 'p-after-pause' && call[2].status === 'canceled'));
  assert.ok(calls.some((call) => call[0] === 'update' && call[2].status === 'canceled' && call[2].providerPostId === 'p-after-pause'));
});

test('a revoked session is stopped before the provider request starts', async () => {
  const { repository, publisher } = harness({ repository: {
    isAutomationSessionActive: async () => false,
  } });
  publisher.publishNow = async () => assert.fail('must not send after the session is revoked');
  const result = await runDispatcher({ repository, publisher, content, clock: fixedClock });
  assert.equal(result.published, 0);
  assert.equal(result.skipped, 1);
});

test('dispatcher refreshes account and onboarding state after claiming a newer session slot', async () => {
  const { repository, publisher, slot } = harness();
  const latestState = {
    automationEnabled: true,
    onboardingComplete: true,
    accountId: 'acct-2',
    settings: { automationSessionId: 'session-2', schedule: { intervalHours: 1, timezone: 'Asia/Kuala_Lumpur', activeDays: [1,2,3,4,5,6,7], activeStart: '00:00', activeEnd: '23:59' } },
    facts: [],
    history: [],
  };
  let stateReads = 0;
  let generatedForAccount;
  let publishedPayload;
  repository.getRuntimeState = async () => stateReads++ === 0
    ? { ...latestState, accountId: 'acct-1', settings: { ...latestState.settings, automationSessionId: 'session-1' } }
    : latestState;
  repository.claimDueSlot = async () => ({ ...slot, automationSessionId: 'session-2' });
  publisher.publishNow = async (payload) => {
    publishedPayload = payload;
    return { id: 'post-session-2', status: 'published', targets: [{ accountId: 'acct-2', platform: 'threads', status: 'published' }] };
  };
  const freshContent = async (context) => {
    generatedForAccount = context.accountId;
    return { status: 'ready', text: 'Jom kongsi pilihan anda!', pillar: 'topup', factBearing: false, factIds: [] };
  };
  const result = await runDispatcher({ repository, publisher, content: freshContent, clock: fixedClock });
  assert.equal(generatedForAccount, 'acct-2');
  assert.equal(publishedPayload.targets[0].account_id, 'acct-2');
  assert.equal(result.published, 1);
});

test('published target on another platform remains unconfirmed and sends pending notice', async () => {
  const notices = [];
  const { repository, publisher } = harness({ publisher: { publishNow: async () => ({ id: 'other', status: 'published', targets: [{ accountId: 'acct-1', platform: 'instagram', status: 'published' }] }) } });
  const result = await runDispatcher({ repository, publisher, content, notifier: { send: async (...args) => notices.push(args) }, clock: fixedClock });
  assert.equal(result.published, 0);
  assert.equal(result.unknown, 1);
  assert.match(notices[0][0], /Menunggu konfirmasi publikasi/);
  assert.equal(notices[0][1], 'unknown_outcome:slot:slot-1');
});

test('confirmed success notice includes actual caption and verified provider permalink', async () => {
  const notices = [];
  const { repository, publisher } = harness({ publisher: { publishNow: async () => ({ id: 'ok', status: 'published', targets: [{ accountId: 'acct-1', platform: 'threads', status: 'published', permalink: 'https://www.threads.net/@example/post/123', publishedAt: '2026-11-05T04:01:00Z' }] }) } });
  const result = await runDispatcher({ repository, publisher, content, notifier: { send: async (...args) => notices.push(args) }, clock: fixedClock });
  assert.equal(result.published, 1);
  assert.match(notices[0][0], /Jom kongsi pilihan anda!/);
  assert.match(notices[0][0], /https:\/\/www\.threads\.net\/@example\/post\/123/);
  assert.match(notices[0][0], /Slot ID: slot-1$/);
});
