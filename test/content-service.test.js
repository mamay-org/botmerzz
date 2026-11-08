const test = require('node:test');
const assert = require('node:assert/strict');
const { generatePost } = require('../src/content-service');

const now = '2026-11-05T04:00:00Z';
const base = {
  now,
  settings: {
    priceMode: 'ON', gameWhitelist: ['Mobile Legends'],
    brand: { name: 'Kedai Merzz', voice: 'mesra', audienceNotes: 'Pemain santai', contentDirection: 'Bina perbualan yang santai.' },
    guardrails: { approved: true, forbiddenClaims: ['termurah'], approvedClaims: [] },
    trackedLinks: { topup: 'https://example.test/t', account: 'https://example.test/a' },
  },
  facts: [
    { id: 'topup', pillar: 'topup', game: 'Mobile Legends', active: true, updatedAt: now, price: '30', denomination: '400 Diamond' },
    { id: 'account', pillar: 'account', game: 'Mobile Legends', active: true, updatedAt: now, price: '80', attributes: ['Mythic'] },
  ],
  history: [],
};
const caption = 'Setiap pemain ada cara tersendiri untuk menikmati permainan.\n\nKorang lebih suka bermain santai atau mencuba strategi baharu?';
function mockGeneration(text = caption, audit = { valid: true, factIds: [] }) {
  const requests = [];
  return { requests, generate: async (request) => {
    requests.push(request);
    return requests.length % 2 ? text : JSON.stringify(audit);
  } };
}

test('generates and checks a complete caption without appending a product template', async () => {
  const mock = mockGeneration();
  const result = await generatePost(base, mock);
  assert.equal(result.status, 'ready');
  assert.equal(result.text, caption);
  assert.equal(result.factBearing, false);
  assert.deepEqual(result.factIds, []);
  assert.equal(mock.requests.length, 2);
  assert.match(mock.requests[0].user, /Bina perbualan yang santai/);
  assert.match(mock.requests[0].user, /Pemain santai/);
});

test('missing brand or voice prevents generation during onboarding', async () => {
  for (const brand of [{ ...base.settings.brand, name: '' }, { ...base.settings.brand, voice: '' }]) {
    const result = await generatePost({ ...base, settings: { ...base.settings, brand } }, { generate: async () => { throw Error('must not call'); } });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'ONBOARDING_INCOMPLETE');
    assert.equal(result.attempts, 0);
  }
});

test('does not expose stale, inactive or unapproved product facts to generation', async () => {
  for (const variation of [
    { ...base, now: '2026-11-07T04:00:00Z' },
    { ...base, facts: base.facts.map((fact) => ({ ...fact, active: false })) },
    { ...base, settings: { ...base.settings, guardrails: { ...base.settings.guardrails, approved: false } } },
  ]) {
    const mock = mockGeneration();
    const result = await generatePost(variation, mock);
    assert.equal(result.status, 'ready');
    assert.doesNotMatch(mock.requests[0].user, /400 Diamond|"price":"30"/);
    assert.equal(result.factBearing, false);
  }
});

test('a semantic audit that rejects unsupported assertions prevents publishing', async () => {
  const mock = mockGeneration('Kedai Merzz menjamin transaksi selamat.', { valid: false, factIds: [] });
  const result = await generatePost(base, mock);
  assert.equal(result.status, 'skipped');
  assert.equal(result.text, undefined);
});

test('invalid or unavailable semantic audit fails closed', async () => {
  for (const audit of ['not-json', '{"valid":true}', '{"valid":true,"factIds":["invented"]}']) {
    let calls = 0;
    const result = await generatePost(base, { generate: async () => ++calls % 2 ? caption : audit });
    assert.equal(result.status, 'skipped', audit);
    assert.equal(result.text, undefined);
  }
  let calls = 0;
  const result = await generatePost(base, { generate: async () => { if (++calls % 2) return caption; throw Error('private upstream details'); } });
  assert.equal(result.status, 'skipped');
  assert.doesNotMatch(JSON.stringify(result), /private upstream details/);
});

test('unapproved links, personal information, and overlong output cannot be published', async () => {
  for (const text of [
    'Lihat https://evil.test untuk maklumat lanjut.',
    'Hubungi saya di pelanggan@example.com untuk bantuan.',
    'A'.repeat(501),
    'Tawaran termurah untuk semua pemain!',
  ]) {
    const result = await generatePost(base, mockGeneration(text));
    assert.equal(result.status, 'skipped', text);
    assert.equal(result.text, undefined);
  }
});

test('a repeated full caption in published history is rejected', async () => {
  const history = [{ status: 'published', pillar: 'topup', caption, completedAt: now }];
  const result = await generatePost({ ...base, history }, mockGeneration());
  assert.equal(result.status, 'skipped');
  assert.equal(result.text, undefined);
});

test('provider failures are normalized and do not expose provider response', async () => {
  const result = await generatePost(base, { generate: async () => { throw Object.assign(new Error('secret-provider-body'), { code: 'network_error' }); } });
  assert.equal(result.status, 'skipped');
  assert.equal(result.diagnosticCode, 'ai_network_error');
  assert.doesNotMatch(JSON.stringify(result), /secret-provider-body/);
});

test('approved fresh product facts are passed to the model and used fact IDs are tracked', async () => {
  const text = 'Untuk Mobile Legends, 400 Diamond berharga MYR 30. Apa yang biasanya korang pertimbangkan sebelum memilih?';
  const mock = mockGeneration(text, { valid: true, factIds: ['topup'] });
  const result = await generatePost(base, mock);
  assert.equal(result.status, 'ready');
  assert.equal(result.text, text);
  assert.equal(result.factBearing, true);
  assert.deepEqual(result.factIds, ['topup']);
  const prompt = JSON.parse(mock.requests[0].user);
  assert.equal(prompt.facts[0].denomination, '400 Diamond');
  assert.equal(prompt.facts[0].price, '30');
});

test('OFF price mode excludes structured product facts from the model context', async () => {
  const mock = mockGeneration();
  const result = await generatePost({ ...base, settings: { ...base.settings, priceMode: 'OFF' } }, mock);
  assert.equal(result.status, 'ready');
  assert.deepEqual(JSON.parse(mock.requests[0].user).facts, []);
});
