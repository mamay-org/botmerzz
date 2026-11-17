'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkReleaseHead } = require('../scripts/check-release-head');

const commit = 'a'.repeat(40);
const base = { repository: 'mamay-org/botmerzz', commit, token: 'test-only-token' };
const response = sha => ({ ok: true, json: async () => ({ object: { sha } }) });

test('release head check accepts the current main commit', async () => {
  await checkReleaseHead({ ...base, fetchImpl: async (url, request) => {
    assert.equal(url, 'https://api.github.com/repos/mamay-org/botmerzz/git/ref/heads/main');
    assert.equal(request.headers.Authorization, 'Bearer test-only-token');
    return response(commit);
  } });
});

test('release head check rejects a stale successful CI revision', async () => {
  await assert.rejects(checkReleaseHead({ ...base, fetchImpl: async () => response('b'.repeat(40)) }), /no longer the current main head/);
});

test('release head check fails closed on unavailable or invalid GitHub responses', async () => {
  for (const fetchImpl of [async () => ({ ok: false }), async () => { throw new Error('private token details'); }, async () => response('invalid')]) {
    await assert.rejects(checkReleaseHead({ ...base, fetchImpl }), error => /Unable to verify/.test(error.message) && !error.message.includes('token'));
  }
});

test('release head check rejects malformed input before requesting GitHub', async () => {
  let called = false;
  await assert.rejects(checkReleaseHead({ ...base, repository: '../unsafe', fetchImpl: async () => { called = true; } }), /missing valid/);
  assert.equal(called, false);
});
