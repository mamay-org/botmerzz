'use strict';
const { createHash } = require('node:crypto');
const { sanitizeEvidence, sanitizePublicText } = require('./learning-evidence');
const dimensions = new Set(['hook', 'creativity', 'language', 'relevance', 'brandVoice', 'clarity', 'diversity', 'cta']);
const scopes = new Set(['global', 'account', 'topup']);
const productCategories = new Set(['all','account','topup']);
const contentTopics = new Set(['all','education','community','gamer_observation','relatable_situation','brand_awareness','trust']);
const MAX_ACTIVE_RULES = 500;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const dbBoolean = (value) => (Buffer.isBuffer(value) || value instanceof Uint8Array)
  ? value.length === 1 && value[0] === 1
  : value === true || value === 1 || value === '1';
const safeText = (value, max) => typeof value === 'string' && value.length <= max;
const error = (code, status) => Object.assign(new Error(code), { code, status });
const positiveVersion = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const normalizeInstruction = (value) => value.normalize('NFKC').toLocaleLowerCase('ms-MY').replace(/[^\p{L}\p{N}]+/gu,' ').trim();

function normalizedScope(body) {
  const scope = body?.scope;
  const productCategory = body?.productCategory ?? (scope === 'global' ? 'all' : scope);
  const contentTopic = body?.contentTopic ?? 'all';
  if (!scopes.has(scope || (productCategory === 'all' ? 'global' : productCategory)) || !productCategories.has(productCategory) || !contentTopics.has(contentTopic)) return null;
  if (scope && (scope === 'global' ? productCategory !== 'all' : scope !== productCategory)) return null;
  return {scope:scope || (productCategory === 'all' ? 'global' : productCategory),productCategory,contentTopic};
}

function validateRuleInstruction(instruction) {
  if (!safeText(instruction,1000) || !instruction.trim() || [...instruction].length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(instruction)) return false;
  const sanitized=sanitizePublicText(instruction);
  return sanitized.status === 'available' && sanitized.excerpt === instruction.trim();
}

function validateRuleFields(body) {
  return Boolean(body && validateRuleInstruction(body.instruction) && normalizedScope(body));
}

