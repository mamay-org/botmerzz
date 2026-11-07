const { DateTime, IANAZone } = require('luxon');

function instant(value) {
  if (DateTime.isDateTime(value)) return value;
  if (value instanceof Date) return DateTime.fromJSDate(value, { zone: 'utc' });
  return typeof value === 'string' ? DateTime.fromISO(value, { zone: 'utc' }) : DateTime.invalid('Invalid instant');
}

function validateSettings(input = {}) {
  const errors = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { valid: false, errors: { settings: 'Use a settings object.' } };
  for (const field of ['schedule', 'brand', 'guardrails', 'trackedLinks']) {
    if (input[field] !== undefined && (!input[field] || typeof input[field] !== 'object' || Array.isArray(input[field]))) errors[field] = 'Use a structured object.';
  }
  if (Object.keys(errors).length) return { valid: false, errors };
  const source = input.schedule || {};
  const intervalHours = typeof source.intervalHours === 'string' && source.intervalHours.trim()
    ? Number(source.intervalHours) : source.intervalHours;
  const schedule = {
    intervalHours: intervalHours === undefined ? 1 : intervalHours,
    timezone: source.timezone === undefined ? 'Asia/Kuala_Lumpur' : source.timezone,
    activeDays: [1, 2, 3, 4, 5, 6, 7],
    activeStart: '00:00',
    activeEnd: '00:00',
  };
  if (typeof schedule.intervalHours !== 'number' || !Number.isFinite(schedule.intervalHours) || schedule.intervalHours < 1) {
    errors['schedule.intervalHours'] = 'Minimum interval is one hour.';
  }
  if (typeof schedule.timezone !== 'string' || !IANAZone.isValidZone(schedule.timezone)) errors['schedule.timezone'] = 'Use a valid IANA timezone.';
  const priceMode = input.priceMode === undefined ? 'OFF' : input.priceMode;
  if (!['OFF', 'ON', 'MIXED'].includes(priceMode)) errors.priceMode = 'Use OFF, ON, or MIXED.';
  const gameWhitelist = input.gameWhitelist === undefined ? [] : input.gameWhitelist;
  if (!Array.isArray(gameWhitelist) || gameWhitelist.some((game) => typeof game !== 'string' || !game.trim() || game.length > 100)) errors.gameWhitelist = 'Use a list of game names.';
  const trackedLinks = input.trackedLinks || {};
  for (const pillar of ['topup', 'account']) {
    if (!trackedLinks[pillar]) continue;
    try {
      const url = new URL(trackedLinks[pillar]);
      if (typeof trackedLinks[pillar] !== 'string' || trackedLinks[pillar].length > 300 || url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid link');
    } catch { errors[`trackedLinks.${pillar}`] = 'Use an HTTPS tracked homepage link.'; }
  }
  const brand = {};
  for (const field of ['name', 'voice', 'audienceNotes']) {
    const value = input.brand?.[field];
    if (value !== undefined && (typeof value !== 'string' || value.length > 2000)) errors[`brand.${field}`] = 'Use text up to 2000 characters.';
    else brand[field] = value?.trim() || '';
  }
  const guardrails = { approved: input.guardrails?.approved === true };
  if (input.guardrails?.approved !== undefined && typeof input.guardrails.approved !== 'boolean') errors['guardrails.approved'] = 'Use true or false.';
  for (const field of ['forbiddenClaims', 'approvedClaims']) {
    const values = input.guardrails?.[field] ?? [];
    if (!Array.isArray(values) || values.length > 100 || values.some((value) => typeof value !== 'string' || !value.trim() || value.length > 500)) errors[`guardrails.${field}`] = 'Use a list of claim phrases.';
    else guardrails[field] = [...new Set(values.map((value) => value.trim()))];
  }
  if (Object.keys(errors).length) return { valid: false, errors };
  return { valid: true, errors: {}, settings: {
    schedule, priceMode, gameWhitelist: [...new Set(gameWhitelist.map((game) => game.trim()))],
    brand, guardrails, trackedLinks: { topup: trackedLinks.topup || '', account: trackedLinks.account || '' },
  } };
}

function isInActiveWindow(value, schedule) {
  const checked = validateSettings({ schedule });
  if (!checked.valid) return false;
  return instant(value).isValid;
}

function isFactFresh(fact, now = new Date()) {
  if (!fact || fact.active !== true) return false;
  const updated = instant(fact.updatedAt);
  const current = instant(now);
  const age = current.toMillis() - updated.toMillis();
  return updated.isValid && current.isValid && age >= 0 && age <= 24 * 60 * 60 * 1000;
}

// Restrict model output to generic engagement language. Products and factual copy
// are composed from approved fields, never inferred from words in model output.
const HOOK_WORDS = Object.freeze(('jom kongsi pengalaman bermain apa apakah bagaimana kenapa bila siapa '
  + 'anda korang kita saya kami nak mahu suka pilih pilihan main permainan pemain kawan rakan '
  + 'bersama dengan dan atau yang untuk dalam semasa selepas sebelum waktu masa hari ini '
  + 'hujung minggu santai seronok menarik cerita pendapat cara gaya kegemaran cabaran '
  + 'pasukan strategi belajar cuba pernah paling lebih rasa kalau tentang pula boleh test ujian '
  + 'anda semua ada tak mana macam mula sedia bersedia jomlah').split(' '));

function composeApprovedContent(context) {
  const pillar = context.pillar;
  const facts = (context.facts || []).filter((fact) => isFactFresh(fact, context.now) && fact.pillar === pillar);
  const fact = facts[0];
  const game = fact?.game || (pillar === 'account' ? 'Mobile Legends' : context.gameWhitelist?.[0]);
  const allowed = pillar === 'account' ? game === 'Mobile Legends' : context.gameWhitelist?.includes(game);
  const safeField = (value) => typeof value === 'string' && value.trim() && value.length <= 200
    && /^[\p{L}\p{N} ,.'()+/-]+$/u.test(value) && !/[\p{L}\p{N}-]+\.[\p{L}]{2,}/u.test(value);
  if (!['topup', 'account'].includes(pillar) || !allowed || !safeField(game)) return { valid: false, errors: ['INVALID_APPROVED_PRODUCT'] };
  const details = [];
  if (fact) {
    for (const field of ['denomination', 'availability']) {
      if (fact[field] !== undefined && fact[field] !== null && fact[field] !== '' && !safeField(fact[field])) return { valid: false, errors: ['INVALID_APPROVED_FACT'] };
    }
    if (fact.denomination) details.push(fact.denomination);
    if (fact.price !== undefined && fact.price !== null && fact.price !== '') {
      const raw = String(fact.price);
      if (!/^\d+(?:\.\d{1,2})?$/.test(raw) || !Number.isFinite(Number(raw)) || Number(raw) < 0) return { valid: false, errors: ['INVALID_APPROVED_PRICE'] };
      details.push(`MYR ${raw}`);
    }
    if (fact.availability) details.push(fact.availability);
    if (fact.attributes !== undefined && (!Array.isArray(fact.attributes) || fact.attributes.some((attribute) => !safeField(attribute)))) return { valid: false, errors: ['INVALID_APPROVED_ATTRIBUTE'] };
    details.push(...(fact.attributes || []));
  }
  const factBearing = details.length > 0;
  return {
    valid: true,
    text: `${pillar === 'topup' ? 'Top-up' : 'Akaun'} ${game}${factBearing ? ': ' + details.join('; ') : ''}.`,
    factBearing, factIds: factBearing && fact.id !== undefined ? [fact.id] : [],
  };
}

function validateCaption(text, context = {}) {
  const errors = [];
  if (typeof text !== 'string' || !text.trim()) return { valid: false, errors: ['EMPTY_CAPTION'] };
  if ([...text].length > 500) errors.push('CAPTION_TOO_LONG');
  const normalized = text.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').toLowerCase();
  for (const claim of context.forbiddenClaims || []) {
    if (typeof claim === 'string' && claim.trim() && normalized.includes(claim.normalize('NFKC').toLowerCase().trim())) errors.push('FORBIDDEN_CLAIM');
  }
  let hook = text;
  if (context.trackedLink) {
    const approved = composeApprovedContent(context);
    if (!approved.valid) return { valid: false, errors: [...errors, ...approved.errors] };
    const suffix = `\n${approved.text}\n${context.trackedLink}`;
    if (!text.endsWith(suffix)) return { valid: false, errors: [...errors, 'UNAPPROVED_FACT_OR_LINK'] };
    hook = text.slice(0, -suffix.length);
  }
  const normalizedHook = hook.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').toLowerCase();
  if (!normalizedHook.trim()) errors.push('EMPTY_HOOK');
  if (/[:/@\\]|[\p{L}\p{N}-]+\.[\p{L}]{2,}/u.test(normalizedHook)) errors.push('UNAPPROVED_LINK');
  if (/\p{N}|[$€£¥]/u.test(normalizedHook)) errors.push('UNAPPROVED_QUANTITY_OR_CURRENCY');
  if (!/^[a-z\s!?,.'’-]+$/.test(normalizedHook)) errors.push('INVALID_HOOK_CHARACTERS');
  const words = normalizedHook.match(/[a-z]+/g) || [];
  if (words.some((word) => !HOOK_WORDS.includes(word))) errors.push('UNAPPROVED_HOOK_WORD');
  if (!words.some((word) => ['jom', 'jomlah', 'apa', 'apakah', 'bagaimana', 'kenapa', 'kongsi', 'anda', 'korang'].includes(word))) errors.push('MALAY_ENGAGEMENT_REQUIRED');
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

module.exports = { validateSettings, isInActiveWindow, isFactFresh, validateCaption, composeApprovedContent, HOOK_WORDS };
