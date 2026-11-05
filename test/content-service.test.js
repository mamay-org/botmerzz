const test = require('node:test');
const assert = require('node:assert/strict');
const { generatePost } = require('../src/content-service');

const now = '2026-11-05T04:00:00Z';
const base = {
  now,
  settings: {
    priceMode: 'OFF', gameWhitelist: ['Mobile Legends'],
    brand: { name: 'Test Brand', voice: 'mesra', audienceNotes: 'Pemain santai' },
    guardrails: { approved: true, forbiddenClaims: ['termurah'], approvedClaims: [] },
    trackedLinks: { topup: 'https://example.test/t', account: 'https://example.test/a' },
  },
  facts: [
    { id: 1, pillar: 'topup', game: 'Mobile Legends', active: true, updatedAt: now, price: 30, denomination: '400 Diamond' },
    { id: 2, pillar: 'account', game: 'Mobile Legends', active: true, updatedAt: now, price: 80, attributes: ['Mythic'] },
  ], history: [],
};

test('OFF omits facts and appends the pillar tracked link, using structured Malay prompts', async () => {
  let prompt;
  const result = await generatePost(base, { generate: async (input) => { prompt = input; return 'Jom kongsi pengalaman bermain!'; } });
  assert.equal(result.status, 'ready');
  assert.equal(result.factBearing, false);
  assert.deepEqual(result.factIds, []);
  assert.equal(result.text, 'Jom kongsi pengalaman bermain!\nTop-up Mobile Legends.\nhttps://example.test/t');
  assert.match(prompt.system, /Bahasa Melayu Malaysia/);
  assert.doesNotMatch(prompt.user, /400 Diamond|Mythic|"price":30|Mobile Legends/);
  assert.match(prompt.user, /Pemain santai/);
});

test('ON selects fresh facts and falls back to evergreen when all facts are stale', async () => {
  const context = { ...base, settings: { ...base.settings, priceMode: 'ON' } };
  let prompt;
  const result = await generatePost(context, { generate: async (input) => { prompt = input; return 'Jom kongsi pengalaman bermain!'; } });
  assert.equal(result.status, 'ready');
  assert.equal(result.factBearing, true);
  assert.deepEqual(result.factIds, [1]);
  assert.equal(result.text, 'Jom kongsi pengalaman bermain!\nTop-up Mobile Legends: 400 Diamond; MYR 30.\nhttps://example.test/t');
  assert.doesNotMatch(prompt.user, /400 Diamond|Mobile Legends|30/);
  const stale = await generatePost({ ...context, now: '2026-11-07T04:00:00Z' }, { generate: async () => 'Jom kongsi pengalaman bermain!' });
  assert.equal(stale.status, 'ready');
  assert.equal(stale.factBearing, false);
});

test('MIXED targets one fact-bearing post per four published posts', async () => {
  const settings = { ...base.settings, priceMode: 'MIXED' };
  const history = [];
  for (let i = 0; i < 8; i++) {
    const result = await generatePost({ ...base, settings, history }, { generate: async () => 'Jom kongsi pengalaman bermain!' });
    assert.equal(result.status, 'ready');
    history.push({ ...result, status: 'published' });
  }
  assert.equal(history.filter((post) => post.factBearing).length, 2);
  assert.equal(history.filter((post) => post.pillar === 'topup').length, 4);
  assert.equal(history.filter((post) => post.pillar === 'account').length, 4);
});

test('pillar selection balances published history and ignores failed posts', async () => {
  const history = [{ pillar: 'topup', status: 'published' }, { pillar: 'account', status: 'failed' }];
  const result = await generatePost({ ...base, history }, { generate: async () => 'Jom kongsi pilihan anda!' });
  assert.equal(result.pillar, 'account');
  assert.match(result.text, /https:\/\/example.test\/a$/);
});

test('invalid content retries once and returns a safe typed skip without fallback', async () => {
  let calls = 0;
  const result = await generatePost(base, { generate: async () => { calls++; return 'Jom top-up MYR 999.'; } });
  assert.equal(calls, 2);
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'CONTENT_VALIDATION_FAILED');
  assert.equal(result.attempts, 2);
  assert.equal(result.text, undefined);
});

test('generation error retries once, with no provider error leakage', async () => {
  let calls = 0;
  const result = await generatePost(base, { generate: async () => { calls++; throw new Error('secret-provider-body'); } });
  assert.equal(calls, 2);
  assert.equal(result.reason, 'GENERATION_FAILED');
  assert.doesNotMatch(JSON.stringify(result), /secret-provider-body/);
});

test('a valid second attempt succeeds and final appended link counts toward length', async () => {
  let calls = 0;
  const result = await generatePost(base, { generate: async () => ++calls === 1 ? 'Jom '.repeat(124) + 'Jom!' : 'Jom kongsi pengalaman bermain!' });
  assert.equal(result.status, 'ready');
  assert.equal(result.attempts, 2);
  assert.equal(calls, 2);
});

test('missing approved guardrails or tracked links skips before generation', async () => {
  for (const patch of [{ guardrails: { approved: false } }, { trackedLinks: {} }, { gameWhitelist: [] }]) {
    const result = await generatePost({ ...base, settings: { ...base.settings, ...patch } }, { generate: async () => { throw new Error('Must not generate'); } });
    assert.equal(result.status, 'skipped');
    assert.equal(result.attempts, 0);
  }
});

test('generated hooks cannot introduce unknown games, price modifiers, quantities, or links', async () => {
  for (const hook of ['Jom main League of Legends Wild Rift!', 'Jom beli MYR 30 juta.', 'Lima ratus Diamond untuk anda.', 'Jom lihat www.evil.test', 'Jom lihat evil.test', 'Jom lihat https:', 'Jom lihat ftp://evil.test']) {
    let calls = 0;
    const result = await generatePost({ ...base, settings: { ...base.settings, priceMode: 'ON' } }, {
      generate: async () => { calls++; return hook; },
    });
    assert.equal(result.status, 'skipped', hook);
    assert.equal(calls, 2, hook);
    assert.equal(result.reason, 'CONTENT_VALIDATION_FAILED');
  }
});
