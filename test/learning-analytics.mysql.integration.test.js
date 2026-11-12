'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const enabled = process.env.NODE_ENV === 'test' && process.env.DB_NAME === 'merzz_test' && ['localhost','127.0.0.1','::1'].includes(process.env.DB_HOST) && process.env.ALLOW_DESTRUCTIVE_DB_TESTS === 'true';

test('three-pillar analytics queries execute against isolated MySQL schema', {skip:!enabled}, async () => {
  const {loadEnv} = require('../src/config');
  const {createPool} = require('../src/db');
  const {runMigrations} = require('../src/migrate');
  const {createLearningAnalytics} = require('../src/learning-analytics');
  const {createLearningStore} = require('../src/learning');
  const pool=createPool(loadEnv());
  const slotId=randomUUID(); const email=`learning-metrics-${randomUUID()}@example.test`; let adminId; let ruleId; let candidateId;
  try {
    await runMigrations(pool);
    const [admin]=await pool.execute('INSERT INTO admins (email,password_hash) VALUES (?,?)',[email,'test-only']); adminId=admin.insertId;
    await pool.execute("INSERT INTO slots (id,scheduled_at,status) VALUES (?,?,'failed')",[slotId,new Date()]);
    const [candidate]=await pool.execute("INSERT INTO learning_candidates (slot_id,event_key,source,category,failure_code) VALUES (?,?,'validation','REPETITIVE_CAPTION','REPETITIVE_CAPTION')",[slotId,randomUUID().replaceAll('-','').padEnd(64,'0')]); candidateId=candidate.insertId;
    const store=createLearningStore(pool,{activationEnabled:true});
    await store.decide(candidate.insertId,{version:1,decision:'approved',instruction:'Gunakan pembukaan yang berbeza.',scope:'global'},adminId);
    const [[rule]]=await pool.execute('SELECT id FROM learning_rules WHERE candidate_id=?',[candidate.insertId]); ruleId=rule.id;
    await store.activateRule(ruleId,{version:1,reason:'Semakan ujian metrik.'},adminId);
    const analytics=createLearningAnalytics(pool);
    // Anchor the exclusive report boundary to the database event itself. CI's
    // runner and MySQL service clocks can differ by a few milliseconds.
    const [[activation]]=await pool.execute("SELECT created_at AS activatedAt FROM learning_rule_actions WHERE rule_id=? AND action='activated' ORDER BY id DESC LIMIT 1",[ruleId]);
    const to=new Date(new Date(activation.activatedAt).getTime()+1000);
    const from=new Date(to.getTime()-30*86400000);
    const [compliance,quality,effectiveness]=await Promise.all([
      analytics.compliance({from,to}),analytics.quality({from,to}),analytics.effectiveness({from,to}),
    ]);
    assert.equal(compliance.definitionVersion,'compliance-v3');
    if (compliance.truncated) {
      assert.equal(compliance.firstPassDenominator,null);
      assert.equal(compliance.firstPassApprovalRate,null);
      assert.equal(compliance.contextualRejectionRate,null);
    } else {
      assert.equal(compliance.firstPassDenominator,compliance.eligibleFirstAttempts-compliance.technicalExclusions);
      assert.equal(compliance.firstPassApprovalRate,compliance.firstPassDenominator?compliance.firstPassSuccesses/compliance.firstPassDenominator:null);
      assert.equal(compliance.contextualRejectionRate,compliance.firstPassDenominator?compliance.contextualFailures/compliance.firstPassDenominator:null);
    }
    assert.ok(['complete','incomplete','insufficient_data'].includes(compliance.status));
    assert.equal(quality.rubricVersion,'1');
    assert.ok(['available','insufficient_data'].includes(quality.status));
    assert.equal(effectiveness.definitionVersion,'effectiveness-v1');
    assert.ok(['observational','insufficient_data'].includes(effectiveness.status));
    assert.equal(effectiveness.causalClaim,false);
    assert.ok(effectiveness.comparisonCount>=1);
    assert.equal(effectiveness.comparisons[0].relevantFailureCategory,'REPETITIVE_CAPTION');
  } finally {
    try {
      if(candidateId) await pool.execute('DELETE FROM learning_reviews WHERE candidate_id=?',[candidateId]);
      if(ruleId) {
        await pool.execute('DELETE FROM learning_rule_actions WHERE rule_id=?',[ruleId]);
        await pool.execute('DELETE FROM learning_rule_active_versions WHERE rule_id=?',[ruleId]);
        await pool.execute('DELETE FROM learning_rule_version_decisions WHERE rule_id=?',[ruleId]);
        await pool.execute('DELETE FROM learning_rule_versions WHERE rule_id=?',[ruleId]);
        await pool.execute('DELETE FROM learning_rules WHERE id=?',[ruleId]);
      }
      if(slotId) { await pool.execute('DELETE FROM learning_candidates WHERE slot_id=?',[slotId]); await pool.execute('DELETE FROM slots WHERE id=?',[slotId]); }
      if(adminId) await pool.execute('DELETE FROM admins WHERE id=?',[adminId]);
    } finally { await pool.end(); }
  }
});
