'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID,createHash } = require('node:crypto');
const enabled = process.env.NODE_ENV === 'test' && process.env.DB_NAME === 'merzz_test' && ['localhost','127.0.0.1','::1'].includes(process.env.DB_HOST) && process.env.ALLOW_DESTRUCTIVE_DB_TESTS === 'true';

test('retention expires only bounded old evidence and keeps review records on MySQL', {skip:!enabled}, async () => {
  const {loadEnv} = require('../src/config');
  const {createPool} = require('../src/db');
  const {runMigrations} = require('../src/migrate');
  const {createLearningStore} = require('../src/learning');
  const {sanitizeEvidence} = require('../src/learning-evidence');
  const {purgeExpiredEvidence} = require('../src/learning-retention');
  const pool=createPool(loadEnv());
  const slot=randomUUID(); const email=`retention-${randomUUID()}@example.test`; let adminId;
  const now=new Date('2026-11-10T00:00:00.000Z');
  try {
    await runMigrations(pool);
    const [admin]=await pool.execute('INSERT INTO admins (email,password_hash) VALUES (?,?)',[email,'test-only']); adminId=admin.insertId;
    await pool.execute("INSERT INTO slots (id,scheduled_at,status) VALUES (?,?,'failed')",[slot,new Date('2026-11-09T00:00:00Z')]);
    const store=createLearningStore(pool); const ids=[];
    for (let i=0;i<4;i++) {
      const event={eventId:randomUUID(),slotId:slot,attemptId:randomUUID(),validationRunId:randomUUID(),findingId:'FORBIDDEN_CLAIM',category:'FORBIDDEN_CLAIM',classificationStatus:'contextual',stage:'deterministic',eventTime:i<3?'2026-09-01T00:00:00Z':'2026-11-09T00:00:00Z',scope:'global',evidence:sanitizeEvidence(`Bukti percobaan ${i}`)};
      await store.captureFailure(event); ids.push(event.eventId);
      // Synthetic pre-policy records simulate historical evidence for cleanup.
      await pool.execute("UPDATE learning_capture_events e JOIN learning_candidates c ON c.id=e.candidate_id SET e.evidence_status='available',e.evidence_reason=NULL,e.evidence_fingerprint=?,c.caption_excerpt='historic excerpt' WHERE e.event_id=?",['a'.repeat(64),event.eventId]);
    }
    const [[candidate]]=await pool.execute('SELECT candidate_id AS id FROM learning_capture_events WHERE event_id=?',[ids[0]]);
    await store.decide(candidate.id,{version:1,decision:'approved',instruction:'Gunakan pembukaan yang berbeza untuk uji retensi.',scope:'global'},adminId);
    const key=createHash('sha256').update(randomUUID()).digest('hex');
    await pool.execute("INSERT INTO learning_candidates (slot_id,event_key,source,category,caption_excerpt,created_at) VALUES (?,?,'validation','legacy','legacy evidence','2026-09-01 00:00:00')",[slot,key]);
    const failingPool={getConnection:async()=>{
      const connection=await pool.getConnection();
      return new Proxy(connection,{get(target,key){
        if(key==='execute') return (sql,args)=>sql.startsWith('UPDATE learning_capture_events') ? Promise.reject(new Error('simulated cleanup interruption')) : target.execute(sql,args);
        return typeof target[key]==='function' ? target[key].bind(target) : target[key];
      }});
    }};
    await assert.rejects(purgeExpiredEvidence({pool:failingPool,retentionDays:30,batchSize:2,now}),/simulated cleanup interruption/);
    const [[beforeRetry]]=await pool.execute('SELECT caption_excerpt FROM learning_candidates WHERE id=?',[candidate.id]);
    assert.equal(beforeRetry.caption_excerpt,'historic excerpt');
    const first=await purgeExpiredEvidence({pool,retentionDays:30,batchSize:2,now});
    assert.equal(first.events,2); assert.equal(first.legacyCandidates,1);
    assert.equal(first.expiredEventBacklog,1); assert.equal(first.expiredLegacyBacklog,0);
    assert.ok(first.oldestExpiredAgeMs>0);
    const second=await purgeExpiredEvidence({pool,retentionDays:30,batchSize:2,now});
    assert.equal(second.events,1); assert.equal(second.legacyCandidates,0);
    assert.equal(second.expiredEventBacklog,0); assert.equal(second.expiredLegacyBacklog,0);
    const third=await purgeExpiredEvidence({pool,retentionDays:30,batchSize:2,now});
    assert.equal(third.events,0); assert.equal(third.legacyCandidates,0);
    const [rows]=await pool.execute('SELECT event_id,evidence_status,evidence_reason,evidence_fingerprint FROM learning_capture_events WHERE slot_id=?',[slot]);
    assert.equal(rows.filter((row)=>row.evidence_reason==='retention_expired' && row.evidence_fingerprint===null).length,3);
    assert.equal(rows.find((row)=>row.event_id===ids[3]).evidence_status,'available');
    const [[rule]]=await pool.execute('SELECT COUNT(*) AS n FROM learning_rules WHERE candidate_id=?',[candidate.id]);
    const [[review]]=await pool.execute('SELECT COUNT(*) AS n FROM learning_reviews WHERE candidate_id=?',[candidate.id]);
    assert.equal(Number(rule.n),1); assert.equal(Number(review.n),1);
    const [[legacy]]=await pool.execute('SELECT caption_excerpt FROM learning_candidates WHERE event_key=?',[key]);
    assert.equal(legacy.caption_excerpt,'');
  } finally {
    try {
      await pool.execute('DELETE FROM learning_capture_events WHERE slot_id=?',[slot]);
      await pool.execute('DELETE a FROM learning_rule_actions a JOIN learning_rules lr ON lr.id=a.rule_id JOIN learning_candidates c ON c.id=lr.candidate_id WHERE c.slot_id=?',[slot]);
      await pool.execute('DELETE a FROM learning_rule_active_versions a JOIN learning_rules lr ON lr.id=a.rule_id JOIN learning_candidates c ON c.id=lr.candidate_id WHERE c.slot_id=?',[slot]);
      await pool.execute('DELETE a FROM learning_rule_supersessions a JOIN learning_rules lr ON lr.id=a.rule_id JOIN learning_candidates c ON c.id=lr.candidate_id WHERE c.slot_id=?',[slot]);
      await pool.execute('DELETE a FROM learning_rule_version_decisions a JOIN learning_rules lr ON lr.id=a.rule_id JOIN learning_candidates c ON c.id=lr.candidate_id WHERE c.slot_id=?',[slot]);
      await pool.execute('DELETE a FROM learning_rule_versions a JOIN learning_rules lr ON lr.id=a.rule_id JOIN learning_candidates c ON c.id=lr.candidate_id WHERE c.slot_id=?',[slot]);
      await pool.execute('DELETE r FROM learning_reviews r JOIN learning_candidates c ON c.id=r.candidate_id WHERE c.slot_id=?',[slot]);
      await pool.execute('DELETE r FROM learning_rules r JOIN learning_candidates c ON c.id=r.candidate_id WHERE c.slot_id=?',[slot]);
      await pool.execute('DELETE FROM learning_candidates WHERE slot_id=?',[slot]);
      await pool.execute('DELETE FROM slots WHERE id=?',[slot]);
      if(adminId) await pool.execute('DELETE FROM admins WHERE id=?',[adminId]);
    } finally { await pool.end(); }
  }
});
