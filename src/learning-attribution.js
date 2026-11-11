'use strict';

const { isDeepStrictEqual } = require('node:util');

const dbBoolean = (value) => (Buffer.isBuffer(value) || value instanceof Uint8Array)
  ? value.length === 1 && value[0] === 1
  : value === true || value === 1 || value === '1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRANSIENT_CONNECTION_ERRORS = new Set([
  'ECONNRESET','ECONNREFUSED','EPIPE','ETIMEDOUT','EHOSTUNREACH','ENETUNREACH','EAI_AGAIN',
  'PROTOCOL_CONNECTION_LOST','PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR','PROTOCOL_SEQUENCE_TIMEOUT',
  'ER_SERVER_SHUTDOWN','ER_CONNECTION_KILLED',
]);
const boundedText = (value, max) => value == null || ((typeof value === 'string' || (Number.isSafeInteger(value) && value >= 0)) && String(value).length <= max);
const safeJson = (value, maxBytes) => {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) throw Object.assign(new Error('LEARNING_SNAPSHOT_TOO_LARGE'), { code: 'LEARNING_SNAPSHOT_TOO_LARGE' });
  return serialized;
};
const parseJson = (value) => typeof value === 'string' ? JSON.parse(value) : value;

function validateSnapshot(snapshot) {
  if (!snapshot || !UUID.test(snapshot.attemptId || '') || !UUID.test(snapshot.slotId || '')
    || !boundedText(snapshot.modelId, 128) || !boundedText(snapshot.configurationVersion, 64)
    || !/^(?:all|account|topup)$/.test(snapshot.productCategory || '')
    || !/^(?:all|education|community|gamer_observation|relatable_situation|brand_awareness|trust)$/.test(snapshot.contentTopic || '')
    || typeof snapshot.learningActivationEnabled !== 'boolean'
    || typeof snapshot.learningRetrievalEnabled !== 'boolean'
    || typeof snapshot.promptIntegrationEnabled !== 'boolean'
    || !Array.isArray(snapshot.factsVersions) || snapshot.factsVersions.length > 100
    || !Array.isArray(snapshot.appliedRules) || snapshot.appliedRules.length > 10
    || !Array.isArray(snapshot.omittedRules) || snapshot.omittedRules.length > 50
    || !snapshot.retrievalContext || typeof snapshot.retrievalContext !== 'object' || Array.isArray(snapshot.retrievalContext)) {
    throw Object.assign(new Error('INVALID_LEARNING_SNAPSHOT'), { code: 'INVALID_LEARNING_SNAPSHOT' });
  }
  for (const rule of snapshot.appliedRules) {
    if (!rule || !/^[1-9]\d{0,19}$/.test(String(rule.id)) || !Number.isSafeInteger(Number(rule.version)) || Number(rule.version) < 1
      || typeof rule.instruction !== 'string' || rule.instruction.length > 1000) {
      throw Object.assign(new Error('INVALID_LEARNING_SNAPSHOT'), { code: 'INVALID_LEARNING_SNAPSHOT' });
    }
  }
}

function createLearningAttributionStore(pool) {
  if (!pool || typeof pool.execute !== 'function') throw new TypeError('pool.execute is required');

  async function recordGenerationSnapshot(snapshot) {
    validateSnapshot(snapshot);
    const serialized = {
      factsVersions: safeJson(snapshot.factsVersions, 12000),
      appliedRules: safeJson(snapshot.appliedRules, 12000),
      omittedRules: safeJson(snapshot.omittedRules, 12000),
      retrievalContext: safeJson(snapshot.retrievalContext, 6000),
    };
    try {
      await pool.execute(`INSERT INTO generation_learning_snapshots
        (attempt_id,slot_id,model_id,configuration_version,product_category,content_topic,learning_activation_enabled,learning_retrieval_enabled,prompt_integration_enabled,facts_version_json,applied_rules_json,omitted_rules_json,retrieval_context_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [snapshot.attemptId,snapshot.slotId,snapshot.modelId || null,snapshot.configurationVersion == null ? null : String(snapshot.configurationVersion),
        snapshot.productCategory,snapshot.contentTopic,snapshot.learningActivationEnabled,snapshot.learningRetrievalEnabled,snapshot.promptIntegrationEnabled,
        serialized.factsVersions,serialized.appliedRules,serialized.omittedRules,serialized.retrievalContext]);
      return { status: 'recorded' };
    } catch (error) {
      let row;
      try {
        const [rows] = await pool.execute(`SELECT slot_id,model_id,configuration_version,product_category,content_topic,
          learning_activation_enabled,learning_retrieval_enabled,prompt_integration_enabled,facts_version_json,applied_rules_json,omitted_rules_json,retrieval_context_json
          FROM generation_learning_snapshots WHERE attempt_id=?`, [snapshot.attemptId]);
        row = rows[0];
      } catch (reconciliationError) {
        if (error.code === 'ER_DUP_ENTRY') throw reconciliationError;
        throw Object.assign(new Error('LEARNING_SNAPSHOT_OUTCOME_UNKNOWN'), {
          code: 'LEARNING_SNAPSHOT_OUTCOME_UNKNOWN', cause: error,
        });
      }
      if (!row && error.code !== 'ER_DUP_ENTRY') {
        if (TRANSIENT_CONNECTION_ERRORS.has(error.code) || /^PROTOCOL_/.test(error.code || '')) {
          throw Object.assign(new Error('LEARNING_SNAPSHOT_OUTCOME_UNKNOWN'), {
            code: 'LEARNING_SNAPSHOT_OUTCOME_UNKNOWN', cause: error,
          });
        }
        throw error;
      }
      const same = row && row.slot_id === snapshot.slotId && row.model_id === (snapshot.modelId || null)
        && row.configuration_version === (snapshot.configurationVersion == null ? null : String(snapshot.configurationVersion)) && row.product_category === snapshot.productCategory
        && row.content_topic === snapshot.contentTopic && dbBoolean(row.learning_activation_enabled) === snapshot.learningActivationEnabled
        && dbBoolean(row.learning_retrieval_enabled) === snapshot.learningRetrievalEnabled && dbBoolean(row.prompt_integration_enabled) === snapshot.promptIntegrationEnabled
        && isDeepStrictEqual(parseJson(row.facts_version_json), JSON.parse(serialized.factsVersions))
        && isDeepStrictEqual(parseJson(row.applied_rules_json), JSON.parse(serialized.appliedRules))
        && isDeepStrictEqual(parseJson(row.omitted_rules_json), JSON.parse(serialized.omittedRules))
        && isDeepStrictEqual(parseJson(row.retrieval_context_json), JSON.parse(serialized.retrievalContext));
      if (!same) throw Object.assign(new Error('LEARNING_SNAPSHOT_CONFLICT'), { code: 'LEARNING_SNAPSHOT_CONFLICT' });
      return { status: 'duplicate' };
    }
  }

  return { recordGenerationSnapshot };
}

module.exports = { createLearningAttributionStore, validateSnapshot };
