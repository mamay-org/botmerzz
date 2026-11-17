'use strict';

const { createHash } = require('node:crypto');
const { sanitizeEvidence, sanitizePublicText } = require('./learning-evidence');

const DIMENSIONS = new Set(['hook','creativity','language','relevance','brandVoice','clarity','diversity','cta']);
const SAFE_CODES = new Set([
  'AI_REQUEST_FAILED','SEMANTIC_AUDIT_FAILED','SEMANTIC_REJECTED','SEMANTIC_INVALID_RESPONSE',
  'SEMANTIC_VALIDATION_FAILED','CONTENT_VALIDATION_FAILED','SHADOW_TIMEOUT','SHADOW_BUDGET_EXCEEDED',
  'EMPTY_CAPTION','CAPTION_TOO_LONG','FORBIDDEN_CLAIM','INVALID_HASHTAGS','POSSIBLE_PERSONAL_INFORMATION',
  'UNAPPROVED_LINK','DUPLICATE_LINK','MISSING_REQUIRED_LINK','UNAPPROVED_HASHTAG',
  'MISSING_REQUIRED_HASHTAGS','UNAPPROVED_NUMBER','PRICE_MISSING_CURRENCY','UNAPPROVED_CURRENCY',
  'REPETITIVE_CAPTION','SHADOW_BUSY','SHADOW_RECOVERY_PENDING','SHADOW_ADMISSION_UNAVAILABLE',
  'SHADOW_ADMISSION_LOST','SHADOW_WORKER_INTERRUPTED',
]);
const MAX_SAMPLES = 3;
const MAX_RULES = 5;
const MAX_PROVIDER_CALLS = 12;
const MAX_VARIANT_CALLS = 2;
const MAX_TOKEN_BUDGET = 30_000;
const MAX_CALL_OUTPUT_TOKENS = 700;
const MAX_DURATION_MS = 180_000;
const MAX_CALL_MS = 15_000;
const STALE_AFTER_MS = MAX_DURATION_MS + 120_000;
const MAX_STALE_BATCH = 100;

function failure(code, status = 400) {
  return Object.assign(new Error(code), { code, status });
}

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function safeId(value) {
  return typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
}

function isSafeModelId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:/-]{1,128}$/.test(value)) return false;
  const safe = sanitizePublicText(value);
  return safe.status === 'available' && safe.excerpt === value;
}

function publicRatings(value) {
  const parsed = parseJson(value,{});
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed).filter(([key,rating]) => DIMENSIONS.has(key)
    && Number.isInteger(rating) && rating >= 1 && rating <= 5));
}

function validateShadowReview(body) {
  if (!body || !Number.isInteger(body.sampleIndex) || body.sampleIndex < 1 || body.sampleIndex > MAX_SAMPLES
    || !['baseline','learning'].includes(body.variant) || !['positive','negative'].includes(body.feedbackType)
    || !body.ratings || typeof body.ratings !== 'object' || Array.isArray(body.ratings)) return false;
  const ratings = Object.entries(body.ratings);
  return ratings.length > 0 && ratings.every(([key,value]) => DIMENSIONS.has(key) && Number.isInteger(value) && value >= 1 && value <= 5)
    && typeof (body.explanation ?? '') === 'string' && [...(body.explanation ?? '')].length <= 300;
}

