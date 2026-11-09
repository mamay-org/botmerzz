'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { contentSafetyHash } = require('../src/content-safety');

test('changing only the posting interval does not invalidate a prepared content snapshot', () => {
  const settings = {
    schedule: { intervalMinutes: 15, timezone: 'Asia/Kuala_Lumpur' },
    brand: { name: 'Kedai Merzz', voice: 'Santai' },
    guardrails: { approved: true, forbiddenClaims: [], approvedClaims: [] },
    hashtags: ['#KedaiMerzz'],
  };
  assert.equal(contentSafetyHash(settings), contentSafetyHash({
    ...settings,
    schedule: { ...settings.schedule, intervalMinutes: 135, timezone: 'UTC' },
  }));
  assert.notEqual(contentSafetyHash(settings), contentSafetyHash({
    ...settings,
    brand: { ...settings.brand, voice: 'Formal' },
  }));
});
