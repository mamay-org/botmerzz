'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runDispatcher, pauseAutomation, maybeSendDailySummary, reconcileUnsettled } = require('../src/dispatcher');
const { contentSafetyHash } = require('../src/content-safety');

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

test('minimum cadence race waits with the prepared slot instead of canceling or publishing it', async () => {
  const { calls, repository, publisher } = harness({ repository: { startPublishing: async () => 'minimum_cadence' } });
  publisher.publishNow = async () => assert.fail('must respect actual publication cooldown');
  const result = await runDispatcher({ repository, publisher, content, clock: fixedClock });
  assert.equal(result.published, 0);
  assert.equal(result.skipped, 1);
  assert.ok(calls.some((call) => call[0] === 'activity' && call[1].event === 'cadence_cooldown_wait'));
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
  assert.deepEqual(plan.schedule, { intervalHours: 1, timezone: 'Asia/Kuala_Lumpur', activeDays: [1,2,3,4,5,6,7], activeStart: '00:00', activeEnd: '23:59' });
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
    listUnsettledSlots: async () => [{ id: 'slot-partial', providerPostId: 'p-partial' }],
    getRuntimeState: async () => ({ automationEnabled: false }),
  }, publisher: { getPost: async () => ({ id: 'p-partial', status: 'partial', targets: [] }) } });
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
    getPost: async () => ({ id: 'p-canceled', status: 'canceled', targets: [] }),
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