function createLearningShadowStore(pool) {
  async function consumeStartQuota(actorId) {
    const actor = safeId(actorId);
    if (!/^[1-9]\d{0,19}$/.test(actor)) throw failure('INVALID_SHADOW_REQUEST');
    const connection = await pool.getConnection();
    try {
      await connection.execute(
        `INSERT INTO learning_shadow_start_limits (actor_id,window_started_at,request_count)
         VALUES (?,UTC_TIMESTAMP(3),LAST_INSERT_ID(1))
         ON DUPLICATE KEY UPDATE
           request_count=LAST_INSERT_ID(IF(window_started_at<=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 15 MINUTE),1,IF(request_count<255,request_count+1,255))),
           window_started_at=IF(window_started_at<=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 15 MINUTE),UTC_TIMESTAMP(3),window_started_at)`,
        [actor],
      );
      const [[counter]] = await connection.execute('SELECT LAST_INSERT_ID() AS request_count');
      const count = Number(counter.request_count);
      if (count <= 3) return {allowed:true,retryAfterSeconds:0};
      const [[row]] = await connection.execute(
        'SELECT window_started_at,UTC_TIMESTAMP(3) AS database_now FROM learning_shadow_start_limits WHERE actor_id=?',
        [actor],
      );
      const startedAt = new Date(row.window_started_at).getTime();
      const now = new Date(row.database_now).getTime();
      return {allowed:false,retryAfterSeconds:Math.max(1,Math.ceil((startedAt + 15 * 60_000 - now) / 1000))};
    } finally { connection.release(); }
  }

  async function acquireAdmission() {
    const connection = await pool.getConnection();
    let lockName = null;
    let locked = false;
    let healthy = true;
    let released = false;
    const controller = new AbortController();
    const markLost = () => {
      healthy = false;
      if (!controller.signal.aborted) controller.abort();
    };
    connection.on('error',markLost);
    connection.on('end',markLost);

    async function release() {
      if (released) return;
      released = true;
      connection.removeListener('error',markLost);
      connection.removeListener('end',markLost);
      if (!healthy) { connection.destroy(); return; }
      if (locked) {
        try {
          const [[result]] = await connection.execute('SELECT RELEASE_LOCK(?) AS released',[lockName]);
          if (Number(result.released) !== 1) { connection.destroy(); return; }
        } catch { connection.destroy(); return; }
      }
      connection.release();
    }

    try {
      const [[database]] = await connection.execute('SELECT DATABASE() AS name');
      if (typeof database?.name !== 'string' || !database.name) throw failure('SHADOW_ADMISSION_UNAVAILABLE',503);
      lockName = `bm_shadow_${createHash('sha256').update(database.name).digest('hex').slice(0,54)}`;
      const [[result]] = await connection.execute('SELECT GET_LOCK(?,0) AS acquired',[lockName]);
      if (Number(result.acquired) !== 1) throw failure('SHADOW_BUSY',409);
      locked = true;
      await reconcileStale();
      const [runningRows] = await pool.execute("SELECT id FROM learning_shadow_evaluations WHERE status='running' ORDER BY created_at,id LIMIT 1");
      if (runningRows.length) throw failure('SHADOW_RECOVERY_PENDING',409);
      return {
        signal:controller.signal,
        async assertHealthy() {
          if (!healthy || controller.signal.aborted) throw failure('SHADOW_ADMISSION_LOST',503);
          try {
            const [[owner]] = await connection.execute('SELECT IS_USED_LOCK(?) AS owner,CONNECTION_ID() AS connection_id',[lockName]);
            if (String(owner.owner) !== String(owner.connection_id)) markLost();
          } catch { markLost(); }
          if (!healthy || controller.signal.aborted) throw failure('SHADOW_ADMISSION_LOST',503);
        },
        release,
      };
    } catch (error) {
      await release();
      throw error;
    }
  }

  async function start({actorId, modelId, configurationVersion, scenarioHash = null, ruleVersions, retrievalContext, sampling, requestedSamples}) {
    const [result] = await pool.execute(
      'INSERT INTO learning_shadow_evaluations (actor_id,model_id,configuration_version,scenario_hash,rule_versions_json,retrieval_context_json,sampling_json,requested_samples,results_json) VALUES (?,?,?,?,?,?,?,?,?)',
      [actorId,modelId,configurationVersion,scenarioHash,JSON.stringify(ruleVersions),JSON.stringify(retrievalContext),JSON.stringify(sampling),requestedSamples,JSON.stringify([])],
    );
    return String(result.insertId);
  }

  async function finish(id, {status, completedSamples, providerCalls, estimatedMaxTokens, results, failureCode = null}) {
    if (!['completed','incomplete','failed'].includes(status)) throw failure('INVALID_SHADOW_STATUS');
    const [result] = await pool.execute(
      "UPDATE learning_shadow_evaluations SET status=?,completed_samples=?,provider_calls=?,estimated_max_tokens=?,results_json=?,failure_code=?,completed_at=UTC_TIMESTAMP(3) WHERE id=? AND status='running'",
      [status,completedSamples,providerCalls,estimatedMaxTokens,JSON.stringify(results),failureCode,id],
    );
    return result.affectedRows === 1;
  }

  async function reconcileStale() {
    const staleBefore = new Date(Date.now() - STALE_AFTER_MS);
    const [rows] = await pool.execute(
      "SELECT id FROM learning_shadow_evaluations WHERE status='running' AND created_at<? ORDER BY created_at,id LIMIT ?",
      [staleBefore,MAX_STALE_BATCH],
    );
    if (!rows.length) return 0;
    const ids = rows.map((row) => safeId(row.id));
    const [result] = await pool.execute(
      `UPDATE learning_shadow_evaluations SET status='failed',failure_code='SHADOW_WORKER_INTERRUPTED',completed_at=UTC_TIMESTAMP(3) WHERE status='running' AND id IN (${ids.map(()=>'?').join(',')})`,
      ids,
    );
    return result.affectedRows;
  }

  function mapRun(row) {
    const ruleVersions = parseJson(row.rule_versions_json, []);
    return {
      id: safeId(row.id), actorId: safeId(row.actor_id),
      modelId: isSafeModelId(row.model_id) ? row.model_id : null,
      configurationVersion: typeof row.configuration_version === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(row.configuration_version)
        && sanitizePublicText(row.configuration_version).excerpt === row.configuration_version ? row.configuration_version : null,
      scenarioHash: typeof row.scenario_hash === 'string' && /^[a-f0-9]{64}$/i.test(row.scenario_hash) ? row.scenario_hash : null,
      ruleVersions: Array.isArray(ruleVersions) ? ruleVersions.slice(0,MAX_RULES).flatMap((item) => {
        const id = safeId(item?.id); const version = Number(item?.version);
        return /^[1-9]\d{0,19}$/.test(id) && Number.isSafeInteger(version) && version > 0 ? [{id,version}] : [];
      }) : [],
      retrievalContext: safeRetrievalContext(parseJson(row.retrieval_context_json, {})) || {},
      sampling: validSampling(parseJson(row.sampling_json, {})) || {}, requestedSamples: Number(row.requested_samples),
      completedSamples: Number(row.completed_samples), providerCalls: Number(row.provider_calls),
      estimatedMaxTokens: Number(row.estimated_max_tokens), results: mapPublicResults(parseJson(row.results_json, [])),
      status: ['running','completed','incomplete','failed'].includes(row.status) ? row.status : 'failed',
      failureCode: SAFE_CODES.has(row.failure_code) ? row.failure_code : null, createdAt: row.created_at, completedAt: row.completed_at,
    };
  }

  async function get(id) {
    await reconcileStale();
    const [rows] = await pool.execute('SELECT * FROM learning_shadow_evaluations WHERE id=?', [id]);
    return rows[0] ? mapRun(rows[0]) : null;
  }

  async function list({beforeId = null, limit = 25} = {}) {
    const boundedLimit = Number.isSafeInteger(Number(limit)) ? Math.max(1,Math.min(100,Number(limit))) : 25;
    if (beforeId !== null && !/^[1-9]\d{0,19}$/.test(String(beforeId))) throw failure('INVALID_CURSOR');
    await reconcileStale();
    const [rows] = await pool.execute(
      'SELECT * FROM learning_shadow_evaluations WHERE (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?',
      [beforeId,beforeId,boundedLimit + 1],
    );
    const page = rows.slice(0,boundedLimit).map(mapRun);
    return {evaluations:page,nextBeforeId:rows.length > boundedLimit ? page.at(-1)?.id || null : null};
  }

  async function recordReview(evaluationId, body, reviewerId) {
    if (!validateShadowReview(body)) throw failure('INVALID_SHADOW_REVIEW');
    const [runs] = await pool.execute(
      'SELECT status,completed_samples,results_json FROM learning_shadow_evaluations WHERE id=?',
      [evaluationId],
    );
    const run = runs[0];
    if (!run || !['completed','incomplete'].includes(run.status) || body.sampleIndex > Number(run.completed_samples)) throw failure('SHADOW_RESULT_NOT_REVIEWABLE',409);
    const results = parseJson(run.results_json,[]);
    const sample = Array.isArray(results) ? results.find((item) => Number(item.sampleIndex) === body.sampleIndex) : null;
    if (!sample?.[body.variant]?.validatedCaption) throw failure('SHADOW_RESULT_NOT_REVIEWABLE',409);
    const explanation = body.explanation ? sanitizeEvidence(body.explanation) : null;
    if (explanation && (explanation.status !== 'available' || explanation.excerpt !== body.explanation)) throw failure('INVALID_SHADOW_REVIEW');
    try {
      const [result] = await pool.execute(
        'INSERT INTO learning_shadow_reviews (evaluation_id,sample_index,variant,reviewer_id,feedback_type,ratings_json,explanation) VALUES (?,?,?,?,?,?,?)',
        [evaluationId,body.sampleIndex,body.variant,reviewerId,body.feedbackType,JSON.stringify(body.ratings),explanation?.excerpt || ''],
      );
      return {id:String(result.insertId),evaluationId:String(evaluationId),sampleIndex:body.sampleIndex,variant:body.variant,reviewerId:String(reviewerId)};
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') throw failure('SHADOW_REVIEW_EXISTS',409);
      throw error;
    }
  }

  async function listReviews(evaluationId) {
    const [rows] = await pool.execute(
      'SELECT id,evaluation_id,sample_index,variant,reviewer_id,feedback_type,ratings_json,explanation,created_at FROM learning_shadow_reviews WHERE evaluation_id=? ORDER BY sample_index,variant,created_at,id LIMIT 500',
      [evaluationId],
    );
    return rows.map((row) => ({id:safeId(row.id),evaluationId:safeId(row.evaluation_id),sampleIndex:Number(row.sample_index),variant:row.variant,reviewerId:safeId(row.reviewer_id),feedbackType:row.feedback_type,ratings:publicRatings(row.ratings_json),explanation:sanitizePublicText(row.explanation).excerpt || '',createdAt:row.created_at}));
  }

  return {start,finish,get,list,recordReview,listReviews,reconcileStale,consumeStartQuota,acquireAdmission};
}

