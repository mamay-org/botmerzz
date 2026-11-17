'use strict';

const { createHash } = require('node:crypto');
const { validateSettings } = require('./policy');
const { buildContentContext } = require('./content-context');
const { generatePost, TOPIC_IDS, VALIDATION_CONTRACT_VERSION } = require('./content-service');
const { createLearningShadowEvaluator } = require('./learning-shadow');
const { policyConflicts, overlapConflict } = require('./learning');
const { isSafeModelId } = require('./learning-shadow');

function executionError(code, status = 400) {
  return Object.assign(new Error(code), { code, status });
}

function approvedForContext(rule, productCategory, contentTopic) {
  return (rule.productCategory === 'all' || rule.productCategory === productCategory)
    && (rule.contentTopic === 'all' || rule.contentTopic === contentTopic);
}

function publishedHistory(history = []) {
  return history.filter((post) => post && post.status === 'published' && typeof post.caption === 'string')
    .sort((a, b) => (Date.parse(b.completedAt || b.scheduledAt || b.createdAt) || 0) - (Date.parse(a.completedAt || a.scheduledAt || a.createdAt) || 0))
    .slice(0, 20)
    .map((post) => ({
      id: post.id == null ? null : String(post.id), status: 'published', pillar: post.pillar || null,
      caption: post.caption.slice(0, 500), factBearing: post.factBearing === true,
      completedAt: post.completedAt || null, scheduledAt: post.scheduledAt || null, createdAt: post.createdAt || null,
    }));
}

