'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const enabled=process.env.NODE_ENV==='test' && process.env.DB_NAME==='merzz_test' && ['localhost','127.0.0.1','::1'].includes(process.env.DB_HOST) && process.env.ALLOW_DESTRUCTIVE_DB_TESTS==='true';

test('outcome observations are idempotent and conflict-safe on isolated MySQL', {skip:!enabled}, async()=>{
  const {loadEnv}=require('../src/config'); const {createPool}=require('../src/db'); const {runMigrations}=require('../src/migrate');
  const {createOutcomeStore}=require('../src/validation-outcomes');
  const pool=createPool(loadEnv()); const slotId=randomUUID();
  try {
    await runMigrations(pool);
    await pool.execute("INSERT INTO slots (id,scheduled_at,status) VALUES (?,?,'failed')",[slotId,new Date()]);
    const store=createOutcomeStore(pool);
    const record={attemptId:randomUUID(),slotId,runId:randomUUID(),validationRunId:randomUUID(),ordinalInRun:1,outcome:'PASSED',deterministic:'PASSED',semantic:'PASSED',failureCodes:[],generatedAt:'2026-11-10T00:00:00.000Z',evaluatedAt:'2026-11-10T00:00:01.000Z',modelId:'test/model',configVersion:'1',guidelinesVersion:null};
    const duplicate=await Promise.all([store.record(record),store.record(record)]);
    assert.deepEqual(duplicate.map((result)=>result.status).sort(),['captured','duplicate']);
    await assert.rejects(store.record({...record,semantic:'UNKNOWN',outcome:'UNKNOWN'}),{code:'OUTCOME_CONFLICT'});
    await assert.rejects(store.record({...record,attemptId:randomUUID()}),{code:'OUTCOME_CONFLICT'});
    const failed={...record,attemptId:randomUUID(),validationRunId:randomUUID(),ordinalInRun:2,outcome:'CONTEXTUAL_FAILED',deterministic:'FAILED',semantic:'NOT_RUN',failureCodes:['FORBIDDEN_CLAIM','UNAPPROVED_NUMBER']};
    assert.equal((await store.record(failed)).status,'captured');
    await assert.rejects(store.record({...record,attemptId:randomUUID(),ordinalInRun:2,semantic:'NOT_RUN',outcome:'PASSED'}),{code:'INVALID_OUTCOME'});
    const [rows]=await pool.execute('SELECT attempt_id,ordinal_in_run,outcome,semantic_outcome,validation_run_id,failure_codes FROM validation_outcome_observations WHERE slot_id=? ORDER BY ordinal_in_run',[slotId]);
    assert.equal(rows.length,2); assert.equal(rows[0].outcome,'PASSED'); assert.equal(rows[0].semantic_outcome,'PASSED');
    assert.equal(rows[1].outcome,'CONTEXTUAL_FAILED'); assert.equal(rows[1].validation_run_id,failed.validationRunId);
  } finally {
    await pool.execute('DELETE FROM validation_outcome_observations WHERE slot_id=?',[slotId]);
    await pool.execute('DELETE FROM slots WHERE id=?',[slotId]); await pool.end();
  }
});