function validSampling(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sampling = {};
  if (value.temperature !== undefined) {
    if (typeof value.temperature !== 'number' || !Number.isFinite(value.temperature) || value.temperature < 0 || value.temperature > 2) return null;
    sampling.temperature = value.temperature;
  }
  if (value.topP !== undefined) {
    if (typeof value.topP !== 'number' || !Number.isFinite(value.topP) || value.topP < 0 || value.topP > 1) return null;
    sampling.topP = value.topP;
  }
  return sampling;
}

function safeRules(rules) {
  if (!Array.isArray(rules) || rules.length > MAX_RULES) return null;
  const seen = new Set();
  const clean = [];
  for (const rule of rules) {
    const id = safeId(rule?.id);
    const version = Number(rule?.version);
    if (!/^[1-9]\d{0,19}$/.test(id) || !Number.isSafeInteger(version) || version < 1 || rule?.approved !== true
      || typeof rule.instruction !== 'string' || !rule.instruction.trim() || [...rule.instruction].length > 300) return null;
    const instruction = rule.instruction.trim();
    const safeInstruction = sanitizePublicText(instruction);
    if (safeInstruction.status !== 'available' || safeInstruction.excerpt !== instruction) return null;
    const key = `${id}:${version}`;
    if (seen.has(key)) return null;
    seen.add(key);
    clean.push({id,version,instruction,productCategory:rule.productCategory || 'all',contentTopic:rule.contentTopic || 'all'});
  }
  return clean;
}

function safeRetrievalContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  if (['all','account','topup'].includes(value.productCategory)) out.productCategory = value.productCategory;
  if (['all','education','community','gamer_observation','relatable_situation','brand_awareness','trust'].includes(value.contentTopic)) out.contentTopic = value.contentTopic;
  if (isSafeModelId(value.modelId)) out.modelId = value.modelId;
  if (typeof value.configurationVersion === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(value.configurationVersion)
    && sanitizePublicText(value.configurationVersion).excerpt === value.configurationVersion) out.configurationVersion = value.configurationVersion;
  if (typeof value.brandGuidelinesHash === 'string' && /^[a-f0-9]{64}$/i.test(value.brandGuidelinesHash)) out.brandGuidelinesHash = value.brandGuidelinesHash;
  if (Array.isArray(value.factsVersion) && value.factsVersion.length <= 50) {
    out.factsVersion = value.factsVersion.filter((fact) => fact && (typeof fact.id === 'string' || typeof fact.id === 'number')
      && /^[A-Za-z0-9_.:-]{1,128}$/.test(String(fact.id)) && sanitizePublicText(String(fact.id)).excerpt === String(fact.id)
      && typeof fact.updatedAt === 'string'
      && fact.updatedAt.length <= 40 && Number.isFinite(Date.parse(fact.updatedAt))).map((fact) => ({id:String(fact.id),updatedAt:fact.updatedAt}));
  } else out.factsVersion = [];
  return out;
}

