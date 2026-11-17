'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLearningAttributionStore } = require('../src/learning-attribution');

const fixture = () => ({
  attemptId: '1e69f490-f88a-491b-9dc7-1fdb38094691',
  slotId: '0f21af50-e043-4077-83f3-67df10a6f4f8',
  modelId: 'test/model',
  configurationVersion: '7',
  productCategory: 'topup',
  contentTopic: 'education',
  learningActivationEnabled: true,
  learningRetrievalEnabled: true,
  promptIntegrationEnabled: true,
  factsVersions: [{ id: 'fact-1', updatedAt: '2026-11-10T00:00:00.000Z' }],
  appliedRules: [{ id: '10', version: 2, instruction: 'Pelbagaikan sudut penerangan.' }],
  omittedRules: [{ ruleId: '11', version: 1, reason: 'prompt_budget' }],
  retrievalContext: { priority: 'specificity', ruleTokens: 24 },
});

test('generation attribution stores immutable execution snapshots and recognizes exact replays', async () => {
  const rows = new Map();
  const pool = { execute: async (sql, args) => {
    if (sql.includes('INSERT INTO generation_learning_snapshots')) {
      const [attemptId,slotId,modelId,configurationVersion,productCategory,contentTopic,activation,retrieval,prompt,facts,applied,omitted,context] = args;
      if (rows.has(attemptId)) throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
      rows.set(attemptId, { slot_id:slotId,model_id:modelId,configuration_version:configurationVersion,product_category:productCategory,
        content_topic:contentTopic,learning_activation_enabled:activation,learning_retrieval_enabled:retrieval,prompt_integration_enabled:prompt,
        facts_version_json:JSON.parse(facts),applied_rules_json:JSON.parse(applied),omitted_rules_json:JSON.parse(omitted),retrieval_context_json:JSON.parse(context) });
      return [{ affectedRows:1 }, []];
    }
    if (sql.includes('FROM generation_learning_snapshots')) return [[rows.get(args[0])], []];
    throw new Error('unexpected SQL');
  } };
  const store = createLearningAttributionStore(pool);
  const snapshot = fixture();
  assert.deepEqual(await store.recordGenerationSnapshot(snapshot), { status:'recorded' });
  assert.deepEqual(await store.recordGenerationSnapshot(snapshot), { status:'duplicate' });
  assert.equal(rows.get(snapshot.attemptId).applied_rules_json[0].version, 2);
});

test('generation attribution rejects conflicting replays and oversized or invalid snapshot data', async () => {
  const store = createLearningAttributionStore({ execute: async (sql, args) => {
    if (sql.includes('INSERT INTO generation_learning_snapshots')) throw Object.assign(new Error('duplicate'), { code:'ER_DUP_ENTRY' });
    return [[{ slot_id:args[0],model_id:'test/model',configuration_version:'7',product_category:'topup',content_topic:'education',
      learning_activation_enabled:1,learning_retrieval_enabled:1,prompt_integration_enabled:1,
      facts_version_json:[{ id:'fact-1',updatedAt:'2026-11-10T00:00:00.000Z' }],applied_rules_json:[],omitted_rules_json:[],retrieval_context_json:{} }], []];
  } });
  await assert.rejects(store.recordGenerationSnapshot(fixture()), { code:'LEARNING_SNAPSHOT_CONFLICT' });
  await assert.rejects(store.recordGenerationSnapshot({ ...fixture(), appliedRules:[{ id:'bad',version:1,instruction:'x' }] }), { code:'INVALID_LEARNING_SNAPSHOT' });
  await assert.rejects(store.recordGenerationSnapshot({ ...fixture(), retrievalContext:{ detail:'x'.repeat(7000) } }), { code:'LEARNING_SNAPSHOT_TOO_LARGE' });
});

test('snapshot insert reconciles a committed write whose acknowledgment was lost', async () => {
  let row;
  let reads=0;
  const pool={execute:async(sql,args)=>{
    if(sql.includes('INSERT INTO generation_learning_snapshots')){
      const [attemptId,slotId,modelId,configurationVersion,productCategory,contentTopic,activation,retrieval,prompt,facts,applied,omitted,context]=args;
      row={slot_id:slotId,model_id:modelId,configuration_version:configurationVersion,product_category:productCategory,content_topic:contentTopic,
        learning_activation_enabled:activation,learning_retrieval_enabled:retrieval,prompt_integration_enabled:prompt,
        facts_version_json:JSON.parse(facts),applied_rules_json:JSON.parse(applied),omitted_rules_json:JSON.parse(omitted),retrieval_context_json:JSON.parse(context)};
      throw Object.assign(new Error('commit acknowledgment lost'),{code:'ECONNRESET'});
    }
    reads++;
    return [[row],[]];
  }};
  assert.deepEqual(await createLearningAttributionStore(pool).recordGenerationSnapshot(fixture()),{status:'duplicate'});
  assert.equal(reads,1);
});

test('snapshot replay parses MySQL false values without treating zero bytes as true', async () => {
  for (const enabled of [false,true]) {
    const snapshot = { ...fixture(), learningActivationEnabled:enabled, learningRetrievalEnabled:enabled, promptIntegrationEnabled:enabled };
    const wireValue = Buffer.from([enabled ? 1 : 0]);
    const pool = { execute:async (sql) => {
      if (sql.includes('INSERT INTO generation_learning_snapshots')) throw Object.assign(new Error('duplicate'), { code:'ER_DUP_ENTRY' });
      return [[{ slot_id:snapshot.slotId,model_id:snapshot.modelId,configuration_version:snapshot.configurationVersion,
        product_category:snapshot.productCategory,content_topic:snapshot.contentTopic,
        learning_activation_enabled:wireValue,learning_retrieval_enabled:wireValue,prompt_integration_enabled:wireValue,
        facts_version_json:snapshot.factsVersions,applied_rules_json:snapshot.appliedRules,omitted_rules_json:snapshot.omittedRules,
        retrieval_context_json:snapshot.retrievalContext }],[]];
    } };
    assert.deepEqual(await createLearningAttributionStore(pool).recordGenerationSnapshot(snapshot),{status:'duplicate'});
  }
});

test('snapshot insert refuses to proceed when an ambiguous commit cannot be reconciled', async () => {
  const pool={execute:async(sql)=>{
    if(sql.includes('INSERT INTO generation_learning_snapshots')) throw Object.assign(new Error('connection lost'),{code:'ECONNRESET'});
    throw Object.assign(new Error('connection unavailable'),{code:'ECONNRESET'});
  }};
  await assert.rejects(createLearningAttributionStore(pool).recordGenerationSnapshot(fixture()),{code:'LEARNING_SNAPSHOT_OUTCOME_UNKNOWN'});
});

test('transient snapshot insert error plus a temporarily missing row remains unknown', async () => {
  const pool={execute:async(sql)=>{
    if(sql.includes('INSERT INTO generation_learning_snapshots')) throw Object.assign(new Error('write connection lost'),{code:'ECONNRESET'});
    return [[],[]];
  }};
  await assert.rejects(createLearningAttributionStore(pool).recordGenerationSnapshot(fixture()),{code:'LEARNING_SNAPSHOT_OUTCOME_UNKNOWN'});
});
