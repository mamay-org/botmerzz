'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createScheduler } = require('../src/scheduler');

test('scheduler starts one immediate run and prevents overlapping timer runs', async () => {
  let release;
  let calls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const scheduler = createScheduler({ run: async () => { calls++; await gate; return { published: 0 }; }, intervalMs: 1000 });
  scheduler.start();
  await new Promise((resolve) => setImmediate(resolve));
  await scheduler.tick();
  assert.equal(calls, 1);
  assert.equal(scheduler.status().running, true);
  release();
  await scheduler.stop();
  assert.equal(scheduler.status().enabled, false);
  assert.equal(scheduler.status().running, false);
  assert.equal(scheduler.status().lastResult.published, 0);
});

test('admin-triggered scheduler run waits for an active poll then immediately dispatches once', async () => {
  let release;
  let calls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const scheduler = createScheduler({ run: async () => { calls++; if (calls === 1) await gate; return { published: 0 }; }, intervalMs: 60_000 });
  scheduler.start({ runImmediately: false });
  const initial = scheduler.tick();
  const triggered = scheduler.runNow();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  await Promise.all([initial, triggered]);
  assert.equal(calls, 2);
  assert.equal(scheduler.status().running, false);
  await scheduler.stop();
});

test('scheduler records only a safe error code and continues after a failed run', async () => {
  const logged = [];
  let calls = 0;
  const scheduler = createScheduler({
    intervalMs: 1000,
    logger: { error: (...args) => logged.push(args) },
    run: async () => {
      if (calls++ === 0) throw Object.assign(new Error('token=must-not-leak'), { code: 'provider_error' });
      return { claimed: 0 };
    },
  });
  scheduler.start({ runImmediately: false });
  await scheduler.tick();
  assert.equal(scheduler.status().lastErrorCode, 'provider_error');
  assert.doesNotMatch(JSON.stringify(logged), /must-not-leak/);
  await scheduler.tick();
  assert.equal(scheduler.status().lastErrorCode, null);
  assert.deepEqual(scheduler.status().lastResult, { claimed: 0 });
  await scheduler.stop();
});

test('scheduler validates its runner and polling interval', () => {
  assert.throws(() => createScheduler({ intervalMs: 1000 }), /run/);
  assert.throws(() => createScheduler({ run() {}, intervalMs: 999 }), /intervalMs/);
});