function safeVariant(result) {
  const allowed = new Set(['passed','contextual_failed','technical_failed','unknown','incomplete']);
  const outcome = result?.outcome === 'ready' ? 'passed' : result?.outcome;
  if (!allowed.has(outcome)) throw failure('INVALID_SHADOW_RESULT',500);
  const failureCodes = Array.isArray(result.failureCodes) ? [...new Set(result.failureCodes.filter((code) => typeof code === 'string' && SAFE_CODES.has(code)))].slice(0,10) : [];
  const normalized = {outcome,failureCodes};
  for (const key of ['deterministicOutcome','semanticOutcome']) {
    if (['PASSED','FAILED','UNKNOWN','TECHNICAL_FAILED','NOT_RUN'].includes(result[key])) normalized[key] = result[key];
  }
  if (result.validatedOutput === true && outcome === 'passed' && typeof result.caption === 'string' && [...result.caption].length <= 500) {
    const caption = sanitizePublicText(result.caption);
    normalized.validatedCaption = caption.status === 'available' ? caption.excerpt : null;
    normalized.validatedCaptionStatus = caption.status === 'unavailable' ? 'withheld' : caption.excerpt === result.caption ? 'available' : 'redacted';
  }
  return normalized;
}

function mapPublicResults(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0,MAX_SAMPLES).flatMap((sample) => {
    const sampleIndex = Number(sample?.sampleIndex);
    if (!Number.isInteger(sampleIndex) || sampleIndex < 1 || sampleIndex > MAX_SAMPLES) return [];
    const mapped = {sampleIndex};
    for (const variant of ['baseline','learning']) {
      const source = sample?.[variant];
      if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
      const allowedOutcomes = new Set(['passed','contextual_failed','technical_failed','unknown','incomplete']);
      const outcome = allowedOutcomes.has(source.outcome) ? source.outcome : 'unknown';
      const failureCodes = Array.isArray(source.failureCodes)
        ? [...new Set(source.failureCodes.filter((code) => typeof code === 'string' && SAFE_CODES.has(code)))].slice(0,10) : [];
      const result = {outcome,failureCodes};
      for (const key of ['deterministicOutcome','semanticOutcome']) {
        if (['PASSED','FAILED','UNKNOWN','TECHNICAL_FAILED','NOT_RUN'].includes(source[key])) result[key] = source[key];
      }
      if (typeof source.validatedCaption === 'string') {
        const caption = sanitizePublicText(source.validatedCaption);
        result.validatedCaption = caption.status === 'available' ? caption.excerpt : null;
        result.validatedCaptionStatus = caption.status === 'unavailable' ? 'withheld' : caption.excerpt === source.validatedCaption ? 'available' : 'redacted';
      }
      mapped[variant] = result;
    }
    return [mapped];
  });
}

