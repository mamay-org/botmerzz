'use strict';

// These pure contracts consume explicitly selected populations. They are not
// connected to historical data, whose attempt provenance is incomplete.
const DIMENSIONS = ['hook', 'creativity', 'language', 'relevance', 'brandVoice', 'clarity', 'diversity', 'cta'];

function complianceSummary(attempts) {
  const slots = new Map();
  for (const row of attempts) {
    if (!row || typeof row.slotId !== 'string' || !row.slotId || !Number.isInteger(row.attempt) || row.attempt < 1) continue;
    if (!slots.has(row.slotId)) slots.set(row.slotId, new Set());
    if (row.attempt === 1) slots.get(row.slotId).add(['pass', 'fail', 'technical'].includes(row.outcome) ? row.outcome : 'unknown');
  }
  const result = { passed: 0, eligible: 0, unknown: 0, technical: 0, missingFirst: 0, conflicts: 0, rate: null };
  for (const outcomes of slots.values()) {
    if (!outcomes.size) result.missingFirst++;
    else if (outcomes.size > 1) result.conflicts++;
    else {
      const outcome = [...outcomes][0];
      if (outcome === 'pass' || outcome === 'fail') { result.eligible++; if (outcome === 'pass') result.passed++; }
      else result[outcome]++;
    }
  }
  if (result.eligible) result.rate = result.passed / result.eligible;
  return result;
}

function qualitySummary(captionIds, reviews) {
  const eligible = new Set(captionIds.filter((id) => typeof id === 'string' && id));
  const grouped = new Map();
  for (const review of reviews) {
    if (!review || !eligible.has(review.captionId) || typeof review.reviewerId !== 'string' || !review.reviewerId) continue;
    const key = JSON.stringify([review.captionId, review.reviewerId]);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(review);
  }
  const dimensions = Object.fromEntries(DIMENSIONS.map((key) => [key, { sum: 0, count: 0, average: null }]));
  let duplicateReviews = 0; let invalidRatings = 0;
  const reviewed = new Set();
  for (const records of grouped.values()) {
    if (records.length !== 1) { duplicateReviews++; continue; }
    const { captionId, ratings } = records[0];
    if (!ratings || typeof ratings !== 'object' || Array.isArray(ratings)) { invalidRatings++; continue; }
    let hasRating = false;
    for (const [key, value] of Object.entries(ratings)) {
      if (!DIMENSIONS.includes(key) || !Number.isInteger(value) || value < 1 || value > 5) { invalidRatings++; continue; }
      dimensions[key].sum += value; dimensions[key].count++; hasRating = true;
    }
    if (hasRating) reviewed.add(captionId);
  }
  for (const item of Object.values(dimensions)) if (item.count) item.average = item.sum / item.count;
  return { eligibleCaptions: eligible.size, reviewedCaptions: reviewed.size, coverage: eligible.size ? reviewed.size / eligible.size : null, dimensions, duplicateReviews, invalidRatings };
}

// expectedSlotIds must come from an independently established population, not
// from the telemetry being evaluated. Without it, coverage is unknown.
function firstPassReport(attempts, expectedSlotIds) {
  const expected = Array.isArray(expectedSlotIds) ? new Set(expectedSlotIds.filter((id) => typeof id === 'string' && id)) : null;
  const selected = expected ? attempts.filter((row) => expected.has(row?.slotId)) : attempts;
  const identities = new Map();
  for (const row of selected) if (row?.attempt === 1 && typeof row.slotId === 'string' && row.canonical === true && typeof row.attemptId === 'string' && row.attemptId) {
    if (!identities.has(row.slotId)) identities.set(row.slotId, new Set());
    identities.get(row.slotId).add(row.attemptId);
  }
  const identityConflicts = new Set([...identities].filter(([, ids]) => ids.size > 1).map(([slot]) => slot));
  const trusted = selected.filter((row) => row?.attempt !== 1 || (row.canonical === true && typeof row.attemptId === 'string' && row.attemptId));
  const summary = complianceSummary(trusted.filter((row) => !identityConflicts.has(row.slotId)));
  summary.conflicts += identityConflicts.size;
  const present = new Set(trusted.filter((row) => row && typeof row.slotId === 'string' && row.attempt === 1 && !identityConflicts.has(row.slotId)).map((row) => row.slotId));
  const missingCanonical = expected ? [...expected].filter((id) => !present.has(id)).length : null;
  const observed = summary.eligible + summary.unknown + summary.technical;
  const coverage = expected?.size ? observed / expected.size : null;
  const interpretation = summary.rate === null ? 'unavailable'
    : coverage === 1 && summary.unknown === 0 && summary.conflicts === 0 ? 'available' : 'provisional';
  return { definitionVersion: 'compliance-v1', ...summary, contextualFailed: summary.eligible - summary.passed,
    expectedFirstAttempts: expected ? expected.size : null, missingCanonical, coverage, interpretation };
}
module.exports = { complianceSummary, qualitySummary, firstPassReport };
