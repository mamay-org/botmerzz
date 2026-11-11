'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const enabled=process.env.NODE_ENV==='test' && process.env.DB_NAME==='merzz_test' && ['localhost','127.0.0.1','::1'].includes(process.env.DB_HOST) && process.env.ALLOW_DESTRUCTIVE_DB_TESTS==='true';

test('idempotent event replay completes using a single-connection MySQL pool', {skip:!enabled,timeout:5000}, async()=>{
  const {loadEnv}=require('../src/config'); const {createPool}=require('../src/db'); const {runMigrations}=require('../src/migrate');
  const {createLearningStore}=require('../src/learning'); const {sanitizeEvidence}=require('../src/learning-evidence');
  const config=loadEnv(); config.db.connectionLimit=1;
  const pool=createPool(config); const slotId=randomUUID();
  try {
    await runMigrations(pool);
    await pool.execute("INSERT INTO slots (id,scheduled_at,status) VALUES (?,?,'failed')",[slotId,new Date()]);
    const event={eventId:randomUUID(),slotId,attemptId:randomUUID(),validationRunId:randomUUID(),findingId:'FORBIDDEN_CLAIM',category:'FORBIDDEN_CLAIM',classificationStatus:'contextual',stage:'deterministic',eventTime:new Date().toISOString(),scope:'global',evidence:sanitizeEvidence('Contoh aman.')};
    const store=createLearningStore(pool);
    assert.equal((await store.captureFailure(event)).status,'captured');
    assert.equal((await store.captureFailure(event)).status,'deduplicated');
    await assert.rejects(store.captureFailure({...event,attemptId:randomUUID()}),{code:'EVENT_CONFLICT'});
    const [[row]]=await pool.execute('SELECT COUNT(*) AS n FROM learning_capture_events WHERE event_id=?',[event.eventId]);
    assert.equal(Number(row.n),1);
  } finally {
    await pool.execute('DELETE FROM learning_capture_events WHERE slot_id=?',[slotId]);
    await pool.execute('DELETE FROM learning_candidates WHERE slot_id=?',[slotId]);
    await pool.execute('DELETE FROM slots WHERE id=?',[slotId]);
    await pool.end();
  }
});