function serializableSize(value) {
  try { return Buffer.byteLength(JSON.stringify(value)); } catch { return Infinity; }
}

function createLearningShadowEvaluator({store,runVariant,providerGenerate,clock = () => Date.now(),limits = {}}) {
  if (!store || typeof store.start !== 'function' || typeof store.finish !== 'function' || typeof runVariant !== 'function' || typeof providerGenerate !== 'function') throw new TypeError('shadow store, runner, and provider are required');
  const maxSamples = Math.min(MAX_SAMPLES,Number.isInteger(limits.maxSamples) ? limits.maxSamples : MAX_SAMPLES);
  const maxProviderCalls = Math.min(MAX_PROVIDER_CALLS,Number.isInteger(limits.maxProviderCalls) ? limits.maxProviderCalls : MAX_PROVIDER_CALLS);
  const maxTokenBudget = Math.min(MAX_TOKEN_BUDGET,Number.isInteger(limits.maxTokenBudget) ? limits.maxTokenBudget : MAX_TOKEN_BUDGET);
  const maxDurationMs = Math.min(MAX_DURATION_MS,Number.isInteger(limits.maxDurationMs) ? limits.maxDurationMs : MAX_DURATION_MS);
  let running = false;

  async function evaluate({actorId,modelId,configurationVersion = null,rules,retrievalContext,sampling = {},scenario,samples = 1}) {
    if (running) throw failure('SHADOW_BUSY',409);
    const actor = safeId(actorId);
    const approvedRules = safeRules(rules);
    const context = safeRetrievalContext(retrievalContext);
    const sampleCount = Number(samples);
    const normalizedSampling = validSampling(sampling);
    if (!isSafeModelId(modelId) || !/^[1-9]\d{0,19}$/.test(actor)
      || (configurationVersion !== null && (typeof configurationVersion !== 'string' || configurationVersion.length > 64))
      || !approvedRules || !context || !normalizedSampling || !Number.isInteger(sampleCount) || sampleCount < 1 || sampleCount > maxSamples
      || scenario == null || serializableSize(scenario) > 20_000) throw failure('INVALID_SHADOW_REQUEST');

    running = true;
    const started = clock();
    const deadline = started + maxDurationMs;
    const scenarioHash = createHash('sha256').update(JSON.stringify(scenario)).digest('hex');
    let evaluationId = null;
    const results = [];
    let providerCalls = 0;
    let estimatedMaxTokens = 0;
    const evaluationController = new AbortController();
    let admission = null;
    let admissionAbort = null;
    try {
      if (typeof store.acquireAdmission !== 'function') throw failure('SHADOW_ADMISSION_UNAVAILABLE',503);
      admission = await store.acquireAdmission();
      if (!admission || typeof admission.assertHealthy !== 'function' || typeof admission.release !== 'function') throw failure('SHADOW_ADMISSION_UNAVAILABLE',503);
      admissionAbort = () => evaluationController.abort();
      admission.signal?.addEventListener('abort',admissionAbort,{once:true});
      if (admission.signal?.aborted) evaluationController.abort();
      evaluationId = await store.start({actorId:actor,modelId,configurationVersion,scenarioHash,ruleVersions:approvedRules.map(({id,version}) => ({id,version})),retrievalContext:context,sampling:normalizedSampling,requestedSamples:sampleCount});
      for (let index = 1; index <= sampleCount; index++) {
        if (clock() >= deadline) throw failure('SHADOW_TIMEOUT',504);
        const pair = {};
        for (const variant of ['baseline','learning']) {
          let variantCalls = 0;
          const generate = async (request) => {
            const now = clock();
            if (evaluationController.signal.aborted || now >= deadline || providerCalls >= maxProviderCalls || variantCalls >= MAX_VARIANT_CALLS) throw failure(now >= deadline || evaluationController.signal.aborted ? 'SHADOW_TIMEOUT' : 'SHADOW_BUDGET_EXCEEDED',504);
              await admission.assertHealthy();
            if (!request || typeof request.system !== 'string' || typeof request.user !== 'string'
              || !Number.isInteger(request.maxTokens) || request.maxTokens < 1 || request.maxTokens > MAX_CALL_OUTPUT_TOKENS) throw failure('SHADOW_BUDGET_EXCEEDED',429);
            const tokenEstimate = Math.ceil((Buffer.byteLength(request.system,'utf8') + Buffer.byteLength(request.user,'utf8')) / 2) + request.maxTokens;
            if (estimatedMaxTokens + tokenEstimate > maxTokenBudget) throw failure('SHADOW_BUDGET_EXCEEDED',429);
            const controller = new AbortController();
            const callLimit = Math.max(1,Math.min(MAX_CALL_MS,deadline - now));
            const timeout = setTimeout(() => controller.abort(),callLimit);
            let rejectTimer;
            const abortCall = () => controller.abort();
            evaluationController.signal.addEventListener('abort',abortCall,{once:true});
            variantCalls++; providerCalls++; estimatedMaxTokens += tokenEstimate;
            try {
              const remaining = new Promise((_,reject) => { rejectTimer = setTimeout(() => reject(failure('SHADOW_TIMEOUT',504)),callLimit); });
              const response = await Promise.race([providerGenerate({...request,signal:controller.signal}),remaining]);
              await admission.assertHealthy();
              return response;
            } finally {
              evaluationController.signal.removeEventListener('abort',abortCall);
              clearTimeout(rejectTimer);
              clearTimeout(timeout);
              controller.abort();
            }
          };
          let variantTimeout;
          const boundedRunner = new Promise((_,reject) => {
            variantTimeout = setTimeout(() => {
              evaluationController.abort();
              reject(failure('SHADOW_TIMEOUT',504));
            },Math.max(1,deadline-clock()));
          });
          let variantResult;
          try {
            variantResult = await Promise.race([runVariant({
            evaluationId,sampleIndex:index,variant,modelId,configurationVersion,
            scenario:structuredClone(scenario),sampling:{...normalizedSampling},
            rules:variant === 'learning' ? approvedRules.map((rule) => ({...rule})) : [],
            generate,deadlineAt:deadline,signal:evaluationController.signal,
            }),boundedRunner]);
          } finally {
            clearTimeout(variantTimeout);
          }
          pair[variant] = safeVariant(variantResult);
        }
        results.push({sampleIndex:index,baseline:pair.baseline,learning:pair.learning});
      }
      await admission.assertHealthy();
      if (!await store.finish(evaluationId,{status:'completed',completedSamples:results.length,providerCalls,estimatedMaxTokens,results})) throw failure('SHADOW_OUTCOME_NOT_PERSISTED',503);
      return {evaluationId,status:'completed',scenarioHash,requestedSamples:sampleCount,completedSamples:results.length,providerCalls,estimatedMaxTokens,results};
    } catch (error) {
      const code = SAFE_CODES.has(error?.code) ? error.code : error?.code === 'SHADOW_TIMEOUT' ? 'SHADOW_TIMEOUT' : 'AI_REQUEST_FAILED';
      const status = results.length ? 'incomplete' : 'failed';
      if (evaluationId) await store.finish(evaluationId,{status,completedSamples:results.length,providerCalls,estimatedMaxTokens,results,failureCode:code}).catch(() => false);
      throw failure(code,error?.status || 502);
    } finally {
      admission?.signal?.removeEventListener('abort',admissionAbort);
      await admission?.release().catch(()=>{});
      running = false;
    }
  }

  return {evaluate};
}

module.exports = {
  MAX_SAMPLES, MAX_RULES, MAX_PROVIDER_CALLS, MAX_TOKEN_BUDGET, MAX_DURATION_MS,
  validateShadowReview, isSafeModelId, createLearningShadowStore, createLearningShadowEvaluator,
};
