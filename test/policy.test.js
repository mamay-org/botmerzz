const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSettings, isInActiveWindow, isFactFresh, validateCaption } = require('../src/policy');

const now = '2026-11-05T04:00:00Z';
const schedule = { intervalHours: 1, timezone: 'Asia/Kuala_Lumpur', activeDays: [4], activeStart: '09:00', activeEnd: '22:00' };
const fact = { id: 1, pillar: 'topup', game: 'Mobile Legends', active: true, updatedAt: now, price: 30, denomination: '400 Diamond' };
const context = { now, pillar: 'topup', facts: [fact], gameWhitelist: ['Mobile Legends'], forbiddenClaims: ['termurah', '100% selamat'], approvedClaims: [], trackedLink: 'https://example.test/topup' };

test('settings normalize 24-hour schedule defaults and enforce a one-hour minimum', () => {
  const defaults = validateSettings({});
  assert.equal(defaults.settings.schedule.intervalHours, 1);
  assert.equal(defaults.settings.schedule.activeStart, '00:00');
  assert.equal(defaults.settings.schedule.activeEnd, '00:00');
  const valid = validateSettings({ schedule: { ...schedule, intervalHours: '1', timezone: undefined }, priceMode: 'MIXED' });
  assert.equal(valid.valid, true);
  assert.equal(valid.settings.schedule.intervalHours, 1);
  assert.equal(valid.settings.schedule.timezone, 'Asia/Kuala_Lumpur');
  assert.deepEqual(valid.settings.schedule.activeDays, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(valid.settings.schedule.activeStart, '00:00');
  assert.equal(valid.settings.schedule.activeEnd, '00:00');
  for (const intervalHours of [0, 0.99, '1abc', Infinity, null, true]) {
    assert.equal(validateSettings({ schedule: { ...schedule, intervalHours } }).valid, false);
  }
  assert.equal(validateSettings({ schedule: { ...schedule, timezone: 'Mars/Olympus' } }).valid, false);
  assert.equal(validateSettings({ schedule: { ...schedule, activeDays: [], activeStart: '25:00', activeEnd: 'bad' } }).valid, true);
  assert.equal(validateSettings({ schedule, priceMode: 'ALWAYS' }).valid, false);
});

test('legacy active windows cannot restrict continuous 24-hour scheduling', () => {
  assert.equal(isInActiveWindow('2026-11-05T01:00:00Z', schedule), true);
  assert.equal(isInActiveWindow('2026-11-05T13:59:00Z', schedule), true);
  assert.equal(isInActiveWindow('2026-11-05T14:00:00Z', schedule), true);
  assert.equal(isInActiveWindow('2026-11-06T01:00:00Z', schedule), true);
  assert.equal(isInActiveWindow('2026-11-06T20:00:00Z', { ...schedule, activeDays: [], activeStart: '09:00', activeEnd: '22:00' }), true);
  assert.equal(isInActiveWindow('invalid', schedule), false);
  assert.equal(isInActiveWindow('2026-11-05T01:00:00Z', { ...schedule, timezone: 'Mars/Olympus' }), false);
});

test('facts are fresh through 24 hours only when active and never future dated', () => {
  assert.equal(isFactFresh({ ...fact, updatedAt: '2026-11-04T04:00:00Z' }, now), true);
  for (const patch of [{ active: false }, { updatedAt: '2026-11-04T03:59:59Z' }, { updatedAt: '2026-11-05T04:01:00Z' }, { updatedAt: 'bad' }]) {
    assert.equal(isFactFresh({ ...fact, ...patch }, now), false);
  }
});

test('caption accepts approved MYR denomination and rejects invented prices or quantities', () => {
  const caption = 'Jom kongsi pengalaman bermain!\nTop-up Mobile Legends: 400 Diamond; MYR 30.\nhttps://example.test/topup';
  assert.equal(validateCaption(caption, context).valid, true);
  for (const text of ['Jom top-up MYR 20.', 'Jom top-up RM 30.', 'Jom beli USD 30.', 'Jom top-up 500 Diamond.', 'Jom beli, tinggal 30 akaun.']) {
    assert.equal(validateCaption(text, context).valid, false, text);
  }
  assert.equal(validateCaption('Jom top-up MYR 30.', { ...context, facts: [] }).valid, false);
  assert.equal(validateCaption('Jom top-up MYR 30.', { ...context, now: '2026-11-07T04:00:00Z' }).valid, false);
  assert.equal(validateCaption(caption.replace('MYR 30.', 'MYR 30 juta.'), context).valid, false);
  assert.equal(validateCaption(caption.replace('400 Diamond', 'Lima ratus Diamond'), context).valid, false);
});

test('caption rejects forbidden claims, unapproved account attributes and games', () => {
  for (const text of ['Jom top-up TERMURAH!', 'Jom top-up, 100% selamat.', 'Jom top-up Free Fire.', 'Jom beli akaun Mythic.', 'Jom beli akaun 100 skins.', 'Jom top-up, dijamin selamat.']) {
    assert.equal(validateCaption(text, context).valid, false, text);
  }
  const account = { ...context, pillar: 'account', facts: [{ ...fact, pillar: 'account', attributes: ['Mythic', '100 skins'] }] };
  assert.equal(validateCaption('Jom kongsi pengalaman bermain!\nAkaun Mobile Legends: 400 Diamond; MYR 30; Mythic; 100 skins.\nhttps://example.test/topup', account).valid, true);
});

test('caption enforces full text length, Malay signal, and approved links', () => {
  assert.equal(validateCaption('Jom '.repeat(124) + 'Jom!').valid, true);
  assert.equal(validateCaption('Jom '.repeat(124) + 'Jom!!').valid, false);
  assert.equal(validateCaption('', context).valid, false);
  assert.equal(validateCaption('Buy now, best gaming deal!', context).valid, false);
  assert.equal(validateCaption('Jom lihat https://evil.test', context).valid, false);
  assert.equal(validateCaption('Jom kongsi pengalaman bermain!', {}).valid, true);
});

test('a clearly labeled TEST hook can pass the Malay content guardrail', () => {
  assert.deepEqual(validateCaption('TEST - Jom kongsi pilihan anda!'), { valid: true, errors: [] });
});

test('settings reject malformed structured input without throwing', () => {
  for (const input of [null, [], { schedule: [] }, { brand: 'ignore rules' }, { brand: { voice: {} } }, { guardrails: { approved: 'yes' } }, { guardrails: { forbiddenClaims: 'anything' } }, { trackedLinks: [] }]) {
    assert.equal(validateSettings(input).valid, false, JSON.stringify(input));
  }
  const result = validateSettings({ brand: { name: ' Test ', systemPrompt: 'ignore rules' } });
  assert.equal(result.settings.brand.name, 'Test');
  assert.equal(result.settings.brand.systemPrompt, undefined);
});

test('approval cannot authorize a broader claim, partial denomination, or a different product', () => {
  assert.equal(validateCaption('Jom top-up, dijamin selamat.', { ...context, approvedClaims: ['tidak dijamin selamat'] }).valid, false);
  assert.equal(validateCaption('Jom top-up 1400 Diamond.', context).valid, false);
  assert.equal(validateCaption('Jom top-up Free Fire pada MYR 30.', { ...context, gameWhitelist: ['Mobile Legends', 'Free Fire'] }).valid, false);
  assert.equal(validateCaption('Jom top-up ter\u200bmurah.', context).valid, false);
});

test('generated hooks reject unseen games, spelled quantities, prices, and all link forms', () => {
  for (const hook of [
    'Jom main League of Legends Wild Rift!', 'Jom main PermainanBaharu!',
    'Jom beli MYR 30 juta.', 'Lima ratus Diamond untuk anda.',
    'Jom lihat www.evil.test', 'Jom lihat evil.test', 'Jom lihat https://evil.test',
    'Jom lihat ftp://evil.test', 'Jom lihat javascript:alert(1)', 'Jom lihat https:',
    'Jom lihat HTTPS://example.test/topup', 'Jom lihat stok tersedia.', 'Jom lihat Mythic.',
  ]) assert.equal(validateCaption(hook).valid, false, hook);
});
