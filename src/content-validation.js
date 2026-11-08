'use strict';

const { normalizeHashtags } = require('./policy');

const TAG = /(?<![\p{L}\p{N}_])[#＃]+([\p{L}\p{N}_]+)/gu;
const URL = /(?:https?:\/\/|www\.)[^\s<>]+|\b[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.[\p{L}]{2,}(?:\/[^\s<>]*)?/giu;

function words(text) {
  return text.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(URL, ' ').replace(TAG, ' ').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}

function repetitive(text, recentCaptions) {
  const current = words(text);
  if (!current.length) return false;
  return recentCaptions.some((caption) => {
    if (typeof caption !== 'string') return false;
    const prior = words(caption);
    if (current.join(' ') === prior.join(' ')) return true;
    const negative = new Set(['tidak', 'tak', 'bukan', 'jangan', 'never', 'not']);
    if (current.some((word) => negative.has(word)) !== prior.some((word) => negative.has(word))) return false;
    const a = new Set(current);
    const b = new Set(prior);
    if (a.size < 8 || b.size < 8) return false;
    const common = [...a].filter((word) => b.has(word)).length;
    if (common / (a.size + b.size - common) < 0.8) return false;
    const pairs = (items) => new Set(items.slice(1).map((word, index) => `${items[index]}\u0000${word}`));
    const currentPairs = pairs(current);
    const priorPairs = pairs(prior);
    const commonPairs = [...currentPairs].filter((pair) => priorPairs.has(pair)).length;
    return commonPairs / Math.max(currentPairs.size, priorPairs.size) >= 0.65;
  });
}

// Deterministic checks complement the independent semantic review; they do not
// establish that every claim in natural language is supported.
function validateFullCaption(text, context = {}) {
  if (typeof text !== 'string' || !text.trim()) return { valid: false, errors: ['EMPTY_CAPTION'] };
  const errors = [];
  if ([...text].length > 500) errors.push('CAPTION_TOO_LONG');
  const normalized = text.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '');
  const lower = normalized.toLowerCase();
  for (const claim of context.forbiddenClaims || []) {
    if (typeof claim === 'string' && claim.trim() && lower.includes(claim.normalize('NFKC').toLowerCase().trim())) errors.push('FORBIDDEN_CLAIM');
  }
  const hashtags = normalizeHashtags(context.hashtags ?? []);
  if (!hashtags) errors.push('INVALID_HASHTAGS');
  const allowed = new Set((hashtags || []).map((tag) => tag.slice(1).toLowerCase()));
  let checked = normalized;
  const trackedLink = typeof context.trackedLink === 'string' ? context.trackedLink : '';
  if (/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/iu.test(checked)) errors.push('POSSIBLE_PERSONAL_INFORMATION');
  // Match whole URLs: removing a trusted prefix first would allow a malicious suffix.
  let approvedLinkCount = 0;
  checked = checked.replace(URL, (match) => {
    const url = match.replace(/[.,!?;:)]+$/u, '');
    if (trackedLink && url === trackedLink.normalize('NFKC')) approvedLinkCount++;
    else errors.push('UNAPPROVED_LINK');
    return ' ';
  });
  if (approvedLinkCount > 1) errors.push('DUPLICATE_LINK');
  if (context.requireConfigured && approvedLinkCount !== 1) errors.push('MISSING_REQUIRED_LINK');
  const seenTags = new Set();
  for (const match of checked.matchAll(TAG)) {
    const key = match[1].normalize('NFKC').toLowerCase();
    if (!allowed.has(key)) errors.push('UNAPPROVED_HASHTAG');
    seenTags.add(key);
  }
  if (context.requireConfigured && (!allowed.size || [...allowed].some((tag) => !seenTags.has(tag)))) errors.push('MISSING_REQUIRED_HASHTAGS');
  checked = checked.replace(TAG, ' ');
  if (/(?:\+?\d[\d ()-]{7,}\d)/u.test(checked)) errors.push('POSSIBLE_PERSONAL_INFORMATION');
  // Numerals must appear in an eligible fact. Semantic verification additionally
  // checks their meaning and association with the correct product.
  const numbers = checked.match(/\p{N}+(?:[.,]\p{N}+)?/gu) || [];
  const permittedValues = (Array.isArray(context.facts) ? context.facts : []).flatMap((fact) =>
    [fact.game, fact.price, fact.denomination, fact.availability, ...(Array.isArray(fact.attributes) ? fact.attributes : [])]);
  permittedValues.push(...(Array.isArray(context.gameWhitelist) ? context.gameWhitelist : []));
  const sourceNumbers = permittedValues.join(' ').normalize('NFKC').match(/\p{N}+(?:[.,]\p{N}+)?/gu) || [];
  if (numbers.some((number) => !sourceNumbers.includes(number))) errors.push('UNAPPROVED_NUMBER');
  // Detect common direct price statements missing a currency. Other phrasings
  // still require semantic review to determine whether a number is a price.
  const directPrices = checked.matchAll(/\b(?:harga|price|kos|cost|bayaran|berharga)\s*(?:(?:ialah|adalah|sekitar|cuma|hanya|bermula|dari)\s*)?[:=]?\s*\d+(?:[.,]\d+)?(?![\d.,])(?:\s*(?:myr|rm)\b)?/giu);
  if ([...directPrices].some((match) => !/\b(?:myr|rm)\b/iu.test(match[0]))) errors.push('PRICE_MISSING_CURRENCY');
  if (/[$€£¥]/u.test(checked)) errors.push('UNAPPROVED_CURRENCY');
  if (repetitive(normalized, Array.isArray(context.recentCaptions) ? context.recentCaptions : [])) errors.push('REPETITIVE_CAPTION');
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

module.exports = { validateFullCaption };
