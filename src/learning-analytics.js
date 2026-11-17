'use strict';

const DIMENSIONS = ['hook','creativity','language','relevance','brandVoice','clarity','diversity','cta'];
const MIN_QUALITY_CAPTIONS = 5;
const MIN_EFFECTIVENESS_PER_ARM = 10;
const MAX_WINDOW_DAYS = 365;
const MAX_ROWS = 20_000;

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function dbId(value) {
  if (value == null) return null;
  return String(value);
}

function dbBoolean(value) {
  return value === true || value === 1 || value === '1';
}

function dateValue(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function normalizeWindow({from,to} = {}, now = new Date()) {
  const end = to == null ? new Date(now) : dateValue(to);
  if (!end) throw Object.assign(new Error('INVALID_ANALYTICS_WINDOW'),{code:'INVALID_ANALYTICS_WINDOW',status:400});
  const start = from == null ? new Date(end.getTime() - 30 * 86400000) : dateValue(from);
  if (!start || !end || start >= end || end - start > MAX_WINDOW_DAYS * 86400000) {
    throw Object.assign(new Error('INVALID_ANALYTICS_WINDOW'),{code:'INVALID_ANALYTICS_WINDOW',status:400});
  }
  return {from:start,to:end};
}

function normalizeRatings(value) {
  const ratings = parseJson(value,{});
  if (!ratings || typeof ratings !== 'object' || Array.isArray(ratings)) return {};
  return Object.fromEntries(Object.entries(ratings).filter(([key,rating]) => DIMENSIONS.includes(key)
    && Number.isInteger(rating) && rating >= 1 && rating <= 5));
}

function qualitySummary(eligibleCaptionIds, feedbackRows, {minimumCaptions = MIN_QUALITY_CAPTIONS, truncated = false} = {}) {
  const eligible = new Set(eligibleCaptionIds.map(dbId).filter(Boolean));
  const rows = feedbackRows.filter((row) => eligible.has(dbId(row.slotId)));
  const reviewed = new Set(rows.map((row) => dbId(row.slotId)));
  const ratings = Object.fromEntries(DIMENSIONS.map((dimension) => [dimension,{sum:0,count:0,captions:new Set(),average:null,smallSample:true}]));
  const positive = rows.filter((row) => row.feedbackType === 'positive').length;
  const negative = rows.filter((row) => row.feedbackType === 'negative').length;
  let unratedFeedback = 0;
  for (const row of rows) {
    const parsed = normalizeRatings(row.ratings);
    if (!Object.keys(parsed).length) unratedFeedback++;
    for (const [dimension,value] of Object.entries(parsed)) {
      ratings[dimension].sum += value;
      ratings[dimension].count++;
      ratings[dimension].captions.add(dbId(row.slotId));
    }
  }
  for (const metric of Object.values(ratings)) {
    if (metric.count) metric.average = metric.sum / metric.count;
    metric.captionSampleSize = metric.captions.size;
    metric.smallSample = metric.captionSampleSize < minimumCaptions;
    delete metric.captions;
  }
  const enough = reviewed.size >= minimumCaptions && !truncated;
  return {
    status: enough ? 'available' : 'insufficient_data',
    statusText: enough ? 'Data tersedia' : 'Belum cukup data',
    eligibleCaptions: eligible.size,
    reviewedCaptions: reviewed.size,
    unreviewedCaptions: Math.max(0,eligible.size - reviewed.size),
    feedbackSubmissions: rows.length,
    unratedFeedback,
    feedbackCoverage: eligible.size ? reviewed.size / eligible.size : null,
    positiveFeedbackSubmissions: positive,
    negativeFeedbackSubmissions: negative,
    positiveFeedbackShare: rows.length ? positive / rows.length : null,
    negativeFeedbackShare: rows.length ? negative / rows.length : null,
    dimensions: ratings,
    minimumCaptions,
    smallSample: !enough,
    truncated,
  };
}

function qualityTrends(eligibleRows, feedbackRows) {
  const months = new Map();
  const eligibleMonths = new Map();
  for (const row of eligibleRows) {
    const id = dbId(row.id ?? row.slotId);
    const completed = dateValue(row.completedAt ?? row.completed_at);
    if (!id || !completed) continue;
    const month = completed.toISOString().slice(0,7);
    eligibleMonths.set(id,month);
    if (!months.has(month)) months.set(month,{month,eligible:0,reviewed:new Set(),submissions:0,positive:0,negative:0,dimensions:Object.fromEntries(DIMENSIONS.map((key)=>[key,{sum:0,count:0,captions:new Set()}]))});
    months.get(month).eligible++;
  }
  for (const row of feedbackRows) {
    const id = dbId(row.slotId ?? row.slot_id);
    const month = eligibleMonths.get(id);
    if (!month) continue;
    const item = months.get(month);
    item.reviewed.add(id);
    item.submissions++;
    if ((row.feedbackType ?? row.feedback_type) === 'positive') item.positive++;
    if ((row.feedbackType ?? row.feedback_type) === 'negative') item.negative++;
    for (const [key,value] of Object.entries(normalizeRatings(row.ratings ?? row.ratings_json))) {
      item.dimensions[key].sum += value;
      item.dimensions[key].count++;
      item.dimensions[key].captions.add(id);
    }
  }
  return [...months.values()].sort((a,b)=>a.month.localeCompare(b.month)).map((item)=>({
    month:item.month,eligibleCaptions:item.eligible,reviewedCaptions:item.reviewed.size,
    feedbackCoverage:item.eligible?item.reviewed.size/item.eligible:null,feedbackSubmissions:item.submissions,
    positiveFeedbackSubmissions:item.positive,negativeFeedbackSubmissions:item.negative,
    dimensionAverages:Object.fromEntries(Object.entries(item.dimensions).map(([key,value])=>[key,{count:value.count,captionSampleSize:value.captions.size,average:value.count?value.sum/value.count:null}])),
  }));
}

function parseAppliedRules(value) {
  const list = parseJson(value,[]);
  if (!Array.isArray(list)) return [];
  return list.filter((item) => item && /^[1-9]\d{0,19}$/.test(dbId(item.id) || '')
    && Number.isSafeInteger(Number(item.version)) && Number(item.version) > 0)
    .map((item) => ({id:dbId(item.id),version:Number(item.version)}));
}

function summarizeAttempts(rows, targetFailureCode = null) {
  const summary = {sampleSize:rows.length,evaluatedSampleSize:0,passed:0,contextualFailed:0,technicalExcluded:0,unknown:0,incomplete:0,contextualFailureRate:null,failureCategories:{}};
  const known = new Set(['passed','contextual_failed','technical_failed','unknown']);
  let relevantFailureCount=0;
  for (const row of rows) {
    const state = row.state;
    if (state === 'passed') summary.passed++;
    else if (state === 'contextual_failed') summary.contextualFailed++;
    else if (state === 'technical_failed') summary.technicalExcluded++;
    else if (state === 'unknown') summary.unknown++;
    else summary.incomplete++;
    if (state === 'contextual_failed') {
      const codes=new Set(parseJson(row.failure_codes,[]).filter((item) => typeof item === 'string' && /^[A-Z0-9_]{2,64}$/.test(item)));
      for (const code of codes) {
        summary.failureCategories[code] = (summary.failureCategories[code] || 0) + 1;
      }
      if (targetFailureCode && codes.has(targetFailureCode)) relevantFailureCount++;
    }
  }
  const eligible = summary.passed + summary.contextualFailed;
  summary.evaluatedSampleSize = eligible;
  if (eligible) summary.contextualFailureRate = summary.contextualFailed / eligible;
  summary.relevantFailureCategory=targetFailureCode || null;
  summary.relevantFailureCount=targetFailureCode ? relevantFailureCount : null;
  summary.relevantFailureRate=targetFailureCode && eligible ? relevantFailureCount/eligible : null;
  summary.outcomeCoverage = rows.length ? [...known].reduce((sum,state) => sum + rows.filter((row) => row.state === state).length,0) / rows.length : null;
  return summary;
}

function effectivenessSummary({rules,actions,snapshots,attempts,feedbackRows,from,to,truncated = false,missingSnapshots = 0}) {
  const actionRows = actions.map((row) => ({...row,ruleId:dbId(row.rule_id ?? row.ruleId),version:Number(row.version),action:row.action,details:parseJson(row.details_json ?? row.details,{}),at:dateValue(row.created_at ?? row.createdAt)}))
    .filter((row) => row.ruleId && Number.isSafeInteger(row.version) && row.version > 0 && row.at);
  const ruleMap = new Map(rules.map((row) => [`${dbId(row.rule_id ?? row.ruleId)}:${Number(row.version)}`,row]));
  const periods = [];
  const openPeriods = new Map();
  for (const action of actionRows.sort((a,b) => a.at-b.at)) {
    if (['activated','rolled_back'].includes(action.action)) {
      const previous = openPeriods.get(action.ruleId);
      const previousVersion = Number(action.details?.previousVersion ?? action.details?.fromVersion);
      if (previous) previous.deactivatedAt = action.at;
      const period = {ruleId:action.ruleId,version:action.version,previousVersion:Number.isSafeInteger(previousVersion) && previousVersion > 0 ? previousVersion : null,activatedAt:action.at,deactivatedAt:null};
      periods.push(period);
      openPeriods.set(action.ruleId,period);
    } else if (['deactivated','superseded'].includes(action.action)) {
      const active = openPeriods.get(action.ruleId);
      if (active && active.version === action.version) {
        active.deactivatedAt = action.at;
        openPeriods.delete(action.ruleId);
      }
    }
  }
  const fromDate = dateValue(from); const toDate = dateValue(to);
  const snapshotRows = snapshots.map((row) => ({
    ...row,attemptId:dbId(row.attempt_id ?? row.attemptId),slotId:dbId(row.slot_id ?? row.slotId),
    modelId:row.model_id ?? row.modelId,configurationVersion:row.configuration_version ?? row.configurationVersion,
    productCategory:row.product_category ?? row.productCategory ?? 'all',contentTopic:row.content_topic ?? row.contentTopic ?? 'all',
    factsVersion:parseJson(row.facts_version_json ?? row.factsVersion,[]),
    promptIntegrationEnabled:dbBoolean(row.prompt_integration_enabled ?? row.promptIntegrationEnabled),
    appliedRules:parseAppliedRules(row.applied_rules_json ?? row.appliedRules),at:dateValue(row.created_at ?? row.createdAt),
    retrievalContext:parseJson(row.retrieval_context_json ?? row.retrievalContext,{}),
  })).filter((row) => row.at && row.at < toDate);
  const attemptMap = new Map(attempts.map((row) => [dbId(row.attempt_id ?? row.attemptId),row]));
  const slotFeedback = new Map();
  for (const row of feedbackRows) {
    const key = dbId(row.slot_id ?? row.slotId);
    if (!slotFeedback.has(key)) slotFeedback.set(key,[]);
    slotFeedback.get(key).push(row);
  }

  const comparisons = [];
  for (const period of periods) {
    if (!period.activatedAt || period.activatedAt >= toDate) continue;
    const key = `${period.ruleId}:${period.version}`;
    const rule = ruleMap.get(key);
    if (!rule) continue;
    const ruleId = key.split(':')[0]; const version = Number(key.split(':')[1]);
    const productCategory = rule.product_category ?? rule.productCategory ?? 'all';
    const contentTopic = rule.content_topic ?? rule.contentTopic ?? 'all';
    const postStart = new Date(Math.max(fromDate.getTime(),period.activatedAt.getTime()));
    const postEnd = period.deactivatedAt && period.deactivatedAt < toDate ? period.deactivatedAt : toDate;
    const baselineStart = new Date(period.activatedAt.getTime() - 30 * 86400000);
    const matchingContext = (row) => (productCategory === 'all' || row.productCategory === productCategory)
      && (contentTopic === 'all' || row.contentTopic === contentTopic);
    const postRows = snapshotRows.filter((row) => row.at >= postStart && row.at < postEnd && row.promptIntegrationEnabled && matchingContext(row)
      && row.appliedRules.some((applied) => applied.id === ruleId && applied.version === version));
    const postModelConfigs = new Set(postRows.map((row) => JSON.stringify([row.modelId,row.configurationVersion])));
    const baselineRows = snapshotRows.filter((row) => row.at >= baselineStart && row.at < period.activatedAt && matchingContext(row)
      && row.appliedRules.length === 0 && postModelConfigs.has(JSON.stringify([row.modelId,row.configurationVersion])));
    const firstAttemptRows = (selected) => selected.map((snapshot) => ({snapshot,attempt:attemptMap.get(snapshot.attemptId)}))
      .filter((entry) => entry.attempt && Number(entry.attempt.ordinal) === 1);
    const baselineEntries = firstAttemptRows(baselineRows); const postEntries = firstAttemptRows(postRows);
    const relevantFailureCategory = rule.failure_code ?? rule.failureCode ?? null;
    const baselineMetrics = summarizeAttempts(baselineEntries.map((entry) => entry.attempt),relevantFailureCategory);
    const postMetrics = summarizeAttempts(postEntries.map((entry) => entry.attempt),relevantFailureCategory);
    const baselineModelConfigs = new Set(baselineRows.map((row) => JSON.stringify([row.modelId,row.configurationVersion])));
    const coApplied = new Map();
    for (const row of postRows) for (const applied of row.appliedRules) {
      if (applied.id === ruleId && applied.version === version) continue;
      const coKey = `${applied.id}:${applied.version}`;
      coApplied.set(coKey,(coApplied.get(coKey) || 0) + 1);
    }
    const baselineFacts = new Set(baselineRows.map((row) => JSON.stringify(row.factsVersion)));
    const postFacts = new Set(postRows.map((row) => JSON.stringify(row.factsVersion)));
    const guidelineVersions = (rows) => new Set(rows.map((row) => {
      const context = row.retrievalContext || {};
      const legacyFingerprint = context.settingsFingerprint ?? null;
      return JSON.stringify([context.brandGuidelinesHash ?? context.brandGuidelinesVersion ?? legacyFingerprint,
        context.adminGuidelinesHash ?? context.adminGuidelinesVersion ?? legacyFingerprint]);
    }));
    const baselineGuidelines = guidelineVersions(baselineRows);
    const postGuidelines = guidelineVersions(postRows);
    const validationVersions = (rows) => new Set(rows.map((row) => row.retrievalContext?.validationContractVersion || 'unknown'));
    const baselineValidationVersions = validationVersions(baselineRows);
    const postValidationVersions = validationVersions(postRows);
    const validatorVersionMissing = baselineValidationVersions.has('unknown') || postValidationVersions.has('unknown');
    const validatorChanged = validatorVersionMissing || baselineValidationVersions.size !== 1 || postValidationVersions.size !== 1
      || [...baselineValidationVersions].some((item) => !postValidationVersions.has(item));
    const qualityFor = (entries) => {
      const published = entries.filter((entry) => (entry.snapshot.slotStatus ?? entry.snapshot.slot_status) === 'published');
      const reviews = published.flatMap((entry) => slotFeedback.get(entry.snapshot.slotId) || []).map((row) => ({
        ...row,slotId:dbId(row.slotId ?? row.slot_id),reviewerId:dbId(row.reviewerId ?? row.reviewer_id),
        feedbackType:row.feedbackType ?? row.feedback_type,ratings:row.ratings ?? row.ratings_json,
      }));
      return qualitySummary([...new Set(published.map((entry) => entry.snapshot.slotId))],reviews);
    };
    const baselineQuality = qualityFor(baselineEntries);
    const postQuality = qualityFor(postEntries);
    const enough = baselineMetrics.evaluatedSampleSize >= MIN_EFFECTIVENESS_PER_ARM && postMetrics.evaluatedSampleSize >= MIN_EFFECTIVENESS_PER_ARM && !truncated && !validatorChanged;
    comparisons.push({
      ruleId,version,previousVersion:period.previousVersion,productCategory,contentTopic,activatedAt:period.activatedAt.toISOString(),deactivatedAt:period.deactivatedAt?.toISOString() || null,
      baseline:{windowFrom:baselineStart.toISOString(),windowTo:period.activatedAt.toISOString(),attributedAttempts:baselineRows.length,firstAttemptOutcomeSampleSize:baselineMetrics.sampleSize,...baselineMetrics,quality:baselineQuality},
      observed:{windowFrom:postStart.toISOString(),windowTo:postEnd.toISOString(),attributedAttempts:postRows.length,firstAttemptOutcomeSampleSize:postMetrics.sampleSize,...postMetrics,quality:postQuality},
      failureRateDifference:baselineMetrics.contextualFailureRate == null || postMetrics.contextualFailureRate == null ? null : Number((postMetrics.contextualFailureRate-baselineMetrics.contextualFailureRate).toFixed(4)),
      relevantFailureCategory,
      relevantFailureRateDifference:baselineMetrics.relevantFailureRate == null || postMetrics.relevantFailureRate == null ? null : Number((postMetrics.relevantFailureRate-baselineMetrics.relevantFailureRate).toFixed(4)),
      coAppliedRules:[...coApplied].map(([identity,count]) => ({ruleId:identity.split(':')[0],version:Number(identity.split(':')[1]),generations:count})),
      confounders:{modelOrConfigChanged:baselineModelConfigs.size !== postModelConfigs.size || [...postModelConfigs].some((item) => !baselineModelConfigs.has(item)),modelConfigurations:{baseline:[...baselineModelConfigs].map((item)=>JSON.parse(item)),observed:[...postModelConfigs].map((item)=>JSON.parse(item))},factsChanged:baselineFacts.size !== postFacts.size || [...postFacts].some((item) => !baselineFacts.has(item)),factsVersionCounts:{baseline:baselineFacts.size,observed:postFacts.size},guidelinesChanged:baselineGuidelines.size !== postGuidelines.size || [...postGuidelines].some((item) => !baselineGuidelines.has(item)),guidelineVersions:{baseline:[...baselineGuidelines].map((item)=>JSON.parse(item)),observed:[...postGuidelines].map((item)=>JSON.parse(item))},coAppliedRules:coApplied.size>0,validatorChanged,validatorVersionMissing,validatorVersions:{baseline:[...baselineValidationVersions],observed:[...postValidationVersions]}},
      status:enough?'observational':'insufficient_data',statusText:enough?'Indikasi perlu semakan manusia':'Belum cukup data',minimumPerArm:MIN_EFFECTIVENESS_PER_ARM,
    });
  }
  return {definitionVersion:'effectiveness-v1',status:comparisons.some((item) => item.status === 'observational') ? 'observational' : 'insufficient_data',statusText:comparisons.some((item) => item.status === 'observational') ? 'Pemerhatian sahaja' : 'Belum cukup data',comparisonCount:comparisons.length,comparisons,missingSnapshots,truncated,causalClaim:false,from:fromDate.toISOString(),to:toDate.toISOString()};
}

function createLearningAnalytics(pool, {clock = () => new Date(), maxRows = MAX_ROWS} = {}) {
  const boundedRows = Math.max(100,Math.min(MAX_ROWS,Number(maxRows) || MAX_ROWS));

  async function compliance(window) {
    const range = normalizeWindow(window,clock());
    const [[population]] = await pool.execute('SELECT COUNT(*) AS eligible FROM generation_slot_claims WHERE claimed_at>=? AND claimed_at<?',[range.from,range.to]);
    const eligible = Number(population.eligible) || 0;
    const [rows] = await pool.execute(
      `SELECT c.slot_id AS slotId,a.attempt_id AS attemptId,a.state,a.deterministic_outcome AS deterministicOutcome,a.semantic_outcome AS semanticOutcome,a.failure_codes AS failureCodes,a.ordinal
       FROM generation_slot_claims c LEFT JOIN generation_attempts a ON a.slot_id=c.slot_id AND a.ordinal=1
       WHERE c.claimed_at>=? AND c.claimed_at<? ORDER BY c.claimed_at,c.slot_id LIMIT ?`,
      [range.from,range.to,boundedRows+1],
    );
    const truncated = rows.length > boundedRows;
    const firsts = rows.slice(0,boundedRows);
    const counts = {passed:0,contextualRejected:0,technicalExcluded:0,unknown:0,incomplete:0,missingAttempt:0};
    const deterministic = {passed:0,failed:0,technical:0,unknown:0,notRun:0};
    const semantic = {passed:0,failed:0,technical:0,unknown:0,notRun:0};
    const failureCategories = {};
    for (const row of firsts) {
      if (!row.attemptId) { counts.missingAttempt++; continue; }
      if (row.state === 'passed' && row.deterministicOutcome === 'PASSED' && row.semanticOutcome === 'PASSED') counts.passed++;
      else if (row.state === 'contextual_failed') counts.contextualRejected++;
      else if (row.state === 'technical_failed') counts.technicalExcluded++;
      else if (row.state === 'unknown') counts.unknown++;
      else counts.incomplete++;
      const detKey = ({PASSED:'passed',FAILED:'failed',TECHNICAL_FAILED:'technical',UNKNOWN:'unknown',NOT_RUN:'notRun'})[row.deterministicOutcome] || 'notRun';
      const semKey = ({PASSED:'passed',FAILED:'failed',TECHNICAL_FAILED:'technical',UNKNOWN:'unknown',NOT_RUN:'notRun'})[row.semanticOutcome] || 'notRun';
      deterministic[detKey]++; semantic[semKey]++;
      if (row.state === 'contextual_failed') for (const code of new Set(parseJson(row.failureCodes,[]).filter((item) => typeof item === 'string' && /^[A-Z0-9_]{2,64}$/.test(item)))) failureCategories[code] = (failureCategories[code] || 0) + 1;
    }
    const firstPassDenominator = truncated ? null : Math.max(0,eligible - counts.technicalExcluded);
    const primaryEvaluated = counts.passed + counts.contextualRejected;
    const complete = !truncated && counts.missingAttempt === 0 && counts.unknown === 0 && counts.incomplete === 0;
    const stageRate = (stage) => {
      const evaluated = stage.passed + stage.failed;
      return {passed:stage.passed,failed:stage.failed,technical:stage.technical,unknown:stage.unknown,notRun:stage.notRun,evaluated,passRate:evaluated && !truncated?stage.passed/evaluated:null};
    };
    return {
      definitionVersion:'compliance-v3',from:range.from.toISOString(),to:range.to.toISOString(),
      status:eligible < MIN_QUALITY_CAPTIONS?'insufficient_data':complete?'complete':'incomplete',
      statusText:eligible < MIN_QUALITY_CAPTIONS?'Belum cukup data':complete?'Data lengkap':'Data belum lengkap',
      eligibleFirstAttempts:eligible,evaluatedFirstAttempts:primaryEvaluated,firstPassDenominator,firstPassSuccesses:counts.passed,contextualFailures:counts.contextualRejected,
      firstPassApprovalRate:firstPassDenominator?counts.passed/firstPassDenominator:null,contextualRejectionRate:firstPassDenominator?counts.contextualRejected/firstPassDenominator:null,
      technicalExclusions:counts.technicalExcluded,unknownOutcomes:counts.unknown,incompleteOutcomes:counts.incomplete,missingAttempts:counts.missingAttempt,
      attemptRecordCoverage:eligible && !truncated?(eligible-counts.missingAttempt)/eligible:null,
      terminalOutcomeCoverage:eligible && !truncated?(counts.passed+counts.contextualRejected+counts.technicalExcluded+counts.unknown)/eligible:null,
      evaluatedOutcomeCoverage:eligible && !truncated?(counts.passed+counts.contextualRejected+counts.technicalExcluded)/eligible:null,
      deterministicStage:stageRate(deterministic),semanticStage:stageRate(semantic),failureCategories,
      technicalAndUnknownDisclosed:true,truncated,
    };
  }

  async function quality(window) {
    const range = normalizeWindow(window,clock());
    const [eligibleRows] = await pool.execute(
      "SELECT id,completed_at AS completedAt FROM slots WHERE status='published' AND caption IS NOT NULL AND completed_at>=? AND completed_at<? ORDER BY completed_at,id LIMIT ?",
      [range.from,range.to,boundedRows+1],
    );
    const eligible = eligibleRows.slice(0,boundedRows).map((row) => dbId(row.id));
    const [feedbackRows] = await pool.execute(
      'SELECT f.slot_id AS slotId,f.reviewer_id AS reviewerId,f.feedback_type AS feedbackType,f.ratings_json AS ratings,f.created_at AS createdAt,s.completed_at AS completedAt FROM learning_feedback f JOIN slots s ON s.id=f.slot_id WHERE s.status=\'published\' AND s.caption IS NOT NULL AND f.caption_hash=SHA2(s.caption,256) AND s.completed_at>=? AND s.completed_at<? ORDER BY f.created_at,f.id LIMIT ?',
      [range.from,range.to,boundedRows+1],
    );
    const truncated = eligibleRows.length > boundedRows || feedbackRows.length > boundedRows;
    const reviews = feedbackRows.slice(0,boundedRows).map((row) => ({...row,slotId:dbId(row.slotId),reviewerId:dbId(row.reviewerId)}));
    return {...qualitySummary(eligible,reviews,{truncated}),trends:qualityTrends(eligibleRows.slice(0,boundedRows),reviews),from:range.from.toISOString(),to:range.to.toISOString(),rubricVersion:'1'};
  }

  async function effectiveness(window) {
    const range = normalizeWindow(window,clock());
    const [actions] = await pool.execute(
      "SELECT id,rule_id,version,action,details_json,created_at FROM (SELECT id,rule_id,version,action,details_json,created_at FROM learning_rule_actions WHERE created_at<? ORDER BY created_at DESC,id DESC LIMIT ?) recent_actions ORDER BY created_at,id",
      [range.to,boundedRows+1],
    );
    const truncatedActions = actions.length > boundedRows;
    const boundedActions = actions.slice(0,boundedRows);
    const identities = [...new Set(boundedActions.map((row) => `${dbId(row.rule_id)}:${Number(row.version)}`))];
    if (!identities.length) return effectivenessSummary({rules:[],actions:boundedActions,snapshots:[],attempts:[],feedbackRows:[],from:range.from,to:range.to,truncated:truncatedActions});
    const ruleIds = [...new Set(identities.map((identity) => identity.split(':')[0]))];
    const [ruleRows] = await pool.execute(
      `SELECT v.rule_id,v.version,v.product_category,v.content_topic,c.failure_code,c.category AS source_category
       FROM learning_rule_versions v JOIN learning_candidates c ON c.id=v.source_candidate_id
       WHERE v.rule_id IN (${ruleIds.map(()=>'?').join(',')})`,
      ruleIds,
    );
    const rules = ruleRows.filter((row) => identities.includes(`${dbId(row.rule_id)}:${Number(row.version)}`));
    const activationDates = boundedActions.filter((row) => ['activated','rolled_back'].includes(row.action) && identities.includes(`${dbId(row.rule_id)}:${Number(row.version)}`)).map((row)=>dateValue(row.created_at)).filter(Boolean);
    const earliestActivationBaseline = activationDates.length ? Math.min(...activationDates.map((date)=>date.getTime()-30*86400000)) : range.from.getTime();
    const snapshotFrom = new Date(Math.max(range.from.getTime()-30*86400000,earliestActivationBaseline));
    const [snapshotRows] = await pool.execute(
      "SELECT s.attempt_id,s.slot_id,s.model_id,s.configuration_version,s.product_category,s.content_topic,s.facts_version_json,s.applied_rules_json,s.retrieval_context_json,s.omitted_rules_json,s.prompt_integration_enabled,s.created_at,a.ordinal,a.state,a.failure_codes,a.deterministic_outcome,a.semantic_outcome,st.status AS slot_status FROM generation_learning_snapshots s JOIN generation_attempts a ON a.attempt_id=s.attempt_id JOIN slots st ON st.id=s.slot_id WHERE s.created_at>=? AND s.created_at<? ORDER BY s.created_at,s.attempt_id LIMIT ?",
      [snapshotFrom,range.to,boundedRows+1],
    );
    const truncatedSnapshots = snapshotRows.length > boundedRows;
    const boundedSnapshots = snapshotRows.slice(0,boundedRows);
    const slots = [...new Set(boundedSnapshots.map((row) => dbId(row.slot_id)).filter(Boolean))];
    let feedbackRows = [];
    if (slots.length) {
      const [feedback] = await pool.execute(
        `SELECT f.slot_id,f.reviewer_id,f.feedback_type,f.ratings_json FROM learning_feedback f JOIN slots s ON s.id=f.slot_id WHERE f.slot_id IN (${slots.map(()=>'?').join(',')}) AND s.status='published' AND f.caption_hash=SHA2(s.caption,256) ORDER BY f.slot_id,f.id LIMIT ?`,
        [...slots,boundedRows+1],
      );
      feedbackRows = feedback.slice(0,boundedRows);
    }
    const [[missing]] = await pool.execute(
      `SELECT COUNT(*) AS n FROM generation_slot_claims c JOIN generation_attempts a ON a.slot_id=c.slot_id AND a.ordinal=1 LEFT JOIN generation_learning_snapshots s ON s.attempt_id=a.attempt_id WHERE c.claimed_at>=? AND c.claimed_at<? AND s.attempt_id IS NULL`,
      [snapshotFrom,range.to],
    );
    return effectivenessSummary({rules,actions:boundedActions,snapshots:boundedSnapshots,attempts:boundedSnapshots,feedbackRows,from:range.from,to:range.to,truncated:truncatedActions||truncatedSnapshots,missingSnapshots:Number(missing.n)||0});
  }

  return {compliance,quality,effectiveness};
}

module.exports = {
  DIMENSIONS, MIN_QUALITY_CAPTIONS, MIN_EFFECTIVENESS_PER_ARM, normalizeWindow,
  qualitySummary, qualityTrends, summarizeAttempts, effectivenessSummary, createLearningAnalytics,
};
