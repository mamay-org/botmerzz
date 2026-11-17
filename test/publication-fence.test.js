'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runDispatcher } = require('../src/dispatcher');
const { createRepository } = require('../src/repository');

const now = new Date('2026-11-05T04:00:00.000Z');
const settings = {
  automationSessionId: 'session-1',
  profileId: 'profile-1',
  targetAccountId: 'account-1',
  schedule: {
    intervalHours: 6,
    timezone: 'Asia/Kuala_Lumpur',
    activeDays: [1, 2, 3, 4, 5, 6, 7],
    activeStart: '00:00',
    activeEnd: '23:59',
  },
};

function raceHarness({ revokeAfterSessionCheck = false } = {}) {
  const state = { automationEnabled: true, onboardingComplete: true, accountId: 'account-1', profileId: 'profile-1', settings: { ...settings }, facts: [], history: [] };
  const slot = {
    id: 'slot-1',
    scheduledAt: now.toISOString(),
    automationSessionId: 'session-1',
    profileId: 'profile-1',
    accountId: 'account-1',
    status: 'generating',
  };
  const calls = [];
  let sessionChecks = 0;
  const repository = {
    getRuntimeState: async () => state,
    listUnsettledSlots: async () => [],
    ensureNextDueSlot: async () => ({ slot, created: true }),
    claimDueSlot: async () => slot,
    savePreparedSlot: async (_id, patch) => { Object.assign(slot, patch, { status: 'ready' }); return true; },
    startPublishing: async () => { slot.status = 'publishing'; return true; },
    isAutomationSessionActive: async () => {
      sessionChecks++;
      if (revokeAfterSessionCheck && sessionChecks === 2) {
        state.automationEnabled = false;
        state.settings.automationSessionId = null;
      }
      return true;
    },
    withPublicationFence: async (_id, publish) => {
      if (!state.automationEnabled || state.settings.automationSessionId !== slot.automationSessionId
        || slot.status !== 'publishing' || slot.providerPostId != null) return false;
      return publish(async (patch) => { Object.assign(slot, patch); return true; });
    },
    updateSlot: async (_id, patch) => { Object.assign(slot, patch); return true; },
    appendActivity: async () => {},
    claimDailySummary: async () => false,
  };
  const publisher = {
    publishNow: async () => {
      calls.push('publishNow');
      return { id: 'provider-post-1', status: 'published', targets: [{ accountId: 'account-1', platform: 'threads', status: 'published' }] };
    },
    getPost: async () => assert.fail('this scenario does not require provider reconciliation'),
    listScheduledPosts: async () => ({ data: [], nextCursor: null }),
    cancelPost: async () => assert.fail('this scenario does not require provider cancellation'),
  };
  return { state, slot, calls, repository, publisher };
}

async function dispatch(rig) {
  return runDispatcher({
    repository: rig.repository,
    publisher: rig.publisher,
    content: async () => ({ status: 'ready', text: 'A safe test post', pillar: 'topup', factBearing: false, factIds: [] }),
    clock: () => now,
  });
}

test('an old worker cannot publish after recovery and admin closure commit', async () => {
  const rig = raceHarness();
  const finishSessionCheck = (() => {
    let release;
    return { promise: new Promise((resolve) => { release = resolve; }), release: () => release() };
  })();
  const originalCheck = rig.repository.isAutomationSessionActive;
  rig.repository.isAutomationSessionActive = async (...args) => {
    await finishSessionCheck.promise;
    return originalCheck(...args);
  };

  const running = dispatch(rig);
  while (rig.slot.status !== 'publishing') await new Promise((resolve) => setImmediate(resolve));
  rig.slot.status = 'unknown'; // recoverStalePublishing committed
  rig.slot.status = 'admin_closed_unknown'; // closeUnknownPublication committed
  finishSessionCheck.release();
  await running;

  assert.deepEqual(rig.calls, []);
});

test('the fence rechecks a session revoked immediately after the worker session check', async () => {
  const rig = raceHarness({ revokeAfterSessionCheck: true });

  await dispatch(rig);

  assert.deepEqual(rig.calls, []);
  assert.equal(rig.state.automationEnabled, false);
});

test('the dispatcher fails closed when the repository fence API is unavailable', async () => {
  const rig = raceHarness();
  delete rig.repository.withPublicationFence;

  const result = await dispatch(rig);

  assert.equal(result.skipped, 1);
  assert.deepEqual(rig.calls, []);
});

