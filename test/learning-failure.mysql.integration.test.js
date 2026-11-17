'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const mysql = require('mysql2/promise');
const enabled = process.env.NODE_ENV === 'test' && process.env.DB_NAME === 'merzz_test' && ['localhost','127.0.0.1','::1'].includes(process.env.DB_HOST) && process.env.ALLOW_DESTRUCTIVE_DB_TESTS === 'true';

test('isolated MySQL failure and ambiguity exercises', {skip:!enabled}, async (t) => {
  const { createPool } = require('../src/db');
  const { loadEnv } = require('../src/config');
  const { runMigrations } = require('../src/migrate');
  const { createLearningStore } = require('../src/learning');
  const { sanitizeEvidence } = require('../src/learning-evidence');
  const pool = createPool(loadEnv());
  const slotIds = [randomUUID(),randomUUID()];
  try {
    await runMigrations(pool);
    for (let i=0;i<slotIds.length;i++) await pool.execute("INSERT INTO slots (id,scheduled_at,status) VALUES (?,?,'failed')",[slotIds[i],new Date(Date.now()+i*1000)]);
    await t.test('destroying the connection before commit rolls back its transaction', async () => {
      const conn = await pool.getConnection();
      await conn.beginTransaction();
      await conn.execute("UPDATE slots SET error_code='p0_uncommitted' WHERE id=?",[slotIds[0]]);
      conn.destroy();
      const [[row]] = await pool.execute('SELECT error_code FROM slots WHERE id=?',[slotIds[0]]);
      assert.notEqual(row.error_code,'p0_uncommitted');
    });
    await t.test('a committed event with simulated lost commit response is verified by idempotent replay', async () => {
      const event = {eventId:randomUUID(),slotId:slotIds[0],attemptId:randomUUID(),validationRunId:randomUUID(),findingId:'FORBIDDEN_CLAIM',category:'FORBIDDEN_CLAIM',classificationStatus:'contextual',stage:'deterministic',eventTime:new Date().toISOString(),scope:'global',evidence:sanitizeEvidence('Contoh aman.')};
      const uncertainPool = {getConnection: async () => {
        const conn = await pool.getConnection();
        return new Proxy(conn,{get(target,key){
          if (key === 'commit') return async () => { await target.commit(); throw new Error('simulated lost commit response'); };
          return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
        }});
      }};
      await assert.rejects(createLearningStore(uncertainPool).captureFailure(event),/simulated lost commit response/);
      assert.equal((await createLearningStore(pool).captureFailure(event)).status,'deduplicated');
      const [[row]] = await pool.execute('SELECT COUNT(*) AS n, COUNT(candidate_id) AS c FROM learning_capture_events WHERE event_id=?',[event.eventId]);
      assert.equal(Number(row.n),1); assert.equal(Number(row.c),1);
    });
    await t.test('real InnoDB deadlock aborts one transaction without losing committed data', async () => {
      const one = await pool.getConnection(); const two = await pool.getConnection();
      try {
        await one.beginTransaction(); await two.beginTransaction();
        await one.execute("UPDATE slots SET error_code='p0_a' WHERE id=?",[slotIds[0]]);
        await two.execute("UPDATE slots SET error_code='p0_b' WHERE id=?",[slotIds[1]]);
        const first = one.execute("UPDATE slots SET error_code='p0_a' WHERE id=?",[slotIds[1]]);
        await new Promise((resolve)=>setTimeout(resolve,50));
        const second = two.execute("UPDATE slots SET error_code='p0_b' WHERE id=?",[slotIds[0]]);
        const results = await Promise.allSettled([first,second]);
        assert.equal(results.filter((r)=>r.status==='rejected' && r.reason.code==='ER_LOCK_DEADLOCK').length,1);
        await one.rollback(); await two.rollback();
      } finally { one.release(); two.release(); }
    });
    await t.test('saturated separate capture pool does not prevent a publisher pool query', async () => {
      const db = loadEnv().db;
      const isolated = mysql.createPool({...db,connectionLimit:1,waitForConnections:true,queueLimit:1});
      try {
        const conn = await isolated.getConnection();
        const waiting = isolated.getConnection();
        await assert.rejects(isolated.getConnection(),/Queue limit reached/);
        const [[row]] = await pool.query('SELECT 1 AS ok');
        assert.equal(Number(row.ok),1);
        conn.release(); (await waiting).release();
      } finally { await isolated.end(); }
    });
    await t.test('real InnoDB lock wait timeout is bounded and transaction remains controllable', async () => {
      const owner = await pool.getConnection(); const waiter = await pool.getConnection();
      try {
        await owner.beginTransaction(); await waiter.beginTransaction();
        await waiter.query('SET SESSION innodb_lock_wait_timeout=1');
        await owner.execute("UPDATE slots SET error_code='p0_lock' WHERE id=?",[slotIds[0]]);
        await assert.rejects(waiter.execute("UPDATE slots SET error_code='p0_wait' WHERE id=?",[slotIds[0]]),{code:'ER_LOCK_WAIT_TIMEOUT'});
        await waiter.rollback(); await owner.rollback();
      } finally { await waiter.query('SET SESSION innodb_lock_wait_timeout=DEFAULT'); owner.release(); waiter.release(); }
    });
  } finally {
    await pool.execute('DELETE FROM learning_capture_events WHERE slot_id IN (?,?)',slotIds);
    await pool.execute('DELETE FROM learning_candidates WHERE slot_id IN (?,?)',slotIds);
    await pool.execute('DELETE FROM slots WHERE id IN (?,?)',slotIds);
    await pool.end();
  }
});