function createLearningShadowExecutionService({
  store,
  repository,
  configuration,
  learningStore,
  providerForModel,
  generatorSampling = {},
  generatePostImpl = generatePost,
  clock = () => new Date(),
} = {}) {
  if (!store || !repository || !configuration || !learningStore
    || typeof learningStore.getApprovedRuleVersions !== 'function'
    || typeof providerForModel !== 'function' || typeof generatePostImpl !== 'function') {
    throw new TypeError('shadow execution dependencies are required');
  }
  let running = false;
  let stopping = false;
  const shutdownController = new AbortController();

  async function evaluate({ actorId, ruleIds, samples = 1 } = {}) {
    if (stopping) throw executionError('SHADOW_SHUTTING_DOWN', 503);
    if (running) throw executionError('SHADOW_BUSY', 409);
    if (!Number.isSafeInteger(Number(actorId)) || Number(actorId) < 1 || !Array.isArray(ruleIds)
      || ruleIds.length < 1 || ruleIds.length > 5 || ruleIds.some((id) => !/^[1-9]\d{0,19}$/.test(String(id)))
      || new Set(ruleIds.map(String)).size !== ruleIds.length || !Number.isInteger(samples) || samples < 1 || samples > 3) {
      throw executionError('INVALID_SHADOW_REQUEST');
    }
    running = true;
    try {
      const [activeConfiguration, runtime] = await Promise.all([configuration.getActive(), repository.getRuntimeState()]);
      const modelId = activeConfiguration?.model;
      if (!isSafeModelId(modelId)) throw executionError('SHADOW_MODEL_UNAVAILABLE', 503);
      const checked = validateSettings(runtime?.settings || {});
      if (!checked.valid) throw executionError('SHADOW_CONTEXT_UNAVAILABLE', 503);
      const timestamp = clock();
      if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) throw executionError('SHADOW_CONTEXT_UNAVAILABLE', 503);
      const scenario = {
        settings: checked.settings,
        facts: Array.isArray(runtime.facts) ? runtime.facts.slice(0, 100) : [],
        history: publishedHistory(runtime.history),
        now: timestamp,
      };
      const source = buildContentContext(scenario, checked.settings);
      const contentTopic = TOPIC_IDS[source.creativeDirection?.suggestedTheme] || 'all';
      const storedRules = await learningStore.getApprovedRuleVersions(ruleIds);
      if (!Array.isArray(storedRules) || storedRules.length !== ruleIds.length) throw executionError('APPROVED_RULES_REQUIRED', 409);
      const rules = storedRules.map((rule) => ({
        id: String(rule.id), version: Number(rule.version), instruction: rule.instruction,
        productCategory: rule.productCategory, contentTopic: rule.contentTopic, approved: rule.decision === 'approved',
      }));
      if (rules.some((rule) => rule.approved !== true)) throw executionError('APPROVED_RULES_REQUIRED', 409);
      if (rules.some((rule) => !approvedForContext(rule, source.pillar, contentTopic))) throw executionError('RULE_SCOPE_MISMATCH', 409);
      const policy = {
        contentDirection: source.brand?.contentDirection || '',
        forbiddenClaims: source.forbiddenClaims,
        approvedFacts: JSON.stringify(source.facts),
      };
      for (const rule of rules) if (policyConflicts(rule, policy).length) throw executionError('RULE_CONFLICT', 409);
      for (let left = 0; left < rules.length; left++) for (let right = left + 1; right < rules.length; right++) {
        if (overlapConflict(rules[left], rules[right])) throw executionError('RULE_CONFLICT', 409);
      }
      const provider = await providerForModel(modelId);
      const providerGenerate = typeof provider === 'function' ? provider : provider?.generate;
      if (typeof providerGenerate !== 'function') throw executionError('SHADOW_PROVIDER_UNAVAILABLE', 503);
      const runVariant = async ({ scenario: pairedScenario, sampling, rules: variantRules, generate }) => {
        const result = await generatePostImpl(pairedScenario, {
          generate, generatorSampling: sampling, maxAttempts: 1,
          maxGenerationTokens: 700, maxAuditTokens: 300,
          executionMode: 'shadow', learningRules: variantRules,
          learningFlags: { activationEnabled: true, retrievalEnabled: true, promptIntegrationEnabled: true },
        });
        const passed = result?.status === 'ready' && result?.outcome === 'passed'
          && result?.deterministicOutcome === 'PASSED' && result?.semanticOutcome === 'PASSED';
        return {
          outcome: passed ? 'passed' : result?.outcome || 'incomplete',
          deterministicOutcome: result?.deterministicOutcome || 'NOT_RUN',
          semanticOutcome: result?.semanticOutcome || 'NOT_RUN',
          failureCodes: result?.failureCodes || result?.errors || [],
          validatedOutput: passed,
          ...(passed ? { caption: result.text } : {}),
        };
      };
      const guardedProviderGenerate = (request) => providerGenerate({
        ...request,
        signal: AbortSignal.any([request.signal, shutdownController.signal]),
      });
      const evaluator = createLearningShadowEvaluator({ store, runVariant, providerGenerate: guardedProviderGenerate });
      const factsVersion = source.facts.map((fact) => ({ id: String(fact.id), updatedAt: fact.updatedAt }));
      const brandGuidelinesHash = createHash('sha256').update(JSON.stringify(source.brand || {})).digest('hex');
      const adminGuidelinesHash = createHash('sha256').update(JSON.stringify({ forbiddenClaims: source.forbiddenClaims, hookVocabulary: source.hookVocabulary })).digest('hex');
      return await evaluator.evaluate({
        actorId: String(actorId), modelId, configurationVersion: String(activeConfiguration.version),
        rules, scenario, samples, sampling: generatorSampling,
        retrievalContext: { productCategory: source.pillar, contentTopic, modelId,
          configurationVersion: String(activeConfiguration.version), factsVersion, brandGuidelinesHash, adminGuidelinesHash,
          validationContractVersion: VALIDATION_CONTRACT_VERSION },
      });
    } finally {
      running = false;
    }
  }

  function stop() {
    stopping = true;
    shutdownController.abort();
  }

  return { evaluate, stop };
}

module.exports = { createLearningShadowExecutionService, publishedHistory, approvedForContext };