function isNegated(text, index) {
  const prefix = text.slice(Math.max(0,index - 48),index).toLocaleLowerCase('ms-MY');
  return /(?:\b(?:jangan|elakkan|hindari|avoid|never|do not|don't|no|not|without|tidak|tanpa)\b)[^.!?]{0,36}$/u.test(prefix);
}

function supportsVerifiedFact(policy, phrase) {
  const normalizedPhrase=normalizeInstruction(phrase);
  const byCategory=policy.approvedFactsByCategory;
  if (byCategory && policy.productCategory==='all') {
    return ['account','topup'].every((category)=>normalizeInstruction(String(byCategory[category]||'')).includes(normalizedPhrase));
  }
  if (byCategory && policy.productCategory && policy.productCategory!=='all') {
    return normalizeInstruction(String(byCategory[policy.productCategory]||'')).includes(normalizedPhrase);
  }
  return normalizeInstruction(String(policy.approvedFacts||'')).includes(normalizedPhrase);
}

function summaryHasPrice(raw, expectedAmount) {
  if (typeof raw !== 'string') return false;
  let summary;
  try { summary=JSON.parse(raw); } catch {
    const match=/\b(?:rm|myr)\s*(\d+(?:[.,]\d{1,2})?)\b/iu.exec(raw);
    return Boolean(match && Number(match[1].replace(',','.'))===expectedAmount);
  }
  const visit=(value)=>{
    if (!value || typeof value!=='object') return false;
    if (Array.isArray(value)) return value.some(visit);
    return Object.entries(value).some(([key,item])=>{
      if (key.toLocaleLowerCase('ms-MY')!=='price') return visit(item);
      const priceText=typeof item==='number' ? String(item) : typeof item==='string' ? item.trim() : '';
      return /^\d+(?:\.\d{1,2})?$/.test(priceText) && Number.isFinite(Number(priceText)) && Number(priceText)===expectedAmount;
    });
  };
  return visit(summary);
}

function supportsVerifiedPrice(policy, amountText) {
  const amountMatch=/\d+(?:[.,]\d{1,2})?/u.exec(amountText);
  if (!amountMatch) return false;
  const amount=Number(amountMatch[0].replace(',','.'));
  const byCategory=policy.approvedFactsByCategory;
  if (byCategory && policy.productCategory==='all') {
    return ['account','topup'].every((category)=>summaryHasPrice(byCategory[category],amount));
  }
  if (byCategory && policy.productCategory && policy.productCategory!=='all') return summaryHasPrice(byCategory[policy.productCategory],amount);
  return summaryHasPrice(String(policy.approvedFacts||''),amount);
}

function policyConflicts(rule, policy = {}) {
  const text = String(rule.instruction || '').normalize('NFKC');
  const issues = [];
  const checks = [
    ['instruction_override',/(?:abaikan|ketepikan|ignore|override|lupakan)[^.!?]{0,80}(?:sistem|system|arahan|guideline|guardrail|fakta|polisi|safety)/iu],
    ['secret_exfiltration',/(?:dedahkan|tunjukkan|reveal|print|hantar|send|exfiltrate)[^.!?]{0,60}(?:api[ _-]?key|token|secret|rahsia|kata sandi|password|credential)/iu],
    ['application_control_override',/(?:ubah|tukar|change|modify|update|disable|deactivate|turn\s+off|matikan|nonaktifkan|bypass|enable|trigger|jadualkan|schedule|publish|post)[^.!?]{0,70}(?:konfigurasi|configuration|config|jadual|scheduler|publishing|threads|akaun|account|model|provider|sistem|system|validasi|validation|validator|auditor)/iu],
  ];
  for (const [code,pattern] of checks) {
    const match = pattern.exec(text);
    if (match && !isNegated(text,match.index)) issues.push(code);
  }
  const externalAction = /(?:call|invoke|send|submit|request|trigger|use|make|panggil|hubungi|hantar|buat|jalankan)[^.!?]{0,80}(?:tebar(?:\s+(?:api|endpoint|webhook))?|(?:publishing|publisher)\s+(?:api|endpoint)|api\s+(?:tebar|publishing))/iu.exec(text);
  if (externalAction && !isNegated(text,externalAction.index)) issues.push('external_service_action');
  const unsafeContent = /(?:generate|write|create|include|insert|publish|use|state|tulis|hasilkan|masukkan|sebut|dedahkan)[^.!?]{0,80}(?:hate\s+speech|hateful|(?:racial|ethnic|targeted)\s+slurs?|\bslurs?\b|ujaran\s+kebencian|maklumat\s+peribadi|personal\s+(?:data|information|contact\s+details)|private\s+(?:data|information|contact\s+details)|alamat\s+rumah|nombor\s+telefon)/iu.exec(text);
  if (unsafeContent && !isNegated(text,unsafeContent.index)) issues.push('unsafe_content_instruction');
  const guarantee = /\b(?:dijamin|jaminan|guarantee(?:d)?|pasti\s+selamat|100\s*%\s*(?:selamat|safe)|confirm\s+selamat|no\s+risk|tanpa\s+risiko)\b/iu.exec(text);
  if (guarantee && !isNegated(text,guarantee.index)) issues.push('unsupported_guarantee');
  const forbidden = Array.isArray(policy.forbiddenClaims) ? policy.forbiddenClaims : [];
  const normalizedText = normalizeInstruction(text);
  for (const claim of forbidden) {
    if (typeof claim !== 'string' || !claim.trim()) continue;
    const normalizedClaim = normalizeInstruction(claim);
    const index = normalizedText.indexOf(normalizedClaim);
    if (normalizedClaim && index >= 0 && !isNegated(normalizedText,index)) { issues.push('forbidden_claim_conflict'); break; }
  }
  const amount = /\b(?:rm|myr)\s*\d+(?:[.,]\d{1,2})?\b|\b\d+(?:[.,]\d{1,2})?\s*(?:rm|myr)\b/iu.exec(text);
  if (amount && !isNegated(text,amount.index) && !supportsVerifiedPrice(policy,amount[0])) issues.push('unverified_product_fact');
  const serviceClaims = [
    /\b(?:instant|segera|serta\s*merta|dalam\s+\d+\s*(?:minit|minutes?|jam|hours?))\s+(?:delivery|penghantaran|top\s*up|proses)\b/iu,
    /\b(?:delivery|penghantaran|top\s*up|proses)\s+(?:instant|segera|serta\s*merta)\b/iu,
    /\b(?:refund|refunded|refunds|pulangan\s+wang|pemulangan\s+wang)\b/iu,
    /\b(?:official|rasmi|authorized|authorised|pengedar\s+sah|penjual\s+rasmi)\b/iu,
    /\b(?:ready\s+stock|in\s+stock|stok\s+(?:sentiasa\s+)?(?:tersedia|ada|penuh)|sentiasa\s+tersedia)\b/iu,
    /\b(?:24\s*\/\s*7|24\s+jam|setiap\s+masa)\s+(?:support|bantuan|khidmat\s+pelanggan|customer\s+service)\b/iu,
  ];
  for (const pattern of serviceClaims) {
    const match = pattern.exec(text);
    if (!match || isNegated(text,match.index)) continue;
    if (!supportsVerifiedFact(policy,match[0])) issues.push('unsupported_service_claim');
  }
  const direction = typeof policy.contentDirection === 'string' ? policy.contentDirection.toLocaleLowerCase('ms-MY') : '';
  const normalizedRule = text.toLocaleLowerCase('ms-MY');
  const opposition = [
    [/\b(?:elakkan|jangan|tidak mahu)\b[^.!?]{0,30}\b(?:promosi|jualan|menjual)\b/u, /\b(?:utamakan|gunakan|buat|sertakan)\b[^.!?]{0,30}\b(?:promosi|jualan|menjual)\b/u],
    [/\b(?:elakkan|jangan|tidak mahu)\b[^.!?]{0,30}\b(?:soalan|pertanyaan)\b/u, /\b(?:mulakan|buka|gunakan)\b[^.!?]{0,30}\b(?:soalan|pertanyaan)\b/u],
    [/\b(?:gunakan|utamakan)\b[^.!?]{0,30}\b(?:santai|kasual)\b/u, /\b(?:gunakan|utamakan)\b[^.!?]{0,30}\b(?:formal|rasmi)\b/u],
  ];
  if (direction && opposition.some(([a,b]) => (a.test(direction) && b.test(normalizedRule)) || (b.test(direction) && a.test(normalizedRule)))) issues.push('brand_guideline_conflict');
  return [...new Set(issues)];
}

function overlapConflict(left, right) {
  if (!(left.productCategory === 'all' || right.productCategory === 'all' || left.productCategory === right.productCategory)
    || !(left.contentTopic === 'all' || right.contentTopic === 'all' || left.contentTopic === right.contentTopic)) return null;
  if (normalizeInstruction(left.instruction) === normalizeInstruction(right.instruction)) return 'duplicate_active_instruction';
  const pairs = [
    [/(?:jangan|elakkan|tidak mahu)[^.!?]{0,30}(?:promosi|jualan|menjual)/iu,/(?:utamakan|gunakan|buat|sertakan)[^.!?]{0,30}(?:promosi|jualan|menjual)/iu],
    [/(?:jangan|elakkan|tidak mahu)[^.!?]{0,30}(?:soalan|pertanyaan)/iu,/(?:mulakan|buka|gunakan)[^.!?]{0,30}(?:soalan|pertanyaan)/iu],
    [/(?:gunakan|utamakan)[^.!?]{0,30}(?:santai|kasual)/iu,/(?:gunakan|utamakan)[^.!?]{0,30}(?:formal|rasmi)/iu],
  ];
  for (const [negative,positive] of pairs) if ((negative.test(left.instruction) && positive.test(right.instruction)) || (positive.test(left.instruction) && negative.test(right.instruction))) return 'conflicting_active_instruction';
  return null;
}
function validateFeedback(body) {
  if (!body || !safeText(body.slotId, 36) || !body.slotId || !['positive', 'negative'].includes(body.type) || !safeText(body.explanation ?? '', 1000)) return false;
  if (!body.ratings || typeof body.ratings !== 'object' || Array.isArray(body.ratings)) return false;
  const entries = Object.entries(body.ratings);
  return entries.length > 0 && entries.every(([key, value]) => dimensions.has(key) && Number.isInteger(value) && value >= 1 && value <= 5);
}
function validateDecision(body) {
  if (!body || !Number.isSafeInteger(body.version) || body.version < 1 || !['approved', 'rejected', 'false_positive'].includes(body.decision) || !safeText(body.reason ?? '', 1000)) return false;
  return body.decision !== 'approved' || validateRuleFields(body);
}
function createLearningStore(pool, options = {}) {
  function mapPublicInstruction(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return {instruction:null,instructionStatus:'unavailable'};
    // Public output and instruction eligibility share bounded sensitive-label
    // checks; this mapping does not change stored bytes or runtime prompts.
    const sanitized=sanitizePublicText(raw);
    if (sanitized.status !== 'available') return {instruction:null,instructionStatus:'withheld'};
    return {instruction:sanitized.excerpt,instructionStatus:sanitized.excerpt === raw.trim() ? 'available' : 'redacted'};
  }
  const publicText = (raw) => sanitizePublicText(raw).excerpt || '';
  function publicRuleActionDetails(raw) {
    const source = parseJson(raw);
    if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
    const output = {};
    const positiveId = (value) => (typeof value === 'number' || typeof value === 'string') && /^[1-9]\d{0,19}$/.test(String(value));
    const positiveNumber = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
    for (const key of ['sourceCandidateId','sourceAttemptId','sourceSlotId','replacementRuleId','supersedesRuleId']) {
      const value = source[key];
      if (key === 'sourceSlotId' && typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value)) output[key] = value;
      else if (key === 'sourceAttemptId' && (value === null || value === undefined)) output[key] = null;
      else if (key !== 'sourceSlotId' && key !== 'sourceAttemptId' && positiveId(value)) output[key] = String(value);
    }
    for (const key of ['previousVersion','fromVersion','toVersion','replacementVersion']) if (positiveNumber(source[key])) output[key] = Number(source[key]);
    for (const key of ['productCategory']) if (productCategories.has(source[key])) output[key] = source[key];
    for (const key of ['contentTopic']) if (contentTopics.has(source[key])) output[key] = source[key];
    if (source.source === 'candidate_review') output.source = 'candidate_review';
    return output;
  }
  async function listCandidates(status, beforeId = null, search = '', source = '') {
    if (beforeId !== null && !/^[1-9]\d{0,19}$/.test(String(beforeId))) throw error('INVALID_CURSOR', 400);
    if (typeof search !== 'string' || [...search].length > 80 || /[\u0000-\u001f\u007f]/u.test(search)) throw error('INVALID_SEARCH', 400);
    if (source && !['validation','feedback'].includes(source)) throw error('INVALID_SOURCE', 400);
    const term = search.trim().replace(/[!%_]/g, (character) => `!${character}`);
    const pattern = term ? `%${term}%` : '';
    const [rows] = await pool.execute(`SELECT c.id,c.slot_id AS slotId,c.source,c.category,c.scope,c.explanation,c.instruction,c.status,c.version,c.created_at AS createdAt,NULL AS caption,e.attempt_id AS attemptId,e.validation_run_id AS validationRunId,e.finding_id AS findingId,COALESCE(e.evidence_status,'unavailable') AS evidenceStatus,COALESCE(e.evidence_reason,'legacy_or_missing') AS evidenceReason,f.feedback_type AS feedbackType,f.ratings_json AS ratingsJson,f.explanation AS feedbackExplanation FROM learning_candidates c JOIN slots s ON s.id=c.slot_id LEFT JOIN learning_capture_events e ON e.candidate_id=c.id LEFT JOIN learning_feedback f ON f.id=c.feedback_id WHERE (? = '' OR c.status=?) AND (? = '' OR c.source=?) AND (? IS NULL OR c.id < ?) AND (? = '' OR CAST(c.id AS CHAR) LIKE ? ESCAPE '!' OR c.slot_id LIKE ? ESCAPE '!' OR c.source LIKE ? ESCAPE '!' OR c.category LIKE ? ESCAPE '!' OR c.failure_code LIKE ? ESCAPE '!' OR c.status LIKE ? ESCAPE '!' OR c.instruction LIKE ? ESCAPE '!' OR c.explanation LIKE ? ESCAPE '!') ORDER BY c.id DESC LIMIT 101`, [status || '', status || '', source || '', source || '', beforeId, beforeId, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern]);
    const candidates = rows.slice(0, 100).map((row) => {
      const sanitized = sanitizeEvidence(row.caption);
      const available = row.evidenceStatus === 'available' && sanitized.status === 'available';
      const rawRatings = parseJson(row.ratingsJson);
      const ratings = Object.fromEntries(Object.entries(rawRatings).filter(([key, rating]) => dimensions.has(key)
        && Number.isInteger(rating) && rating >= 1 && rating <= 5));
      const instruction = mapPublicInstruction(row.instruction);
      const { ratingsJson, ...candidate } = row;
      return { ...candidate, ratings,
        explanation: publicText(row.explanation),
        feedbackExplanation: publicText(row.feedbackExplanation),
        instruction: instruction.instruction, instructionStatus:instruction.instructionStatus, caption: null,
        evidenceStatus: 'unavailable',
        evidenceReason: row.source === 'feedback' ? 'policy_withheld' : (available ? 'policy_withheld' : (row.evidenceStatus === 'available' ? sanitized.reason : row.evidenceReason)) };
    });
    Object.defineProperty(candidates, 'hasMore', { value: rows.length > 100 });
    return candidates;
  }
  async function listRules() {
    const [rows] = await pool.execute(`SELECT r.id,r.candidate_id AS candidateId,COALESCE(latest.instruction,r.instruction) AS instruction,
      COALESCE(latest.scope,r.scope) AS scope,COALESCE(latest.version,r.version) AS version,latest.version AS ledgerVersion,
      av.version AS activeVersion,d.decision AS approvalStatus,COALESCE(latest.product_category,CASE WHEN r.scope='global' THEN 'all' ELSE r.scope END) AS productCategory,
      COALESCE(latest.content_topic,'all') AS contentTopic,r.approved_at AS approvedAt,
      CASE WHEN av.rule_id IS NULL THEN FALSE ELSE TRUE END AS active,
      CASE WHEN s.rule_id IS NULL THEN FALSE ELSE TRUE END AS superseded
      FROM learning_rules r
      LEFT JOIN (SELECT v.* FROM learning_rule_versions v JOIN (SELECT rule_id,MAX(version) AS version FROM learning_rule_versions GROUP BY rule_id) current_version
        ON current_version.rule_id=v.rule_id AND current_version.version=v.version) latest ON latest.rule_id=r.id
      LEFT JOIN learning_rule_active_versions av ON av.rule_id=r.id
      LEFT JOIN learning_rule_version_decisions d ON d.rule_id=latest.rule_id AND d.version=latest.version
      LEFT JOIN learning_rule_supersessions s ON s.rule_id=r.id
      ORDER BY r.id DESC LIMIT 100`);
    return rows.map((row) => ({...row,...mapPublicInstruction(row.instruction),approvalStatus:row.approvalStatus || (row.ledgerVersion == null ? 'legacy_unverified' : 'pending'),active:dbBoolean(row.active),superseded:dbBoolean(row.superseded),activeVersion:row.activeVersion == null ? null : Number(row.activeVersion),version:Number(row.version)}));
  }
  async function listReviews() {
    const [rows] = await pool.execute('SELECT candidate_id AS candidateId,actor_id AS actorId,action,reason,created_at AS createdAt FROM learning_reviews ORDER BY id DESC LIMIT 100');
    return rows.map((row) => ({...row, reason: publicText(row.reason)}));
  }
  async function feedback(body, actorId) {
    if (!validateFeedback(body)) throw error('INVALID_FEEDBACK', 400);
    const explanation = body.explanation ? sanitizeEvidence(body.explanation) : null;
    if (explanation && (explanation.status !== 'available' || [...body.explanation].length > 300)) throw error('INVALID_FEEDBACK', 400);
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const [[slot]] = await c.execute('SELECT caption FROM slots WHERE id=? FOR UPDATE', [body.slotId]);
      if (!slot || !slot.caption) throw error('CAPTION_NOT_FOUND', 404);
      const captionHash = hash(slot.caption);
      const [result] = await c.execute('INSERT INTO learning_feedback (slot_id,caption_hash,reviewer_id,feedback_type,ratings_json,explanation) VALUES (?,?,?,?,?,?)', [body.slotId,captionHash,actorId,body.type,JSON.stringify(body.ratings),explanation?.excerpt || '']);
      await c.execute('INSERT INTO learning_candidates (slot_id,feedback_id,event_key,source,category,explanation) VALUES (?,?,?,?,?,?)', [body.slotId,result.insertId,hash(`feedback:${result.insertId}`),'feedback',body.type,explanation?.excerpt || '']);
      await c.commit();
      return { id: result.insertId, slotId: body.slotId };
    } catch (e) { await c.rollback(); if (e.code === 'ER_DUP_ENTRY') throw error('FEEDBACK_ALREADY_EXISTS', 409); throw e; } finally { c.release(); }
  }
  async function captureFailure({eventId, slotId, attemptId, validationRunId, findingId, category, classificationStatus, stage, eventTime, scope = 'global', modelId = null, configVersion = null, evidence}) {
    const identifier = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && /^[A-Za-z0-9_.:-]+$/.test(value);
    if (![eventId,attemptId,validationRunId].every((x) => identifier(x,128)) || !identifier(slotId,36) || !identifier(findingId,64) || !identifier(category,64) || !identifier(stage,32) || !['contextual','unresolved','technical'].includes(classificationStatus) || !scopes.has(scope) || !Number.isFinite(Date.parse(eventTime)) || (modelId != null && !/^[A-Za-z0-9_.:/-]{1,128}$/.test(String(modelId))) || (configVersion != null && !identifier(String(configVersion),64))) throw error('INVALID_FAILURE', 400);
    // Arbitrary model text cannot be proven secret-free by a pattern filter.
    // Keep only structured findings even if a caller submits an excerpt.
    const sanitized = {status:'unavailable',reason:'policy_withheld',excerpt:null,fingerprint:null};
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      await c.execute('INSERT INTO learning_capture_events (event_id,slot_id,attempt_id,validation_run_id,finding_id,category,classification_status,validation_stage,event_time,model_id,config_version,evidence_status,evidence_reason,evidence_fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [eventId,slotId,attemptId,validationRunId,findingId,category,classificationStatus,stage,new Date(eventTime).toISOString().slice(0,23).replace('T',' '),modelId,configVersion == null ? null : String(configVersion),sanitized.status,sanitized.reason,sanitized.fingerprint]);
      if (classificationStatus === 'contextual') {
        const key = hash(JSON.stringify([slotId,attemptId,validationRunId,findingId]));
        const [result] = await c.execute('INSERT INTO learning_candidates (slot_id,event_key,source,stage,failure_code,category,scope,explanation,caption_excerpt,model_id,config_version) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [slotId,key,'validation',stage,findingId,category,scope,findingId,sanitized.excerpt || '',modelId,configVersion == null ? null : String(configVersion)]);
        await c.execute('UPDATE learning_capture_events SET candidate_id=? WHERE event_id=?', [result.insertId,eventId]);
      }
      await c.commit();
      return {status:'captured', deduplicated:false, evidenceStatus:sanitized.status};
    } catch (e) {
      await c.rollback();
      if (e.code === 'ER_DUP_ENTRY') {
        const [rows] = await c.execute('SELECT e.event_id AS eventId,e.slot_id AS slotId,e.attempt_id AS attemptId,e.validation_run_id AS validationRunId,e.finding_id AS findingId,e.category,e.classification_status AS classificationStatus,e.validation_stage AS stage,e.event_time AS eventTime,e.model_id AS modelId,e.config_version AS configVersion,c.scope FROM learning_capture_events e LEFT JOIN learning_candidates c ON c.id=e.candidate_id WHERE e.event_id=?', [eventId]);
        const existing = rows[0];
        const keys = {eventId,slotId,attemptId,validationRunId,findingId,category,classificationStatus,stage,modelId,configVersion:configVersion == null ? null : String(configVersion)};
        if (rows.length === 1 && Object.entries(keys).every(([key,value]) => existing[key] === value) && (classificationStatus !== 'contextual' || existing.scope === scope)
          && new Date(existing.eventTime).getTime() === new Date(eventTime).getTime()) return {status:'deduplicated',deduplicated:true};
        throw error('EVENT_CONFLICT', 409);
      }
      throw e;
    } finally { c.release(); }
  }
  function parseJson(value) {
    if (typeof value !== 'string') return value && typeof value === 'object' ? value : {};
    try { return JSON.parse(value); } catch { return {}; }
  }
  async function loadPolicyContext(connection) {
    const [[row]] = await connection.execute('SELECT settings_json,knowledge_json FROM settings WHERE id=1');
    const settings = parseJson(row?.settings_json);
    const knowledge = parseJson(row?.knowledge_json);
    const brand = knowledge.brand || settings.brand || {};
    const guardrails = knowledge.guardrails || settings.guardrails || {};
    const [facts] = await connection.execute('SELECT service,summary_json FROM service_facts WHERE active=TRUE ORDER BY service LIMIT 100');
    const approvedFactsByCategory=Object.fromEntries(facts.filter((fact)=>['account','topup'].includes(fact.service))
      .map((fact)=>[fact.service,JSON.stringify(parseJson(fact.summary_json))]));
    return {
      contentDirection: typeof brand.contentDirection === 'string' ? brand.contentDirection : '',
      forbiddenClaims: Array.isArray(guardrails.forbiddenClaims) ? guardrails.forbiddenClaims : [],
      approvedFacts: facts.map((fact) => JSON.stringify(parseJson(fact.summary_json))).join(' '),
      approvedFactsByCategory,
    };
  }
  async function activeRows(connection, excluded = []) {
    const exclusions = [...new Set(excluded.map(String))];
    const where = exclusions.length ? `AND r.id NOT IN (${exclusions.map(() => '?').join(',')})` : '';
    const [rows] = await connection.execute(`SELECT population.activeRuleCount,active.id,active.candidateId,active.version,active.instruction,active.scope,
      active.productCategory,active.contentTopic,active.createdAt
      FROM (SELECT COUNT(*) AS activeRuleCount FROM learning_rule_active_versions) population
      LEFT JOIN (
        SELECT r.id,r.candidate_id AS candidateId,v.version,v.instruction,v.scope,v.product_category AS productCategory,
          v.content_topic AS contentTopic,v.created_at AS createdAt
        FROM learning_rule_active_versions av
        JOIN learning_rules r ON r.id=av.rule_id
        JOIN learning_rule_versions v ON v.rule_id=av.rule_id AND v.version=av.version
        JOIN learning_rule_version_decisions d ON d.rule_id=v.rule_id AND d.version=v.version AND d.decision='approved'
        JOIN learning_candidates c ON c.id=r.candidate_id AND c.status='approved'
        LEFT JOIN learning_rule_supersessions ss ON ss.rule_id=r.id
        WHERE ss.rule_id IS NULL ${where}
        ORDER BY r.id,v.version LIMIT ${MAX_ACTIVE_RULES}
      ) active ON TRUE
      ORDER BY active.id,active.version`, exclusions);
    const activeRuleCount=Number(rows[0]?.activeRuleCount || 0);
    const rules=rows.filter((row)=>row.id!=null).map((row)=>({...row,id:String(row.id),version:Number(row.version)}));
    return {rules,activeRuleCount};
  }
  async function activationConflicts(connection, rule, excluded = [], {addingRule=false} = {}) {
    const population=await activeRows(connection,excluded);
    if(population.activeRuleCount>MAX_ACTIVE_RULES)return [{code:'active_rule_population_exceeds_limit',ruleId:null}];
    if(addingRule&&population.activeRuleCount>=MAX_ACTIVE_RULES)return [{code:'active_rule_limit_reached',ruleId:null}];
    const policy = await loadPolicyContext(connection);
    const conflicts = (validateRuleInstruction(rule.instruction) ? [] : ['invalid_rule_instruction'])
      .concat(policyConflicts(rule,{...policy,productCategory:rule.productCategory||'all'})).map((code) => ({code,ruleId:null}));
    for (const other of population.rules) {
      const code = overlapConflict(rule,other);
      if (code) conflicts.push({code,ruleId:other.id,version:other.version});
    }
    return conflicts;
  }
  async function approvedVersion(connection,id,version,{lock=false}={}) {
    const [[row]] = await connection.execute(`SELECT v.rule_id AS ruleId,v.version,v.instruction,v.scope,v.product_category AS productCategory,
      v.content_topic AS contentTopic,v.source_candidate_id AS sourceCandidateId,v.source_slot_id AS sourceSlotId,
      v.source_attempt_id AS sourceAttemptId,v.created_by AS createdBy,v.created_at AS createdAt,d.decision,d.decided_at AS approvedAt,
      r.candidate_id AS candidateId,ss.rule_id AS supersededRuleId
      FROM learning_rule_versions v JOIN learning_rules r ON r.id=v.rule_id
      JOIN learning_candidates c ON c.id=r.candidate_id AND c.status='approved'
      LEFT JOIN learning_rule_version_decisions d ON d.rule_id=v.rule_id AND d.version=v.version
      LEFT JOIN learning_rule_supersessions ss ON ss.rule_id=r.id
      WHERE v.rule_id=? AND v.version=? ${lock ? 'FOR UPDATE' : ''}`, [id,version]);
    if (!row) throw error('RULE_VERSION_NOT_FOUND',404);
    if (row.decision !== 'approved') throw error('RULE_VERSION_NOT_APPROVED',409);
    if (row.supersededRuleId) throw error('RULE_SUPERSEDED',409);
    return {...row,ruleId:String(row.ruleId),candidateId:String(row.candidateId),version:Number(row.version),sourceCandidateId:String(row.sourceCandidateId)};
  }
  async function writeRuleAction(connection,{ruleId,version=null,actorId,action,reason='',details={}}) {
    await connection.execute('INSERT INTO learning_rule_actions (rule_id,version,actor_id,action,reason,details_json) VALUES (?,?,?,?,?,?)',
      [ruleId,version,actorId,action,reason,JSON.stringify(details)]);
  }
  async function activationLock(connection) {
    await connection.execute('SELECT id FROM learning_rule_activation_lock WHERE id=1 FOR UPDATE');
  }
  function requireActivation() {
    if (options.activationEnabled !== true) throw error('LEARNING_ACTIVATION_DISABLED',503);
  }
  function validLifecycleReason(reason) {
    if (reason === undefined || reason === null || reason === '') return '';
    if (!safeText(reason,1000)) throw error('INVALID_REASON',400);
    const cleaned = sanitizeEvidence(reason);
    if (cleaned.status !== 'available' || [...reason].length > 300) throw error('INVALID_REASON',400);
    return cleaned.excerpt || '';
  }
  function mapRuleVersion(row) {
    return {id:String(row.ruleId),version:Number(row.version),instruction:row.instruction,scope:row.scope,
      productCategory:row.productCategory,contentTopic:row.contentTopic,
      source:{candidateId:String(row.sourceCandidateId),slotId:row.sourceSlotId,attemptId:row.sourceAttemptId || null},
      createdBy:Number(row.createdBy ?? 0),createdAt:row.createdAt,decision:row.decision || 'pending',approvedAt:row.approvedAt || null};
  }
  function mapPublicRuleVersion(row) {
    return {...mapRuleVersion(row),...mapPublicInstruction(row.instruction)};
  }
  async function decide(id, body, actorId) {
    if (!validateDecision(body)) throw error('INVALID_DECISION', 400);
    const reason = body.reason ? sanitizeEvidence(body.reason) : null;
    if (reason && (reason.status !== 'available' || [...body.reason].length > 300)) throw error('INVALID_DECISION', 400);
    if (body.decision === 'approved' && sanitizeEvidence(body.instruction.trim()).excerpt !== body.instruction.trim()) throw error('INVALID_DECISION', 400);
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const [[candidate]] = await c.execute('SELECT id,slot_id AS slotId,status,version FROM learning_candidates WHERE id=? FOR UPDATE', [id]);
      if (!candidate) throw error('CANDIDATE_NOT_FOUND', 404);
      if (candidate.status !== 'pending' || Number(candidate.version) !== body.version) throw error('REVIEW_CONFLICT', 409);
      if (body.decision === 'approved') {
        const scope = normalizedScope(body);
        const instruction = body.instruction.trim();
        const [[duplicate]] = await c.execute(`SELECT id FROM learning_rules WHERE rule_key=? LIMIT 1`, [hash(JSON.stringify([scope.scope,scope.productCategory,scope.contentTopic,normalizeInstruction(instruction)]))]);
        if (duplicate) throw error('DUPLICATE_RULE', 409);
        const [[historicalDuplicate]] = await c.execute(`SELECT rule_id FROM learning_rule_versions WHERE scope=? AND product_category=? AND content_topic=? AND instruction=? LIMIT 1`,
          [scope.scope,scope.productCategory,scope.contentTopic,instruction]);
        if (historicalDuplicate) throw error('DUPLICATE_RULE',409);
        const [[sourceEvent]] = await c.execute('SELECT attempt_id AS attemptId FROM learning_capture_events WHERE candidate_id=? ORDER BY event_time,event_id LIMIT 1', [id]);
        const ruleKey=hash(JSON.stringify([scope.scope,scope.productCategory,scope.contentTopic,normalizeInstruction(instruction)]));
        const [created] = await c.execute('INSERT INTO learning_rules (candidate_id,rule_key,instruction,scope,approved_by) VALUES (?,?,?,?,?)', [id,ruleKey,instruction,scope.scope,actorId]);
        await c.execute(`INSERT INTO learning_rule_versions (rule_id,version,instruction,scope,product_category,content_topic,source_candidate_id,source_slot_id,source_attempt_id,created_by)
          VALUES (?,1,?,?,?,?,?,?,?,?)`, [created.insertId,instruction,scope.scope,scope.productCategory,scope.contentTopic,id,candidate.slotId,sourceEvent?.attemptId || null,actorId]);
        const reasonText = reason?.excerpt || '';
        await c.execute('INSERT INTO learning_rule_version_decisions (rule_id,version,decision,actor_id,reason) VALUES (?,1,\'approved\',?,?)', [created.insertId,actorId,reasonText]);
        await writeRuleAction(c,{ruleId:created.insertId,version:1,actorId,action:'created',reason:reasonText,details:{sourceCandidateId:String(id),sourceSlotId:candidate.slotId,sourceAttemptId:sourceEvent?.attemptId || null,productCategory:scope.productCategory,contentTopic:scope.contentTopic}});
        await writeRuleAction(c,{ruleId:created.insertId,version:1,actorId,action:'approved',reason:reasonText,details:{source:'candidate_review'}});
      }
      if (body.decision === 'approved') {
        const scope=normalizedScope(body);
        await c.execute('UPDATE learning_candidates SET status=?,instruction=?,scope=?,version=version+1 WHERE id=?', [body.decision,body.instruction.trim(),scope.scope,id]);
      }
      else await c.execute('UPDATE learning_candidates SET status=?,version=version+1 WHERE id=?', [body.decision,id]);
      await c.execute('INSERT INTO learning_reviews (candidate_id,actor_id,action,entity_version,reason) VALUES (?,?,?,?,?)', [id,actorId,body.decision,body.version,reason?.excerpt || '']);
      await c.commit();
      return {id, status:body.decision, version:body.version + 1};
    } catch (e) { await c.rollback(); if (e.code === 'ER_DUP_ENTRY') throw error('DUPLICATE_RULE', 409); throw e; } finally { c.release(); }
  }
  async function listRuleVersions(id) {
    if (!/^[1-9]\d{0,19}$/.test(String(id))) throw error('INVALID_ID',400);
    const [rows] = await pool.execute(`SELECT v.rule_id AS ruleId,v.version,v.instruction,v.scope,v.product_category AS productCategory,
      v.content_topic AS contentTopic,v.source_candidate_id AS sourceCandidateId,v.source_slot_id AS sourceSlotId,v.source_attempt_id AS sourceAttemptId,
      v.created_by AS createdBy,v.created_at AS createdAt,d.decision,d.actor_id AS decidedBy,d.reason,d.decided_at AS approvedAt
      FROM learning_rule_versions v LEFT JOIN learning_rule_version_decisions d ON d.rule_id=v.rule_id AND d.version=v.version
      WHERE v.rule_id=? ORDER BY v.version DESC`,[id]);
    return rows.map((row) => ({...mapPublicRuleVersion(row),decidedBy:row.decidedBy == null ? null : Number(row.decidedBy),reason:publicText(row.reason || '')}));
  }
  async function listRuleActions(id) {
    if (!/^[1-9]\d{0,19}$/.test(String(id))) throw error('INVALID_ID',400);
    const [rows]=await pool.execute('SELECT id,version,actor_id AS actorId,action,reason,details_json AS details,created_at AS createdAt FROM learning_rule_actions WHERE rule_id=? ORDER BY id DESC LIMIT 100',[id]);
    return rows.map((row)=>({...row,actorId:Number(row.actorId),version:row.version==null?null:Number(row.version),reason:publicText(row.reason||''),details:publicRuleActionDetails(row.details)}));
  }
  async function getApprovedRuleVersions(ids) {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 20) throw error('INVALID_RULE_IDS',400);
    const requested = ids.map((entry) => typeof entry === 'object' && entry ? {id:String(entry.id),version:entry.version == null ? null : Number(entry.version)} : {id:String(entry),version:null});
    if (requested.some(({id,version}) => !/^[1-9]\d{0,19}$/.test(id) || (version !== null && !positiveVersion(version)))) throw error('INVALID_RULE_IDS',400);
    const conditions=requested.map((item) => item.version === null ? '(v.rule_id=? AND v.version=(SELECT MAX(v2.version) FROM learning_rule_versions v2 JOIN learning_rule_version_decisions d2 ON d2.rule_id=v2.rule_id AND d2.version=v2.version AND d2.decision=\'approved\' WHERE v2.rule_id=v.rule_id))' : '(v.rule_id=? AND v.version=?)');
    const values=requested.flatMap((item) => item.version === null ? [item.id] : [item.id,item.version]);
    const [rows] = await pool.execute(`SELECT v.rule_id AS ruleId,v.version,v.instruction,v.scope,v.product_category AS productCategory,
      v.content_topic AS contentTopic,v.source_candidate_id AS sourceCandidateId,v.source_slot_id AS sourceSlotId,v.source_attempt_id AS sourceAttemptId,
      v.created_by AS createdBy,v.created_at AS createdAt,d.decision,d.decided_at AS approvedAt
      FROM learning_rule_versions v JOIN learning_rule_version_decisions d ON d.rule_id=v.rule_id AND d.version=v.version AND d.decision='approved'
      JOIN learning_rules r ON r.id=v.rule_id JOIN learning_candidates c ON c.id=r.candidate_id AND c.status='approved'
      LEFT JOIN learning_rule_supersessions ss ON ss.rule_id=r.id
      WHERE ss.rule_id IS NULL AND (${conditions.join(' OR ')}) ORDER BY v.rule_id,v.version`,values);
    return rows.map(mapRuleVersion);
  }
  async function previewActivation(id,{version}={}) {
    if (!/^[1-9]\d{0,19}$/.test(String(id)) || !positiveVersion(version)) throw error('INVALID_RULE_VERSION',400);
    const rule=await approvedVersion(pool,id,version);
    const [[current]]=await pool.execute('SELECT version FROM learning_rule_active_versions WHERE rule_id=?',[id]);
    const conflicts=await activationConflicts(pool,rule,[id],{addingRule:!current});
    const activationEnabled=options.activationEnabled===true;
    return {rule:{id:rule.ruleId,version:rule.version,productCategory:rule.productCategory,contentTopic:rule.contentTopic},
      applicableRules:1,estimatedPromptTokens:Math.ceil([...rule.instruction].length/3)+8,conflicts,activationEnabled,
      disabledReason:activationEnabled?null:'activation_disabled',canActivate:activationEnabled&&conflicts.length===0};
  }
  async function activateRule(id,{version,reason}={},actorId) {
    requireActivation();
    if (!/^[1-9]\d{0,19}$/.test(String(id)) || !positiveVersion(version) || !Number.isSafeInteger(Number(actorId))) throw error('INVALID_RULE_VERSION',400);
    const reasonText=validLifecycleReason(reason);
    const c=await pool.getConnection();
    try {
      await c.beginTransaction(); await activationLock(c);
      const [[ruleRow]]=await c.execute('SELECT id FROM learning_rules WHERE id=? FOR UPDATE',[id]);
      if (!ruleRow) throw error('RULE_NOT_FOUND',404);
      const rule=await approvedVersion(c,id,version,{lock:true});
      const [[current]]=await c.execute('SELECT version FROM learning_rule_active_versions WHERE rule_id=? FOR UPDATE',[id]);
      if (current && Number(current.version)===Number(version)) { await c.commit(); return {id:String(id),version:Number(version),active:true,changed:false}; }
      const conflicts=await activationConflicts(c,rule,[id],{addingRule:!current});
      if (conflicts.length) throw Object.assign(error('RULE_CONFLICT',409),{conflicts});
      await c.execute(`INSERT INTO learning_rule_active_versions (rule_id,version,activated_by) VALUES (?,?,?)
        ON DUPLICATE KEY UPDATE version=VALUES(version),activated_by=VALUES(activated_by),activated_at=CURRENT_TIMESTAMP(3)`,[id,version,actorId]);
      await c.execute('UPDATE learning_rules SET active=TRUE WHERE id=?',[id]);
      await writeRuleAction(c,{ruleId:id,version,actorId,action:'activated',reason:reasonText,details:{previousVersion:current ? Number(current.version) : null}});
      await c.commit();
      return {id:String(id),version:Number(version),active:true,changed:true};
    } catch (e) { await c.rollback().catch(()=>{}); if (e.code==='ER_DUP_ENTRY') throw error('RULE_CONFLICT',409); throw e; }
    finally { c.release(); }
  }
  async function deactivateRule(id,{version,reason}={},actorId) {
    requireActivation();
    if (!/^[1-9]\d{0,19}$/.test(String(id)) || !positiveVersion(version) || !Number.isSafeInteger(Number(actorId))) throw error('INVALID_RULE_VERSION',400);
    const reasonText=validLifecycleReason(reason);
    const c=await pool.getConnection();
    try {
      await c.beginTransaction(); await activationLock(c);
      const [[ruleRow]]=await c.execute('SELECT id FROM learning_rules WHERE id=? FOR UPDATE',[id]);
      if (!ruleRow) throw error('RULE_NOT_FOUND',404);
      const [[current]]=await c.execute('SELECT version FROM learning_rule_active_versions WHERE rule_id=? FOR UPDATE',[id]);
      if (!current) { await c.commit(); return {id:String(id),active:false,changed:false}; }
      if (Number(current.version)!==Number(version)) throw error('RULE_VERSION_CONFLICT',409);
      await c.execute('DELETE FROM learning_rule_active_versions WHERE rule_id=?',[id]);
      await c.execute('UPDATE learning_rules SET active=FALSE WHERE id=?',[id]);
      await writeRuleAction(c,{ruleId:id,version,actorId,action:'deactivated',reason:reasonText,details:{}});
      await c.commit();
      return {id:String(id),version:Number(version),active:false,changed:true};
    } catch (e) { await c.rollback().catch(()=>{}); throw e; }
    finally { c.release(); }
  }
  async function createRevision(id,body,actorId) {
    if (!/^[1-9]\d{0,19}$/.test(String(id)) || !body || !positiveVersion(body.expectedVersion) || !Number.isSafeInteger(Number(actorId)) || !validateRuleFields(body)) throw error('INVALID_REVISION',400);
    const reasonText=validLifecycleReason(body.reason);
    const scope=normalizedScope(body); const instruction=body.instruction.trim();
    const c=await pool.getConnection();
    try {
      await c.beginTransaction();
      const [[rule]]=await c.execute('SELECT id,candidate_id AS candidateId,version FROM learning_rules WHERE id=? FOR UPDATE',[id]);
      if (!rule) throw error('RULE_NOT_FOUND',404);
      const [[superseded]]=await c.execute('SELECT rule_id FROM learning_rule_supersessions WHERE rule_id=?',[id]);
      if (superseded) throw error('RULE_SUPERSEDED',409);
      const [[latest]]=await c.execute('SELECT MAX(version) AS version FROM learning_rule_versions WHERE rule_id=?',[id]);
      const currentVersion=Number(latest?.version || 0);
      if (currentVersion!==Number(body.expectedVersion)) throw error('RULE_VERSION_CONFLICT',409);
      const [[duplicate]]=await c.execute('SELECT rule_id FROM learning_rule_versions WHERE scope=? AND product_category=? AND content_topic=? AND instruction=? LIMIT 1',[scope.scope,scope.productCategory,scope.contentTopic,instruction]);
      if (duplicate) throw error('DUPLICATE_RULE',409);
      const [[source]]=await c.execute(`SELECT source_candidate_id AS candidateId,source_slot_id AS slotId,source_attempt_id AS attemptId FROM learning_rule_versions WHERE rule_id=? AND version=?`,[id,currentVersion]);
      const [[active]]=await c.execute('SELECT version FROM learning_rule_active_versions WHERE rule_id=?',[id]);
      const nextVersion=currentVersion+1;
      await c.execute(`INSERT INTO learning_rule_versions (rule_id,version,instruction,scope,product_category,content_topic,source_candidate_id,source_slot_id,source_attempt_id,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,[id,nextVersion,instruction,scope.scope,scope.productCategory,scope.contentTopic,source?.candidateId || rule.candidateId,source?.slotId,source?.attemptId || null,actorId]);
      await c.execute('UPDATE learning_rules SET version=?,instruction=?,scope=? WHERE id=?',[nextVersion,instruction,scope.scope,id]);
      await writeRuleAction(c,{ruleId:id,version:nextVersion,actorId,action:'revision_created',reason:reasonText,details:{previousVersion:currentVersion,productCategory:scope.productCategory,contentTopic:scope.contentTopic}});
      await c.commit();
      return {id:String(id),version:nextVersion,approvalStatus:'pending',activeVersion:active?.version == null ? null : Number(active.version)};
    } catch (e) { await c.rollback().catch(()=>{}); if (e.code==='ER_DUP_ENTRY') throw error('DUPLICATE_RULE',409); throw e; }
    finally { c.release(); }
  }
  async function decideRuleVersion(id,version,body,actorId) {
    if (!/^[1-9]\d{0,19}$/.test(String(id)) || !positiveVersion(version) || !body || !['approved','rejected'].includes(body.decision) || !Number.isSafeInteger(Number(actorId))) throw error('INVALID_VERSION_DECISION',400);
    const reasonText=validLifecycleReason(body.reason);
    const c=await pool.getConnection();
    try {
      await c.beginTransaction();
      const [[rule]]=await c.execute('SELECT id FROM learning_rules WHERE id=? FOR UPDATE',[id]);
      if (!rule) throw error('RULE_NOT_FOUND',404);
      const [[superseded]]=await c.execute('SELECT rule_id FROM learning_rule_supersessions WHERE rule_id=?',[id]);
      if (superseded) throw error('RULE_SUPERSEDED',409);
      const [[versionRow]]=await c.execute('SELECT instruction FROM learning_rule_versions WHERE rule_id=? AND version=? FOR UPDATE',[id,version]);
      if (!versionRow) throw error('RULE_VERSION_NOT_FOUND',404);
      if (body.decision === 'approved' && !validateRuleInstruction(versionRow.instruction)) throw error('UNSAFE_RULE_INSTRUCTION',409);
      const [[decision]]=await c.execute('SELECT decision FROM learning_rule_version_decisions WHERE rule_id=? AND version=?',[id,version]);
      if (decision) throw error('RULE_VERSION_ALREADY_DECIDED',409);
      await c.execute('INSERT INTO learning_rule_version_decisions (rule_id,version,decision,actor_id,reason) VALUES (?,?,?,?,?)',[id,version,body.decision,actorId,reasonText]);
      await writeRuleAction(c,{ruleId:id,version,actorId,action:body.decision==='approved'?'version_approved':'version_rejected',reason:reasonText,details:{}});
      await c.commit();
      return {id:String(id),version:Number(version),approvalStatus:body.decision,active:false};
    } catch (e) { await c.rollback().catch(()=>{}); if (e.code==='ER_DUP_ENTRY') throw error('RULE_VERSION_ALREADY_DECIDED',409); throw e; }
    finally { c.release(); }
  }
  async function rollbackRule(id,body,actorId) {
    requireActivation();
    if (!/^[1-9]\d{0,19}$/.test(String(id)) || !body || !positiveVersion(body.version) || !Number.isSafeInteger(Number(actorId))) throw error('INVALID_ROLLBACK',400);
    const reasonText=validLifecycleReason(body.reason); const c=await pool.getConnection();
    try {
      await c.beginTransaction(); await activationLock(c);
      const [[ruleRow]]=await c.execute('SELECT id FROM learning_rules WHERE id=? FOR UPDATE',[id]);
      if (!ruleRow) throw error('RULE_NOT_FOUND',404);
      const [[current]]=await c.execute('SELECT version FROM learning_rule_active_versions WHERE rule_id=? FOR UPDATE',[id]);
      if (!current || Number(body.version)>=Number(current.version)) throw error('ROLLBACK_TARGET_INVALID',409);
      const target=await approvedVersion(c,id,body.version,{lock:true});
      const conflicts=await activationConflicts(c,target,[id]);
      if (conflicts.length) throw Object.assign(error('RULE_CONFLICT',409),{conflicts});
      await c.execute('UPDATE learning_rule_active_versions SET version=?,activated_by=?,activated_at=CURRENT_TIMESTAMP(3) WHERE rule_id=?',[body.version,actorId,id]);
      await c.execute('UPDATE learning_rules SET active=TRUE WHERE id=?',[id]);
      await writeRuleAction(c,{ruleId:id,version:body.version,actorId,action:'rolled_back',reason:reasonText,details:{fromVersion:Number(current.version),toVersion:Number(body.version)}});
      await c.commit();
      return {id:String(id),version:Number(body.version),active:true,changed:true,rollback:true};
    } catch (e) { await c.rollback().catch(()=>{}); throw e; }
    finally { c.release(); }
  }
  async function supersedeRule(id,body,actorId) {
    requireActivation();
    const replacementId=String(body?.replacementRuleId || '');
    if (!/^[1-9]\d{0,19}$/.test(String(id)) || !/^[1-9]\d{0,19}$/.test(replacementId) || String(id)===replacementId
      || !positiveVersion(body?.version) || !positiveVersion(body?.replacementVersion) || !Number.isSafeInteger(Number(actorId))) throw error('INVALID_SUPERSESSION',400);
    const reasonText=validLifecycleReason(body.reason); const c=await pool.getConnection();
    try {
      await c.beginTransaction(); await activationLock(c);
      const [locked]=await c.execute('SELECT id FROM learning_rules WHERE id IN (?,?) ORDER BY id FOR UPDATE',[id,replacementId]);
      if (locked.length!==2) throw error('RULE_NOT_FOUND',404);
      const [[oldActive]]=await c.execute('SELECT version FROM learning_rule_active_versions WHERE rule_id=? FOR UPDATE',[id]);
      if (!oldActive || Number(oldActive.version)!==Number(body.version)) throw error('RULE_VERSION_CONFLICT',409);
      const replacement=await approvedVersion(c,replacementId,body.replacementVersion,{lock:true});
      const conflicts=await activationConflicts(c,replacement,[id,replacementId]);
      if (conflicts.length) throw Object.assign(error('RULE_CONFLICT',409),{conflicts});
      await c.execute('DELETE FROM learning_rule_active_versions WHERE rule_id=?',[id]);
      await c.execute(`INSERT INTO learning_rule_active_versions (rule_id,version,activated_by) VALUES (?,?,?)
        ON DUPLICATE KEY UPDATE version=VALUES(version),activated_by=VALUES(activated_by),activated_at=CURRENT_TIMESTAMP(3)`,[replacementId,body.replacementVersion,actorId]);
      await c.execute('UPDATE learning_rules SET active=FALSE WHERE id=?',[id]);
      await c.execute('UPDATE learning_rules SET active=TRUE WHERE id=?',[replacementId]);
      await c.execute('INSERT INTO learning_rule_supersessions (rule_id,replacement_rule_id,version,actor_id,reason) VALUES (?,?,?,?,?)',[id,replacementId,body.version,actorId,reasonText]);
      await writeRuleAction(c,{ruleId:id,version:body.version,actorId,action:'superseded',reason:reasonText,details:{replacementRuleId:replacementId,replacementVersion:Number(body.replacementVersion)}});
      await writeRuleAction(c,{ruleId:replacementId,version:body.replacementVersion,actorId,action:'activated',reason:reasonText,details:{supersedesRuleId:String(id)}});
      await c.commit();
      return {id:String(id),supersededBy:replacementId,active:false,replacementVersion:Number(body.replacementVersion)};
    } catch (e) { await c.rollback().catch(()=>{}); if (e.code==='ER_DUP_ENTRY') throw error('RULE_ALREADY_SUPERSEDED',409); throw e; }
    finally { c.release(); }
  }
  async function retrieveActiveRules({productCategory,contentTopic='all',flags={},maxRules=5,maxTokens=350}={}) {
    if (!productCategories.has(productCategory) || !contentTopics.has(contentTopic)) throw error('INVALID_RETRIEVAL_CONTEXT',400);
    const effectiveFlags={
      activationEnabled:flags.activationEnabled ?? options.activationEnabled ?? false,
      retrievalEnabled:flags.retrievalEnabled ?? options.retrievalEnabled ?? false,
      promptIntegrationEnabled:flags.promptIntegrationEnabled ?? options.promptIntegrationEnabled ?? false,
    };
    const context={productCategory,contentTopic,flags:effectiveFlags,selectionVersion:'learning-retrieval-v1'};
    if (!effectiveFlags.activationEnabled || !effectiveFlags.retrievalEnabled) return {rules:[],omissions:[],context:{...context,disabledReason:!effectiveFlags.activationEnabled?'activation_disabled':'retrieval_disabled'}};
    const ruleLimit=Number.isSafeInteger(maxRules)?Math.min(10,Math.max(1,maxRules)):5;
    const tokenLimit=Number.isSafeInteger(maxTokens)?Math.min(1000,Math.max(1,maxTokens)):350;
    const population=await activeRows(pool);
    if(population.activeRuleCount>MAX_ACTIVE_RULES)return {
      rules:[],omissions:[{reason:'active_rule_population_exceeds_limit',count:population.activeRuleCount}],
      context:{...context,disabledReason:'active_rule_population_exceeds_limit',activeRuleCount:population.activeRuleCount},
    };
    const policy=await loadPolicyContext(pool);
    const active=population.rules;
    const applicable=[]; const omissions=[];
    for (const rule of active) {
      if (!validateRuleInstruction(rule.instruction)) {
        omissions.push({id:rule.id,version:rule.version,reason:'conflict',conflicts:[{code:'invalid_rule_instruction',ruleId:null}]});
        continue;
      }
      if (!(rule.productCategory==='all' || rule.productCategory===productCategory)) { omissions.push({id:rule.id,version:rule.version,reason:'scope_mismatch'}); continue; }
      if (!(rule.contentTopic==='all' || rule.contentTopic===contentTopic)) { omissions.push({id:rule.id,version:rule.version,reason:'topic_mismatch'}); continue; }
      applicable.push(rule);
    }
    applicable.sort((a,b)=>{
      const specificity=(row)=>(row.productCategory===productCategory?2:0)+(row.contentTopic===contentTopic?1:0);
      return specificity(b)-specificity(a) || new Date(a.createdAt)-new Date(b.createdAt) || a.id.localeCompare(b.id) || a.version-b.version;
    });
    const conflicted=new Map();
    for (let i=0;i<applicable.length;i++) for (let j=i+1;j<applicable.length;j++) {
      const code=overlapConflict(applicable[i],applicable[j]);
      if (code) { for (const row of [applicable[i],applicable[j]]) { if (!conflicted.has(row.id)) conflicted.set(row.id,[]); conflicted.get(row.id).push({code,ruleId:row.id===applicable[i].id?applicable[j].id:applicable[i].id}); } }
    }
    const rules=[]; let usedTokens=0;
    for (const row of applicable) {
      const conflicts=policyConflicts(row,{...policy,productCategory}).map((code)=>({code,ruleId:null})).concat(conflicted.get(row.id)||[]);
      if (conflicts.length) { omissions.push({id:row.id,version:row.version,reason:'conflict',conflicts}); continue; }
      const estimatedTokens=Math.ceil([...row.instruction].length/3)+8;
      if (rules.length>=ruleLimit) { omissions.push({id:row.id,version:row.version,reason:'rule_limit',estimatedTokens}); continue; }
      if (usedTokens+estimatedTokens>tokenLimit) { omissions.push({id:row.id,version:row.version,reason:'prompt_budget',estimatedTokens}); continue; }
      usedTokens+=estimatedTokens;
      rules.push({id:row.id,version:row.version,instruction:row.instruction,scope:row.scope,productCategory:row.productCategory,contentTopic:row.contentTopic,estimatedTokens});
    }
    return {rules,omissions,context:{...context,maxRules:ruleLimit,maxTokens:tokenLimit,estimatedTokens:usedTokens,eligibleCount:applicable.length,selectedCount:rules.length}};
  }
  async function listActiveRules({scope,flags}={}) {
    const result=await retrieveActiveRules({productCategory:scope==='global'?'all':scope,contentTopic:'all',flags});
    return result.rules.map(({id,instruction,scope:ruleScope,version})=>({id,instruction,scope:ruleScope,version}));
  }
  return {listCandidates,listRules,listReviews,feedback,captureFailure,decide,listActiveRules,listRuleVersions,listRuleActions,getApprovedRuleVersions,
    previewActivation,activateRule,deactivateRule,createRevision,decideRuleVersion,rollbackRule,supersedeRule,retrieveActiveRules};
}
module.exports = {createLearningStore,validateFeedback,validateDecision,validateRuleFields,normalizeInstruction,policyConflicts,overlapConflict};
