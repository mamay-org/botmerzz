'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createIpRateLimiter } = require('../src/rate-limit');

function response() {
  return {
    headers: {}, statusCode: null, body: null,
    set(key, value) { this.headers[key] = value; return this; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

test('IP limiter rejects excess requests, gives a bounded retry time, then resets', () => {
  let now = 1000;
  const limit = createIpRateLimiter({ limit: 2, windowMs: 5000, clock: () => now });
  let passed = 0;
  const req = { ip: '192.0.2.10' };
  for (let index = 0; index < 2; index++) limit(req, response(), () => passed++);
  const blocked = response();
  limit(req, blocked, () => passed++);
  assert.equal(passed, 2);
  assert.equal(blocked.statusCode, 429);
  assert.deepEqual(blocked.body, { error: 'RATE_LIMITED' });
  assert.equal(blocked.headers['Retry-After'], '5');
  now += 5000;
  limit(req, response(), () => passed++);
  assert.equal(passed, 3);
});

test('IP limiter accepts a socket address fallback and validates its limits', () => {
  const limit = createIpRateLimiter({ limit: 1, windowMs: 1000 });
  let passed = 0;
  limit({ socket: { remoteAddress: '192.0.2.11' } }, response(), () => passed++);
  const blocked = response();
  limit({ socket: { remoteAddress: '192.0.2.11' } }, blocked, () => passed++);
  assert.equal(blocked.statusCode, 429);
  assert.equal(passed, 1);
  assert.throws(() => createIpRateLimiter({ limit: 0 }), /positive integers/);
});