test('the repository fence contract holds row and session locks through durable outcome recording', async () => {
  const events = [];
  const statements = [];
  let allowOutcome;
  let enteredCallback;
  const callbackStarted = new Promise((resolve) => { enteredCallback = resolve; });
  const continueCallback = new Promise((resolve) => { allowOutcome = resolve; });
  const connection = {
    async beginTransaction() { events.push('begin'); },
    async query(sql, params) {
      statements.push({ sql, params });
      if (sql.includes('FROM settings')) return [[{ automation_enabled: 1, settings_json: JSON.stringify({ automationSessionId: 'session-1', profileId: 'profile-1', targetAccountId: 'account-1' }) }]];
      if (sql.includes('FROM integration_config')) return [[{ status: 'ACTIVE', profile_id: 'profile-1', account_id: 'account-1' }]];
      return [[]];
    },
    async execute(sql, params) {
      statements.push({ sql, params });
      if (sql.includes('FROM slots') && sql.includes('FOR UPDATE')) {
        return [[{ status: 'publishing', provider_post_id: null, automation_session_id: 'session-1', tebar_profile_id: 'profile-1', tebar_account_id: 'account-1', request_payload: JSON.stringify({ targets: [{ account_id: 'account-1' }] }) }]];
      }
      if (sql.startsWith('UPDATE slots SET')) return [{ affectedRows: 1 }];
      return [{ affectedRows: 1 }];
    },
    async commit() { events.push('commit'); },
    async rollback() { events.push('rollback'); },
    release() { events.push('release'); },
  };
  const repository = createRepository({ execute: async () => [[]], getConnection: async () => connection });

  const publishing = repository.withPublicationFence('slot-1', async (recordOutcome) => {
    enteredCallback();
    await continueCallback;
    await recordOutcome({ status: 'publishing', providerStatus: 'scheduled', providerPostId: 'provider-post-1' });
    return 'provider-result';
  });
  await callbackStarted;
  assert.deepEqual(events, ['begin']);
  allowOutcome();

  assert.equal(await publishing, 'provider-result');
  assert.deepEqual(events, ['begin', 'commit', 'release']);
  assert.deepEqual(statements.filter(({ sql }) => sql.includes('FOR UPDATE')).map(({ sql }) => (
    sql.includes('FROM settings') ? 'settings' : sql.includes('FROM integration_config') ? 'integration' : 'slot'
  )), ['settings', 'integration', 'slot']);
  assert.ok(statements.some(({ sql }) => sql.includes('SELECT automation_enabled,settings_json FROM settings WHERE id=1 FOR UPDATE')));
  assert.ok(statements.some(({ sql }) => sql.includes('SELECT status,profile_id,account_id FROM integration_config WHERE id=1 FOR UPDATE')));
  assert.ok(statements.some(({ sql }) => sql.includes('SELECT status,provider_post_id,automation_session_id,tebar_profile_id')));
  const update = statements.find(({ sql }) => sql.startsWith('UPDATE slots SET'));
  assert.match(update.sql, /status='publishing'/);
  assert.match(update.sql, /provider_post_id IS NULL/);
  assert.deepEqual(update.params.slice(-2), ['provider-post-1', 'slot-1']);
});

test('the repository fence contract refuses a closed or already-linked slot', async () => {
  const ineligibleSlots = [
    { status: 'admin_closed_unknown', provider_post_id: null },
    { status: 'publishing', provider_post_id: 'already-linked-post' },
  ];
  for (const ineligible of ineligibleSlots) {
    const events = [];
    const connection = {
      async beginTransaction() { events.push('begin'); },
      async query(sql) {
        if (sql.includes('FROM settings')) return [[{ automation_enabled: 1, settings_json: JSON.stringify({ automationSessionId: 'session-1', profileId: 'profile-1', targetAccountId: 'account-1' }) }]];
        if (sql.includes('FROM integration_config')) return [[{ status: 'ACTIVE', profile_id: 'profile-1', account_id: 'account-1' }]];
        return [[]];
      },
      async execute(sql) {
        if (sql.includes('FROM slots') && sql.includes('FOR UPDATE')) return [[{ ...ineligible, automation_session_id: 'session-1', tebar_profile_id: 'profile-1', tebar_account_id: 'account-1', request_payload: JSON.stringify({ targets: [{ account_id: 'account-1' }] }) }]];
        return [{ affectedRows: 1 }];
      },
      async commit() { events.push('commit'); },
      async rollback() { events.push('rollback'); },
      release() { events.push('release'); },
    };
    const repository = createRepository({ execute: async () => [[]], getConnection: async () => connection });
    let called = false;

    const result = await repository.withPublicationFence('slot-1', async () => { called = true; });

    assert.equal(result, false);
    assert.equal(called, false);
    assert.deepEqual(events, ['begin', 'rollback', 'release']);
  }
});

test('the repository fence contract refuses a changed integration target or request target', async () => {
  for (const mismatch of ['integration', 'payload']) {
    const events = [];
    const connection = {
      async beginTransaction() { events.push('begin'); },
      async query(sql) {
        if (sql.includes('FROM settings')) return [[{ automation_enabled: 1, settings_json: JSON.stringify({ automationSessionId: 'session-1', profileId: 'profile-1', targetAccountId: 'account-1' }) }]];
        if (sql.includes('FROM integration_config')) return [[{ status: 'ACTIVE', profile_id: 'profile-1', account_id: mismatch === 'integration' ? 'account-2' : 'account-1' }]];
        return [[]];
      },
      async execute(sql) {
        if (sql.includes('FROM slots') && sql.includes('FOR UPDATE')) return [[{
          status: 'publishing', provider_post_id: null, automation_session_id: 'session-1',
          tebar_profile_id: 'profile-1', tebar_account_id: 'account-1',
          request_payload: JSON.stringify({ targets: [{ account_id: mismatch === 'payload' ? 'account-2' : 'account-1' }] }),
        }]];
        return [{ affectedRows: 1 }];
      },
      async commit() { events.push('commit'); },
      async rollback() { events.push('rollback'); },
      release() { events.push('release'); },
    };
    const repository = createRepository({ execute: async () => [[]], getConnection: async () => connection });
    let called = false;

    const result = await repository.withPublicationFence('slot-1', async () => { called = true; });

    assert.equal(result, false);
    assert.equal(called, false);
    assert.deepEqual(events, ['begin', 'rollback', 'release']);
  }
});
