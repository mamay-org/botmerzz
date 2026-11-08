'use strict';

const { isFactFresh, isSafeApprovedField, isSafeApprovedAttribute, MAX_APPROVED_ATTRIBUTE_COUNT } = require('./policy');

// Theme inference is intentionally approximate: historical slots contain no
// creative metadata. Suggestions are advisory and never authorize claims.
const THEMES = [
  { name: 'edukasi', pattern: /\b(?:belajar|tips|panduan|fahami|faham|semak|risiko|sebelum)\b/iu },
  { name: 'diskusi komuniti', pattern: /\b(?:pendapat|komuniti|bincang|kongsi)\b/iu },
  { name: 'pemerhatian gamer', pattern: /\b(?:biasanya|selalu|kebiasaan|tabiat|pemain)\b/iu },
  { name: 'situasi gaming relatable', pattern: /\b(?:pernah|situasi|tiba-tiba|sekali|bila)\b/iu },
  { name: 'kesedaran jenama', pattern: /\b(?:jenama|brand|kedai|perkhidmatan)\b/iu },
  { name: 'membina kepercayaan', pattern: /\b(?:percaya|keyakinan|telus|transaksi|keselamatan)\b/iu },
];

function suggestCreativeDirection(history) {
  const recent = history.filter((post) => typeof post.caption === 'string' && post.caption.trim())
    .sort((a, b) => (Date.parse(b.completedAt || b.scheduledAt || b.createdAt) || 0) - (Date.parse(a.completedAt || a.scheduledAt || a.createdAt) || 0))
    .slice(0, 20);
  const counts = THEMES.map(({ pattern }) => recent.reduce((n, post) => {
    const narrative = post.caption.replace(/https?:\/\/\S+/giu, ' ').replace(/#[\p{L}\p{N}_]+/gu, ' ');
    return n + (pattern.test(narrative) ? 1 : 0);
  }, 0));
  const lowest = Math.min(...counts);
  // Use the latest published slot as a stable tie-breaker. A count would stop
  // changing once the repository's rolling history limit is reached.
  const latest = recent[0];
  const identity = String(latest?.id || latest?.completedAt || latest?.scheduledAt || latest?.createdAt || latest?.caption || '');
  let hash = 0;
  for (const char of identity) hash = (Math.imul(hash, 31) + char.codePointAt(0)) >>> 0;
  const offset = hash % THEMES.length;
  const index = Array.from({ length: THEMES.length }, (_, i) => (i + offset) % THEMES.length)
    .find((candidate) => counts[candidate] === lowest);
  return { suggestedTheme: THEMES[index].name };
}

function buildContentContext(context, settings) {
  const history = (context.history || []).filter((post) => post.status === 'published');
  const pillar = history.filter((post) => post.pillar === 'topup').length <= history.filter((post) => post.pillar === 'account').length ? 'topup' : 'account';
  const factCount = history.filter((post) => post.factBearing).length;
  const useFacts = settings.guardrails.approved && (settings.priceMode === 'ON'
    || (settings.priceMode === 'MIXED' && factCount < Math.floor((history.length + 1) / 4)));
  const facts = useFacts ? (context.facts || []).filter((fact) => fact && (typeof fact.id === 'string' && fact.id.trim() || typeof fact.id === 'number' && Number.isFinite(fact.id)) && fact.pillar === pillar && isFactFresh(fact, context.now)
    && settings.gameWhitelist.includes(fact.game) && (pillar !== 'account' || fact.game === 'Mobile Legends'))
    .map((fact) => {
      const clean = { id: fact.id, pillar: fact.pillar, game: fact.game, updatedAt: new Date(fact.updatedAt).toISOString() };
      for (const key of ['denomination', 'availability']) if (isSafeApprovedField(fact[key])) clean[key] = fact[key];
      if (fact.price !== undefined && /^\d+(?:\.\d{1,2})?$/.test(String(fact.price)) && Number.isFinite(Number(fact.price))) {
        clean.price = String(fact.price);
        clean.currency = 'MYR';
      }
      if (Array.isArray(fact.attributes)) clean.attributes = fact.attributes.slice(0, MAX_APPROVED_ATTRIBUTE_COUNT).filter(isSafeApprovedAttribute);
      return clean;
    }) : [];
  const recentCaptions = history.filter((post) => typeof post.caption === 'string' && post.caption.trim())
    .sort((a, b) => (Date.parse(b.completedAt || b.scheduledAt || b.createdAt) || 0) - (Date.parse(a.completedAt || a.scheduledAt || a.createdAt) || 0))
    .slice(0, 5).map((post) => post.caption);
  return {
    pillar, brand: settings.brand, gameWhitelist: settings.gameWhitelist, facts,
    approvedClaims: [],
    forbiddenClaims: settings.guardrails.forbiddenClaims, hookVocabulary: settings.guardrails.hookVocabulary,
    hashtags: settings.hashtags, trackedLink: settings.trackedLinks[pillar] || '', recentCaptions,
    creativeDirection: suggestCreativeDirection(history),
  };
}

module.exports = { buildContentContext };
