'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOutboxNotifier } = require('../src/notifications');

test('outbox accepts Telegram sized messages and rejects oversized messages', async () => {
  let saved;
  const notifier=createOutboxNotifier({repository:{enqueueNotification:async notice=>{saved=notice;}},transport:{send:async()=>{}}});
  await notifier.enqueue('x'.repeat(4096));
  assert.equal(saved.message.length,4096);
  await assert.rejects(notifier.enqueue('x'.repeat(4097)),{code:'invalid_notification'});
});

test('outbox notification is persisted before delivery and completed after Telegram accepts it', async () => {
  const calls = [];
  const row = { id: 4, message: 'safe notice', attempts: 1 };
  let status = null;
  const repository = {
    enqueueNotification: async (notice) => calls.push(['enqueue', notice]),
    claimNotifications: async () => [row],
    markNotificationSent: async (id) => { calls.push(['sent', id]); status = 'sent'; },
    retryNotification: async (...args) => calls.push(['retry', ...args]),
    getNotificationStatus: async () => status,
  };
  const notifier = createOutboxNotifier({ repository, transport: { send: async (message) => calls.push(['send', message]) } });
  assert.equal(await notifier.send('safe notice'), true);
  assert.deepEqual(calls.map((call) => call[0]), ['enqueue', 'send', 'sent']);
  assert.match(calls[0][1].dedupeKey, /^[a-f0-9]{64}$/);
});

test('separate system-error events do not reuse a permanently sent dedupe key', async () => {
  const keys = [];
  const repository = {
    enqueueNotification: async ({ dedupeKey }) => keys.push(dedupeKey),
    claimNotifications: async () => [{ id: 1, message: 'system_error', attempts: 1 }],
    markNotificationSent: async () => {},
    retryNotification: async () => assert.fail('delivery succeeds'),
    getNotificationStatus: async () => 'sent',
  };
  let sent = 0;
  const notifier = createOutboxNotifier({ repository, transport: { send: async () => { sent++; } } });
  await notifier.send('system_error');
  await notifier.send('system_error');
  assert.equal(sent, 2);
  assert.notEqual(keys[0], keys[1]);
});

test('failed Telegram delivery stays in the retryable outbox and does not leak provider errors', async () => {
  let retries = 0;
  const repository = {
    enqueueNotification: async () => {},
    claimNotifications: async () => [{ id: 1, message: 'safe notice', attempts: 1 }],
    markNotificationSent: async () => assert.fail('failed delivery cannot be marked sent'),
    retryNotification: async (_id, code) => { assert.equal(code, 'delivery_failed'); retries++; },
    getNotificationStatus: async () => 'pending',
  };
  const notifier = createOutboxNotifier({ repository, transport: { send: async () => { throw new Error('token=secret'); } } });
  await assert.rejects(notifier.send('safe notice'), { code: 'notification_delivery_pending' });
  assert.equal(retries, 1);
});

test('daily click insight treats missing permissions and null provider values as unavailable', () => {
  const { extractClickMetric } = require('../src/insights');
  assert.deepEqual(extractClickMetric({ data: { metrics: { clicks: null } }, missing_permission: true }), { available: false, value: null, reason: 'permission_missing' });
  assert.deepEqual(extractClickMetric({ data: { metrics: { clicks: { total: 27 } } } }), { available: true, value: 27, reason: null });
});

test('click insight uses the requested account, 30 day range, and configured timezone', async () => {
  const { getClickMetric } = require('../src/insights');
  let request;
  const metric = await getClickMetric({ publisher: { getInsights: async (accountId, query) => { request = { accountId, query }; return { data: { metrics: { clicks: 27 } } }; } }, accountId: 'acct-1', timezone: 'Asia/Kuala_Lumpur', now: new Date('2026-11-06T00:00:00Z') });
  assert.deepEqual(request, { accountId: 'acct-1', query: { metrics: ['clicks'], from: '2026-10-08', to: '2026-11-06', tz: 'Asia/Kuala_Lumpur' } });
  assert.deepEqual(metric, { available: true, value: 27, reason: null });
});
