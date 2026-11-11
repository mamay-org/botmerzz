'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCapture } = require('../src/learning-capture');
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('capture drops congestion and reports unknown until the isolated operation settles', async () => {
  let finish;
  const outcomes = [];
  const submit = createCapture({ store: () => new Promise((resolve) => { finish = resolve; }), logger: {info: (_event, fields) => outcomes.push(fields.outcome)}, timeoutMs: 5 });
  submit({});
  await tick();
  submit({});
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(outcomes, ['attempted', 'attempted', 'dropped', 'unknown']);
  finish({ deduplicated: false });
  await tick();
  assert.equal(outcomes.at(-1), 'captured');
});

test('capture reports duplicate and failure without logging provider errors or evidence', async () => {
  const logs = [];
  let n = 0;
  const submit = createCapture({ store: async () => { if (++n === 1) return { deduplicated: true }; throw Error('secret'); }, logger: {info: (name, fields) => logs.push([name, fields])} });
  submit({ excerpt: 'secret' }); await tick();
  submit({ excerpt: 'secret' }); await tick();
  assert.deepEqual(logs.map(([, fields]) => fields.outcome), ['attempted', 'deduplicated', 'attempted', 'failed']);
  assert.doesNotMatch(JSON.stringify(logs), /secret/);
});

test('shutdown stops accepting optional capture while an active write remains independent', async () => {
  const logs = [];
  const submit = createCapture({ store: () => new Promise(() => {}), logger: {info: (_event, fields) => logs.push(fields.outcome)} });
  submit({});
  await tick();
  assert.deepEqual(submit.stop(), { pending: true });
  submit({});
  assert.deepEqual(logs, ['attempted', 'shutdown_dropped']);
});

test('bounded optional-pool close destroys a stalled mysql2 connection after its grace period', async () => {
  const { endOptionalPoolBounded } = require('../src/db');
  let destroyed = 0;
  const pool = {
    end: () => new Promise(() => {}),
    pool: { _allConnections: { length: 1, get: () => ({
      _handleFatalError: () => { destroyed++; }, stream: { destroy: () => { destroyed++; } },
    }) } },
  };
  assert.equal(await endOptionalPoolBounded(pool, 5), false);
  assert.equal(destroyed, 2);
});
