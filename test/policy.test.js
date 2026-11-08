const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSettings, isInActiveWindow, isFactFresh, validateCaption, composeApprovedContent, extractRecentHooks } = require('../src/policy');

const now = '2026-11-05T04:00:00Z';
const schedule = { intervalHours: 1, timezone: 'Asia/Kuala_Lumpur', activeDays: [4], activeStart: '09:00', activeEnd: '22:00' };
const fact = { id: 1, pillar: 'topup', game: 'Mobile Legends', active: true, updatedAt: now, price: 30, denomination: '400 Diamond' };
const context = { now, pillar: 'topup', facts: [fact], gameWhitelist: ['Mobile Legends'], forbiddenClaims: ['termurah', '100% selamat'], approvedClaims: [], trackedLink: 'https://example.test/topup' };

test('settings normalize 24-hour scheduling to the one-hour cadence', () => {
  const defaults = validateSettings({});
  assert.equal(defaults.settings.schedule.intervalHours, 1);
  assert.equal(defaults.settings.schedule.activeStart, '00:00');
  assert.equal(defaults.settings.schedule.activeEnd, '00:00');
  const valid = validateSettings({ schedule: { ...schedule, intervalHours: '1', timezone: undefined }, priceMode: 'MIXED' });
  assert.equal(valid.valid, true);
  assert.equal(valid.settings.schedule.intervalHours, 1);
  assert.equal(validateSettings({ schedule: { ...schedule, intervalHours: 6 } }).settings.schedule.intervalHours, 1);
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

test('settings normalize hashtag prefixes, spacing, and case-insensitive duplicates', () => {
  const checked = validateSettings({ hashtags: [' #Mobile Legends ', '##mobilelegends', ' #KedaiMerzz  '] });
  assert.equal(checked.valid, true);
  assert.deepEqual(checked.settings.hashtags, ['#MobileLegends', '#KedaiMerzz']);
});

test('tracked CTA links require HTTPS on the official domain or its subdomains', () => {
  for (const url of [
    'https://kedaimerzz.com/topup',
    'https://shop.kedaimerzz.com/topup',
    'https://www.kedaimerzz.com:443/account',
  ]) {
    const checked = validateSettings({ trackedLinks: { topup: url } });
    assert.equal(checked.valid, true, url);
  }
  for (const url of [
    'https://kedaimerzz.com.evil.test/topup',
    'https://evil-kedaimerzz.com/topup',
    'https://attacker.kedaimerzz.com.evil.test/topup',
    'http://kedaimerzz.com/topup',
    'https://user@kedaimerzz.com/topup',
    'https://kedaimerzz.com:444/topup',
    'not a URL',
    42,
  ]) {
    const checked = validateSettings({ trackedLinks: { topup: url } });
    assert.equal(checked.valid, false, String(url));
    assert.ok(checked.errors['trackedLinks.topup'], String(url));
  }
});

test('settings trim and persist the bounded AI content direction', () => {
  const direction = '  Utamakan soalan santai tentang pengalaman bermain bersama kawan.  ';
  const checked = validateSettings({ brand: { contentDirection: direction } });
  assert.equal(checked.valid, true);
  assert.equal(checked.settings.brand.contentDirection, direction.trim());
  assert.equal(validateSettings({ brand: { contentDirection: 'x'.repeat(7000) } }).valid, true);
  assert.equal(validateSettings({ brand: { contentDirection: 'x'.repeat(7001) } }).valid, false);
  assert.equal(validateSettings({ brand: { contentDirection: 12 } }).valid, false);
});

test('settings normalize optional hook vocabulary guidance', () => {
  const checked = validateSettings({ guardrails: {
    hookVocabulary: ['  Cerita pengalaman  ', 'cerita PENGALAMAN', 'Sembang santai'],
  } });
  assert.equal(checked.valid, true);
  assert.deepEqual(checked.settings.guardrails.hookVocabulary, ['Cerita pengalaman', 'Sembang santai']);
  assert.deepEqual(validateSettings({}).settings.guardrails.hookVocabulary, []);
  assert.equal(validateSettings({ guardrails: { hookVocabulary: Array(101).fill('kata') } }).valid, false);
  assert.equal(validateSettings({ guardrails: { hookVocabulary: ['x'.repeat(501)] } }).valid, false);
});

test('settings preserve 2000-character name and voice limits with 7000-character guidance fields', () => {
  const checked = validateSettings({ brand: {
    name: 'N'.repeat(2000),
    voice: 'V'.repeat(2000),
    audienceNotes: '漢'.repeat(7000),
    contentDirection: '語'.repeat(7000),
  } });
  assert.equal(checked.valid, true);
  assert.equal(checked.settings.brand.name.length, 2000);
  assert.equal(checked.settings.brand.voice.length, 2000);
  assert.equal(checked.settings.brand.audienceNotes.length, 7000);
  assert.equal(checked.settings.brand.contentDirection.length, 7000);

  for (const field of ['name', 'voice']) {
    const invalid = validateSettings({ brand: { [field]: 'x'.repeat(2001) } });
    assert.equal(invalid.valid, false);
    assert.equal(invalid.errors[`brand.${field}`], 'Use text up to 2000 characters.');
  }
});

test('settings reject malformed hashtag lists and unsafe tag characters', () => {
  for (const hashtags of ['#KedaiMerzz', ['#tag!'], ['#tag/name'], [1], Array(31).fill('#tag')]) {
    assert.equal(validateSettings({ hashtags }).valid, false, JSON.stringify(hashtags));
  }
});

test('caption accepts configured hashtags and rejects tags outside the configured list', () => {
  const caption = 'Jom #KedaiMerzz kongsi pengalaman bermain!\nTop-up Mobile Legends.\nhttps://example.test/topup\n#MobileLegends';
  const contextWithHashtags = { ...context, facts: [], hashtags: ['#KedaiMerzz', '#MobileLegends'] };
  assert.equal(validateCaption(caption, contextWithHashtags).valid, true);
  assert.equal(validateCaption(caption.replace('#MobileLegends', '#OtherGame'), contextWithHashtags).valid, false);
});

test('approved tracked URL fragments are not parsed or removed as post hashtags', () => {
  const trackedLink = 'https://example.test/topup/#section';
  const caption = `Jom kongsi pengalaman bermain!\nTop-up Mobile Legends: 400 Diamond; MYR 30.\n${trackedLink}`;
  assert.equal(validateCaption(caption, { ...context, trackedLink, hashtags: [] }).valid, true);
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

test('safe Malay hooks may use words outside optional vocabulary and need no fixed trigger word', () => {
  const text = 'Malam tadi saya terfikir tentang pengalaman bersama rakan.\nTop-up Mobile Legends.\nhttps://example.test/topup';
  const result = validateCaption(text, { ...context, facts: [], hookVocabulary: ['Sembang santai'] });
  assert.equal(result.valid, true, result.errors.join(', '));
  assert.equal(result.errors.includes('UNAPPROVED_HOOK_WORD'), false);
  assert.equal(result.errors.includes('MALAY_ENGAGEMENT_REQUIRED'), false);
});

test('saved captions yield only the five latest published hooks without product copy, links, or hashtags', () => {
  const hooks = [
    'Jom kongsi pengalaman bermain bersama kawan?',
    'Apa cabaran paling menarik semasa bermain bersama kawan?',
    'Korang suka pilih permainan bersama kawan?',
    'Bagaimana anda belajar strategi bersama rakan?',
    'Jom cerita pengalaman santai selepas bermain?',
    'Apa pilihan paling seronok semasa bermain bersama?',
  ];
  const posts = hooks.map((hook, index) => ({
    status: 'published',
    completedAt: `2026-11-05T0${index}:00:00Z`,
    caption: `${hook}\nTop-up Mobile Legends.\nhttps://example.test/topup\n#KedaiMerzz`,
  })).concat({
    status: 'failed',
    completedAt: '2026-11-05T06:00:00Z',
    caption: 'Jom kongsi pengalaman bermain bersama kawan?\nTop-up Mobile Legends.\nhttps://example.test/topup',
  });
  const result = extractRecentHooks(posts);
  assert.deepEqual(result, [hooks[5], hooks[4], hooks[3], hooks[2], hooks[1]]);
});

test('recent hook ordering falls back from invalid completion time to scheduled and created times', () => {
  const caption = (hook) => `${hook}\nTop-up Mobile Legends.\nhttps://example.test/topup`;
  const posts = [
    { status: 'published', completedAt: '2026-11-05T04:00:00Z', caption: caption('Jom kongsi pengalaman bermain bersama kawan?') },
    { status: 'published', completedAt: 'invalid', scheduledAt: '2026-11-05T05:00:00Z', caption: caption('Apa cabaran paling menarik semasa bermain bersama kawan?') },
    { status: 'published', completedAt: 'invalid', scheduledAt: 'invalid', createdAt: '2026-11-05T06:00:00Z', caption: caption('Korang suka pilih permainan bersama kawan?') },
  ];
  assert.deepEqual(extractRecentHooks(posts), [
    'Korang suka pilih permainan bersama kawan?',
    'Apa cabaran paling menarik semasa bermain bersama kawan?',
    'Jom kongsi pengalaman bermain bersama kawan?',
  ]);
});

test('caption validation rejects an eight-word overlapping hook but accepts a distinct angle', () => {
  const recentHooks = ['Jom kongsi pengalaman bermain bersama rakan tentang cabaran?'];
  const repetitive = validateCaption('Jom kongsi pengalaman bermain dengan rakan tentang cabaran?\nTop-up Mobile Legends.\nhttps://example.test/topup', {
    ...context, facts: [], recentHooks,
  });
  assert.equal(repetitive.valid, false);
  assert.ok(repetitive.errors.includes('REPETITIVE_HOOK'));

  const distinct = validateCaption('Apa pilihan paling seronok semasa bermain bersama?\nTop-up Mobile Legends.\nhttps://example.test/topup', {
    ...context, facts: [], recentHooks,
  });
  assert.equal(distinct.valid, true);
});

test('caption validation rejects short exact duplicates but allows short non-identical hooks', () => {
  const exactRepeat = validateCaption('JOM KONGSI PILIHAN!\nTop-up Mobile Legends.\nhttps://example.test/topup', {
    ...context, facts: [], recentHooks: ['Jom kongsi pilihan?'],
  });
  assert.equal(exactRepeat.valid, false);
  assert.ok(exactRepeat.errors.includes('REPETITIVE_HOOK'));

  const nonIdentical = validateCaption('Jom kongsi pengalaman bersama!\nTop-up Mobile Legends.\nhttps://example.test/topup', {
    ...context, facts: [], recentHooks: ['Jom kongsi pengalaman anda?'],
  });
  assert.equal(nonIdentical.valid, true);
  assert.equal(nonIdentical.errors.includes('REPETITIVE_HOOK'), false);
});

test('approved content omits unsafe stored attributes and keeps safe approved details', () => {
  const result = composeApprovedContent({
    now,
    pillar: 'account',
    facts: [{ id: 'account', pillar: 'account', game: 'Mobile Legends', active: true, updatedAt: now, attributes: ['Mythic ✨', 'Rank Mythic'] }],
    gameWhitelist: ['Mobile Legends'],
  });
  assert.equal(result.valid, true);
  assert.equal(result.text, 'Akaun Mobile Legends: Rank Mythic.');
  assert.equal(result.factBearing, true);
  assert.deepEqual(result.factIds, ['account']);
});

test('optional product composition can fall back to an empty safe suffix', () => {
  const result = composeApprovedContent({
    now, pillar: 'topup', facts: [], gameWhitelist: [], allowGeneric: true,
  });
  assert.deepEqual(result, { valid: true, text: '', factBearing: false, factIds: [] });
});

test('caption validation supports generic hooks and optional suffixes without links', () => {
  const hook = 'Malam tadi saya terfikir tentang pengalaman bersama rakan.';
  const generic = validateCaption(hook, {
    now, pillar: 'topup', facts: [], gameWhitelist: [], allowGeneric: true, includeProduct: false,
  });
  assert.equal(generic.valid, true, generic.errors.join(', '));

  const product = validateCaption(`${hook}\nTop-up Mobile Legends.`, {
    now, pillar: 'topup', facts: [], gameWhitelist: ['Mobile Legends'], allowGeneric: true, includeProduct: true,
  });
  assert.equal(product.valid, true, product.errors.join(', '));
});

test('caption validation supports an optional tracked link without product composition', () => {
  const link = 'https://example.test/topup';
  const result = validateCaption(`Malam tadi saya terfikir tentang pengalaman bersama rakan.\n${link}`, {
    now, pillar: 'topup', facts: [], gameWhitelist: [], allowGeneric: true, includeProduct: false, trackedLink: link,
  });
  assert.equal(result.valid, true, result.errors.join(', '));
});

test('approved content falls back to evergreen product text when every stored attribute is unsafe', () => {
  const result = composeApprovedContent({
    now,
    pillar: 'account',
    facts: [{ id: 'account', pillar: 'account', game: 'Mobile Legends', active: true, updatedAt: now, attributes: ['Akaun ✨'] }],
    gameWhitelist: ['Mobile Legends'],
  });
  assert.equal(result.valid, true);
  assert.equal(result.text, 'Akaun Mobile Legends.');
  assert.equal(result.factBearing, false);
  assert.deepEqual(result.factIds, []);
});

test('approved content omits overlong and over-count legacy attributes at the shared API limits', () => {
  const longAttribute = 'A'.repeat(101);
  const overlong = composeApprovedContent({
    now,
    pillar: 'account',
    facts: [{ id: 'account', pillar: 'account', game: 'Mobile Legends', active: true, updatedAt: now, attributes: [longAttribute, 'Rank Mythic'] }],
    gameWhitelist: ['Mobile Legends'],
  });
  assert.equal(overlong.valid, true);
  assert.equal(overlong.text, 'Akaun Mobile Legends: Rank Mythic.');
  assert.doesNotMatch(overlong.text, /A{101}/);

  const attributes = Array.from({ length: 20 }, (_, index) => `Rank ${index + 1}`).concat('Overflow Rank');
  const excess = composeApprovedContent({
    now,
    pillar: 'account',
    facts: [{ id: 'account', pillar: 'account', game: 'Mobile Legends', active: true, updatedAt: now, attributes }],
    gameWhitelist: ['Mobile Legends'],
  });
  assert.equal(excess.valid, true);
  assert.match(excess.text, /Rank 20/);
  assert.doesNotMatch(excess.text, /Overflow Rank/);
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

test('generated hooks reject configured forbidden game claims, spelled quantities, prices, and all link forms', () => {
  for (const hook of [
    'Jom beli MYR 30 juta.',
    'Jom lihat www.evil.test', 'Jom lihat evil.test', 'Jom lihat https://evil.test',
    'Jom lihat ftp://evil.test', 'Jom lihat javascript:alert(1)', 'Jom lihat https:',
    'Jom lihat HTTPS://example.test/topup',
  ]) assert.equal(validateCaption(hook).valid, false, hook);
  assert.equal(validateCaption('Jom main League of Legends Wild Rift?', { forbiddenClaims: ['League of Legends Wild Rift'] }).valid, false);
  assert.equal(validateCaption('Jom lihat stok tersedia.', { forbiddenClaims: ['stok tersedia'] }).valid, false);
  assert.equal(validateCaption('Jom lihat Mythic.', { forbiddenClaims: ['Mythic'] }).valid, false);
});

test('spelled-out quantities are rejected near units while ordinary Malay numbers remain allowed', () => {
  for (const hook of ['Lima ratus Diamond untuk anda.', 'Dua akaun untuk dipilih.', 'MYR tiga puluh ringgit']) {
    const result = validateCaption(hook);
    assert.equal(result.valid, false, hook);
    assert.ok(result.errors.includes('UNAPPROVED_QUANTITY_OR_CURRENCY'), hook);
  }
  const safe = validateCaption('Satu pengalaman bermain yang paling berkesan?');
  assert.equal(safe.valid, true, safe.errors.join(', '));
});

test('full-caption validator accepts natural multiline text and detects duplicate published captions', () => {
  const { validateFullCaption } = require('../src/content-validation');
  const text = 'Setiap pemain ada cara tersendiri untuk menikmati permainan.\n\nKorang lebih suka bermain santai atau mencuba strategi baharu?';
  assert.equal(validateFullCaption(text, {}).valid, true);
  const duplicate = validateFullCaption(text, { recentCaptions: [text] });
  assert.ok(duplicate.errors.includes('REPETITIVE_CAPTION'));
});

test('full-caption validator rejects unapproved links, hashtags, numbers and personal information', () => {
  const { validateFullCaption } = require('../src/content-validation');
  const ctx = { facts: [fact], gameWhitelist: ['Mobile Legends'], hashtags: ['#KedaiMerzz'], trackedLink: 'https://example.test/topup' };
  for (const [text, code] of [
    ['Harga MYR 999 untuk anda', 'UNAPPROVED_NUMBER'],
    ['Layari https://evil.test sekarang', 'UNAPPROVED_LINK'],
    ['Boleh hubungi pelanggan@example.com', 'POSSIBLE_PERSONAL_INFORMATION'],
    ['Pilihan anda #Unknown', 'UNAPPROVED_HASHTAG'],
    ['X'.repeat(501), 'CAPTION_TOO_LONG'],
  ]) assert.ok(validateFullCaption(text, ctx).errors.includes(code), text);
  assert.equal(validateFullCaption('Harga MYR 30 untuk 400 Diamond. #KedaiMerzz', ctx).valid, true);
});

test('full-caption validator rejects domains that extend an allowed URL', () => {
  const { validateFullCaption } = require('../src/content-validation');
  const ctx = { trackedLink: 'https://example.test/topup' };
  assert.ok(validateFullCaption('Layari https://example.test/topup.evil.test', ctx).errors.includes('UNAPPROVED_LINK'));
  assert.ok(validateFullCaption('Layari https://malicious.xyz', ctx).errors.includes('UNAPPROVED_LINK'));
  assert.equal(validateFullCaption('Layari https://example.test/topup', ctx).valid, true);
});
