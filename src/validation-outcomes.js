'use strict';
const { createHash } = require('node:crypto');

// Outcome records are optional observations. Ordinals are local to one
// generation invocation and must not be interpreted as slot-wide ordinals.
function aggregateOutcome({ deterministic, semantic }) {
  if (deterministic === 'FAILED' && semantic === 'NOT_RUN') return 'CONTEXTUAL_FAILED';
  if (deterministic === 'UNKNOWN' && semantic === 'NOT_RUN') return 'UNKNOWN';
  if (deterministic === 'TECHNICAL_FAILED' && semantic === 'NOT_RUN') return 'TECHNICAL_FAILED';
  if (deterministic === 'NOT_RUN' && semantic === 'NOT_RUN') return 'INCOMPLETE';
  if (deterministic === 'PASSED') {
    return ({PASSED:'PASSED', FAILED:'UNKNOWN', UNKNOWN:'UNKNOWN', TECHNICAL_FAILED:'TECHNICAL_FAILED', NOT_RUN:'INCOMPLETE'})[semantic] || invalid();
  }
  return invalid();
}
function invalid() { throw Object.assign(new Error('INVALID_OUTCOME'), {code:'INVALID_OUTCOME'}); }
function normalized(record) {
  if (!record || !['attemptId','slotId','runId','validationRunId'].every((key) => typeof record[key] === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(record[key]))
      || record.slotId.length > 36 || !Number.isInteger(record.ordinalInRun) || record.ordinalInRun < 1 || record.ordinalInRun > 2
      || !Array.isArray(record.failureCodes) || record.failureCodes.length > 20 || record.failureCodes.some((code) => typeof code !== 'string' || !/^[A-Z0-9_]{1,64}$/.test(code))
      || !Number.isFinite(Date.parse(record.generatedAt)) || !Number.isFinite(Date.parse(record.evaluatedAt))
      || (record.modelId != null && !/^[A-Za-z0-9_.:/-]{1,128}$/.test(String(record.modelId)))
      || (record.configVersion != null && !/^[A-Za-z0-9_.:-]{1,64}$/.test(String(record.configVersion)))
      || (record.guidelinesVersion != null && !/^[A-Za-z0-9_.:-]{1,64}$/.test(String(record.guidelinesVersion)))) invalid();
  const outcome = aggregateOutcome(record);
  if (record.outcome !== outcome) invalid();
  return {attemptId:record.attemptId,slotId:record.slotId,runId:record.runId,validationRunId:record.validationRunId,ordinalInRun:record.ordinalInRun,outcome,
    deterministic:record.deterministic,semantic:record.semantic,failureCodes:[...new Set(record.failureCodes)].sort(),
    modelId:record.modelId == null ? null : String(record.modelId),configVersion:record.configVersion == null ? null : String(record.configVersion),
    guidelinesVersion:record.guidelinesVersion == null ? null : String(record.guidelinesVersion),generatedAt:new Date(record.generatedAt).toISOString(),evaluatedAt:new Date(record.evaluatedAt).toISOString()};
}
function outcomeFingerprint(record) { return createHash('sha256').update(JSON.stringify(normalized(record))).digest('hex'); }
function createOutcomeStore(pool) {
  async function record(value) {
    const v = normalized(value); const fingerprint = outcomeFingerprint(v);
    try {
      await pool.execute('INSERT INTO validation_outcome_observations (attempt_id,slot_id,run_id,validation_run_id,ordinal_in_run,outcome,deterministic_outcome,semantic_outcome,failure_codes,model_id,config_version,guidelines_version,generated_at,evaluated_at,fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [v.attemptId,v.slotId,v.runId,v.validationRunId,v.ordinalInRun,v.outcome,v.deterministic,v.semantic,JSON.stringify(v.failureCodes),v.modelId,v.configVersion,v.guidelinesVersion,v.generatedAt.slice(0,23).replace('T',' '),v.evaluatedAt.slice(0,23).replace('T',' '),fingerprint]);
      return {status:'captured'};
    } catch (err) {
      if (err.code !== 'ER_DUP_ENTRY') throw err;
      const [rows] = await pool.execute('SELECT fingerprint FROM validation_outcome_observations WHERE attempt_id=?', [v.attemptId]);
      if (rows.length === 1 && rows[0].fingerprint === fingerprint) return {status:'duplicate'};
      throw Object.assign(new Error('OUTCOME_CONFLICT'), {code:'OUTCOME_CONFLICT'});
    }
  }
  return {record};
}
module.exports = {aggregateOutcome, outcomeFingerprint, createOutcomeStore};
