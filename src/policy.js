const { DateTime, IANAZone } = require('luxon');

const MAX_HASHTAGS = 30;
const MAX_HASHTAG_LENGTH = 100;
const MAX_APPROVED_ATTRIBUTE_COUNT = 20;
const MAX_APPROVED_ATTRIBUTE_LENGTH = 100;
const HASHTAG_PATTERN = /(?<![\p{L}\p{N}_])[#＃]+([\p{L}\p{N}_]+)/gu;

function hashtagKey(value) {
  return value.normalize('NFKC').replace(/^#+/u, '').replace(/\s+/gu, '').toLowerCase();
}

function normalizeHashtags(input) {
  if (!Array.isArray(input) || input.length > MAX_HASHTAGS) return null;
  const normalized = [];
  const seen = new Set();
  for (const value of input) {
    if (typeof value !== 'string' || [...value].length > MAX_HASHTAG_LENGTH) return null;
    const trimmed = value.normalize('NFKC').trim();
    if (!trimmed) continue;
    const body = trimmed.replace(/^#+/u, '').replace(/\s+/gu, '');
    if (!body || [...body].length > MAX_HASHTAG_LENGTH || !/^[\p{L}\p{N}_]+$/u.test(body)) return null;
    const key = hashtagKey(body);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(`#${body}`);
  }
  return normalized;
}

function splitAroundText(text, excludedText) {
  const index = excludedText ? text.lastIndexOf(excludedText) : -1;
  if (index < 0) return { before: text, excluded: '', after: '', separated: false };
  return {
    before: text.slice(0, index),
    excluded: excludedText,
    after: text.slice(index + excludedText.length),
    separated: true,
  };
}

function joinAroundText(parts) {
  return parts.separated ? `${parts.before}${parts.excluded}${parts.after}` : parts.before;
}

function canonicalizeHashtags(text) {
  return text.replace(HASHTAG_PATTERN, (_match, body) => `#${body.normalize('NFKC')}`);
}

function appendHashtags(text, hashtags, excludedText = '') {
  const normalized = normalizeHashtags(hashtags);
  if (!normalized || !normalized.length) return text;
  const parts = splitAroundText(text, excludedText);
  parts.before = canonicalizeHashtags(parts.before);
  parts.after = canonicalizeHashtags(parts.after);
  const normalizedText = joinAroundText(parts);
  const presentMatches = [...parts.before.matchAll(HASHTAG_PATTERN), ...parts.after.matchAll(HASHTAG_PATTERN)];
  const present = new Set(presentMatches.map((match) => hashtagKey(match[1])));
  const missing = normalized.filter((tag) => !present.has(hashtagKey(tag)));
  return missing.length ? `${normalizedText}\n${missing.join(' ')}` : normalizedText;
}

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
  const requestedIntervalHours = typeof source.intervalHours === 'string' && source.intervalHours.trim()
    ? Number(source.intervalHours) : source.intervalHours;
  const schedule = {
    intervalHours: 1,
    timezone: source.timezone === undefined ? 'Asia/Kuala_Lumpur' : source.timezone,
    activeDays: [1, 2, 3, 4, 5, 6, 7],
    activeStart: '00:00',
    activeEnd: '00:00',
  };
  if (requestedIntervalHours !== undefined && (typeof requestedIntervalHours !== 'number' || !Number.isFinite(requestedIntervalHours) || requestedIntervalHours < 1)) {
    errors['schedule.intervalHours'] = 'Minimum interval is one hour.';
  }
  if (typeof schedule.timezone !== 'string' || !IANAZone.isValidZone(schedule.timezone)) errors['schedule.timezone'] = 'Use a valid IANA timezone.';
  const priceMode = input.priceMode === undefined ? 'OFF' : input.priceMode;
  if (!['OFF', 'ON', 'MIXED'].includes(priceMode)) errors.priceMode = 'Use OFF, ON, or MIXED.';
  const gameWhitelist = input.gameWhitelist === undefined ? [] : input.gameWhitelist;
  if (!Array.isArray(gameWhitelist) || gameWhitelist.some((game) => typeof game !== 'string' || !game.trim() || game.length > 100)) errors.gameWhitelist = 'Use a list of game names.';
  const hashtags = normalizeHashtags(input.hashtags === undefined ? [] : input.hashtags);
  if (!hashtags) errors.hashtags = 'Use up to 30 hashtags with letters, numbers, or underscores.';
  const trackedLinks = input.trackedLinks || {};
  for (const pillar of ['topup', 'account']) {
    if (!trackedLinks[pillar]) continue;
    try {
      const url = new URL(trackedLinks[pillar]);
      if (typeof trackedLinks[pillar] !== 'string' || trackedLinks[pillar].length > 300 || url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid link');
    } catch { errors[`trackedLinks.${pillar}`] = 'Use an HTTPS tracked homepage link.'; }
  }
  const brand = {};
  const brandTextLimits = { name: 2000, voice: 2000, audienceNotes: 7000, contentDirection: 7000 };
  for (const field of ['name', 'voice', 'audienceNotes', 'contentDirection']) {
    const value = input.brand?.[field];
    const maxLength = brandTextLimits[field];
    if (value !== undefined && (typeof value !== 'string' || value.length > maxLength)) {
      errors[`brand.${field}`] = `Use text up to ${maxLength} characters.`;
    } else {
      brand[field] = value?.trim() || '';
    }
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
    schedule, priceMode, gameWhitelist: [...new Set(gameWhitelist.map((game) => game.trim()))], hashtags,
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
  const safeField = isSafeApprovedField;
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
    const safeAttributes = Array.isArray(fact.attributes)
      ? fact.attributes.slice(0, MAX_APPROVED_ATTRIBUTE_COUNT).filter(isSafeApprovedAttribute) : [];
    details.push(...safeAttributes);
  }
  const factBearing = details.length > 0;
  return {
    valid: true,
    text: `${pillar === 'topup' ? 'Top-up' : 'Akaun'} ${game}${factBearing ? ': ' + details.join('; ') : ''}.`,
    factBearing, factIds: factBearing && fact.id !== undefined ? [fact.id] : [],
  };
}

function isSafeApprovedField(value) {
  return typeof value === 'string' && value.trim() && value.length <= 200
    && /^[\p{L}\p{N} ,.'()+/-]+$/u.test(value) && !/[\p{L}\p{N}-]+\.[\p{L}]{2,}/u.test(value);
}

function isSafeApprovedAttribute(value) {
  return typeof value === 'string' && value.length <= MAX_APPROVED_ATTRIBUTE_LENGTH && isSafeApprovedField(value);
}

function postTimestamp(post) {
  for (const value of [post?.completedAt, post?.scheduledAt, post?.createdAt]) {
    const timestamp = Date.parse(value || '');
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return NaN;
}

function extractRecentHooks(history = []) {
  if (!Array.isArray(history)) return [];
  return history
    .map((post, index) => ({
      post,
      index,
      timestamp: postTimestamp(post),
    }))
    .filter(({ post }) => post?.status === 'published' && typeof post.caption === 'string')
    .sort((left, right) => {
      const leftTime = Number.isFinite(left.timestamp) ? left.timestamp : -Infinity;
      const rightTime = Number.isFinite(right.timestamp) ? right.timestamp : -Infinity;
      return rightTime - leftTime || left.index - right.index;
    })
    .map(({ post }) => {
      const lines = post.caption.split(/\r?\n/u);
      const productIndex = lines.findIndex((line) => /^(?:Top-up|Akaun)\s/u.test(line));
      if (productIndex < 0) return '';
      return lines.slice(0, productIndex).join(' ')
        .replace(HASHTAG_PATTERN, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
    })
    .filter(Boolean)
    .slice(0, 5);
}

function stronglyOverlapsHook(hook, recentHooks) {
  const words = hook.normalize('NFKC').toLowerCase().match(/[a-z]+/gu) || [];
  if (!words.length) return false;
  const normalizedHook = words.join(' ');
  return recentHooks.some((recentHook) => {
    if (typeof recentHook !== 'string') return false;
    const recentWords = recentHook.normalize('NFKC').toLowerCase().match(/[a-z]+/gu) || [];
    if (!recentWords.length) return false;
    if (normalizedHook === recentWords.join(' ')) return true;
    const uniqueWords = new Set(words);
    const uniqueRecentWords = new Set(recentWords);
    if (uniqueWords.size < 6 || uniqueRecentWords.size < 6) return false;
    const shared = [...uniqueWords].filter((word) => uniqueRecentWords.has(word)).length;
    return shared / Math.min(uniqueWords.size, uniqueRecentWords.size) >= 0.75;
  });
}

function validateCaption(text, context = {}) {
  const errors = [];
  if (typeof text !== 'string' || !text.trim()) return { valid: false, errors: ['EMPTY_CAPTION'] };
  if ([...text].length > 500) errors.push('CAPTION_TOO_LONG');
  const allowedHashtags = normalizeHashtags(context.hashtags ?? []);
  if (!allowedHashtags) errors.push('INVALID_HASHTAGS');
  const allowedKeys = new Set((allowedHashtags || []).map(hashtagKey));
  const link = typeof context.trackedLink === 'string' ? context.trackedLink : '';
  const captionParts = splitAroundText(text, link);
  const hashMatches = [...captionParts.before.normalize('NFKC').matchAll(HASHTAG_PATTERN), ...captionParts.after.normalize('NFKC').matchAll(HASHTAG_PATTERN)];
  for (const match of hashMatches) {
    if (!allowedKeys.has(hashtagKey(match[1]))) errors.push('UNAPPROVED_HASHTAG');
  }
  const normalized = text.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').toLowerCase();
  for (const claim of context.forbiddenClaims || []) {
    if (typeof claim === 'string' && claim.trim() && normalized.includes(claim.normalize('NFKC').toLowerCase().trim())) errors.push('FORBIDDEN_CLAIM');
  }
  captionParts.before = captionParts.before.replace(HASHTAG_PATTERN, '');
  captionParts.after = captionParts.after.replace(HASHTAG_PATTERN, '');
  const withoutHashtags = joinAroundText(captionParts).replace(/\s+$/u, '');
  let hook = withoutHashtags;
  if (context.trackedLink) {
    const approved = composeApprovedContent(context);
    if (!approved.valid) return { valid: false, errors: [...errors, ...approved.errors] };
    const suffix = `\n${approved.text}\n${context.trackedLink}`;
    if (!withoutHashtags.endsWith(suffix)) return { valid: false, errors: [...errors, 'UNAPPROVED_FACT_OR_LINK'] };
    hook = withoutHashtags.slice(0, -suffix.length);
  }
  const normalizedHook = hook.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').toLowerCase();
  if (!normalizedHook.trim()) errors.push('EMPTY_HOOK');
  if (/[:/@\\]|[\p{L}\p{N}-]+\.[\p{L}]{2,}/u.test(normalizedHook)) errors.push('UNAPPROVED_LINK');
  if (/\p{N}|[$€£¥]/u.test(normalizedHook)) errors.push('UNAPPROVED_QUANTITY_OR_CURRENCY');
  if (!/^[a-z\s!?,.'’-]+$/.test(normalizedHook)) errors.push('INVALID_HOOK_CHARACTERS');
  if (Array.isArray(context.recentHooks) && stronglyOverlapsHook(normalizedHook, context.recentHooks)) errors.push('REPETITIVE_HOOK');
  const words = normalizedHook.match(/[a-z]+/g) || [];
  if (words.some((word) => !HOOK_WORDS.includes(word))) errors.push('UNAPPROVED_HOOK_WORD');
  if (!words.some((word) => ['jom', 'jomlah', 'apa', 'apakah', 'bagaimana', 'kenapa', 'kongsi', 'anda', 'korang'].includes(word))) errors.push('MALAY_ENGAGEMENT_REQUIRED');
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

module.exports = { validateSettings, isInActiveWindow, isFactFresh, validateCaption, composeApprovedContent, appendHashtags, normalizeHashtags, extractRecentHooks, isSafeApprovedField, isSafeApprovedAttribute, MAX_APPROVED_ATTRIBUTE_COUNT, HOOK_WORDS };
