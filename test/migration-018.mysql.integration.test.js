'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const enabled = process.env.NODE_ENV === 'test' && process.env.DB_NAME === 'merzz_test_018' && ['localhost','127.0.0.1','::1'].includes(process.env.DB_HOST) && process.env.ALLOW_DESTRUCTIVE_DB_TESTS === 'true';

test('migration 018 recovers committed DDL and refuses incompatible indexes', { skip: !enabled }, async (t) => {
  const { createPool } = require('../src/db');
  const { loadEnv } = require('../src/config');
  const { runMigrations } = require('../src/migrate');
  const pool = createPool(loadEnv());
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-018-'));
  t.after(async () => { await pool.end(); await fs.rm(dir, { recursive: true, force: true }); });
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema=DATABASE()');
  assert.equal(Number(n), 0, 'requires a fresh disposable database');
  const source = path.resolve(__dirname, '../migrations');
  const files = (await fs.readdir(source)).filter(f => /^\d+_.*\.sql$/.test(f) && f < '018_');
  await Promise.all(files.map(f => fs.copyFile(path.join(source, f), path.join(dir, f))));
  await runMigrations(pool, { migrationsDir: dir });
  const id = randomUUID();
  await pool.execute("INSERT INTO slots (id,scheduled_at,status,caption) VALUES (?,UTC_TIMESTAMP(3),'ready','retained')", [id]);
  await fs.copyFile(path.join(source, '018_learning_quality_analytics_index.sql'), path.join(dir, '018_learning_quality_analytics_index.sql'));
  await pool.query('CREATE INDEX slots_published_completed ON slots (status, completed_at, id)');
  assert.deepEqual(await runMigrations(pool, { migrationsDir: dir }), ['018_learning_quality_analytics_index.sql']);
  assert.deepEqual(await runMigrations(pool, { migrationsDir: dir }), []);
  const [[slot]] = await pool.execute('SELECT caption FROM slots WHERE id=?', [id]);
  assert.equal(slot.caption, 'retained');
  await pool.query("DELETE FROM schema_migrations WHERE version='018_learning_quality_analytics_index.sql'");
  await pool.query('DROP INDEX slots_published_completed ON slots');
  for (const definition of [
    'UNIQUE INDEX slots_published_completed ON slots (status, completed_at, id)',
    'INDEX slots_published_completed ON slots (completed_at, status, id)',
    'INDEX slots_published_completed ON slots (status(3), completed_at, id)',
    'INDEX slots_published_completed ON slots (status DESC, completed_at, id)',
    'INDEX slots_published_completed ON slots (status, completed_at, id) INVISIBLE',
  ]) {
    await pool.query(`CREATE ${definition}`);
    await assert.rejects(runMigrations(pool, { migrationsDir: dir }), e => e.code === 'MIGRATION_018_INDEX_MISMATCH' && /inspect and reconcile manually/.test(e.message));
    const [[history]] = await pool.query("SELECT COUNT(*) AS n FROM schema_migrations WHERE version='018_learning_quality_analytics_index.sql'");
    assert.equal(Number(history.n), 0);
    const [[{ n: indexRows }]] = await pool.query("SELECT COUNT(*) AS n FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='slots' AND index_name='slots_published_completed'");
    assert.equal(Number(indexRows), 3, 'incompatible index remains untouched');
    await pool.query('DROP INDEX slots_published_completed ON slots');
  }
  assert.deepEqual(await runMigrations(pool, { migrationsDir: dir }), ['018_learning_quality_analytics_index.sql']);
  assert.deepEqual(await runMigrations(pool, { migrationsDir: dir }), []);
  const [[retained]] = await pool.execute('SELECT caption FROM slots WHERE id=?', [id]);
  assert.equal(retained.caption, 'retained');
});
