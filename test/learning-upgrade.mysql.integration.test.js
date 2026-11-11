'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const enabled = process.env.NODE_ENV === 'test' && process.env.DB_NAME === 'merzz_test_upgrade' && ['localhost','127.0.0.1','::1'].includes(process.env.DB_HOST) && process.env.ALLOW_DESTRUCTIVE_DB_TESTS === 'true';

test('upgrade from existing 011 records retains legacy evidence as unavailable', {skip:!enabled}, async () => {
  const { loadEnv } = require('../src/config');
  const { createPool } = require('../src/db');
  const { runMigrations } = require('../src/migrate');
  const pool = createPool(loadEnv());
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'botmerzz-migrations-'));
  try {
    const [[{n}]] = await pool.query('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema=DATABASE()');
    assert.equal(Number(n),0,'upgrade test requires a fresh empty merzz_test_upgrade database');
    const migrationDir = path.resolve(__dirname,'../migrations');
    const files = (await fs.readdir(migrationDir)).filter((file) => /^\d+_.*\.sql$/.test(file) && file < '012_');
    await Promise.all(files.map((file) => fs.copyFile(path.join(migrationDir,file),path.join(directory,file))));
    assert.ok((await runMigrations(pool,{migrationsDir:directory})).includes('011_learning_center.sql'));
    const slotId = randomUUID();
    await pool.execute("INSERT INTO slots (id,scheduled_at,status,caption) VALUES (?,?,'ready',?)", [slotId,new Date(),'Later caption']);
    await pool.execute("INSERT INTO learning_candidates (slot_id,event_key,source,category) VALUES (?,?,'validation','legacy')",[slotId,'a'.repeat(64)]);
    await fs.copyFile(path.join(migrationDir,'012_learning_events.sql'),path.join(directory,'012_learning_events.sql'));
    assert.deepEqual(await runMigrations(pool,{migrationsDir:directory}),['012_learning_events.sql']);
    await pool.execute("INSERT INTO learning_capture_events (event_id,slot_id,attempt_id,validation_run_id,finding_id,category,classification_status,validation_stage,event_time,evidence_status) VALUES (?,?,?,?,?,'unresolved','unresolved','semantic',?,'unavailable')",['legacy-event',slotId,'legacy-attempt','legacy-run','UNKNOWN',new Date()]);
    // Simulate a crash after the first DDL statement in migration 014 committed.
    const attemptMigration = await fs.readFile(path.join(migrationDir,'014_generation_attempts.sql'),'utf8');
    await pool.query(attemptMigration.split(';').map((part)=>part.trim()).filter(Boolean)[0]);
    assert.deepEqual(await runMigrations(pool),[
      '013_validation_outcome_observations.sql','014_generation_attempts.sql','015_learning_lifecycle.sql',
      '016_learning_shadow_evaluation.sql','017_generation_learning_snapshots.sql','018_learning_quality_analytics_index.sql',
      '019_learning_shadow_admission.sql',
    ]);
    const [[retained]]=await pool.execute('SELECT COUNT(*) AS n FROM learning_capture_events WHERE event_id=?',['legacy-event']);
    assert.equal(Number(retained.n),1);
    const { createLearningStore } = require('../src/learning');
    const candidates = await createLearningStore(pool).listCandidates('pending');
    const legacy = candidates.find((row) => row.slotId === slotId);
    assert.ok(legacy);
    assert.equal(legacy.caption,null);
    assert.equal(legacy.evidenceStatus,'unavailable');
    assert.equal(legacy.evidenceReason,'legacy_or_missing');
    assert.deepEqual(await runMigrations(pool),[]);
  } finally {
    await pool.end();
    await fs.rm(directory,{recursive:true,force:true});
  }
});
