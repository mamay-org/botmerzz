'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const databaseName = 'merzz_test_publication_upgrade';
const enabled = process.env.NODE_ENV === 'test' && process.env.DB_NAME === databaseName
  && ['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST)
  && process.env.ALLOW_DESTRUCTIVE_DB_TESTS === 'true';

function normalizeCheckClause(clause) {
  const normalized = clause.toLowerCase()
    .replace(/`|_utf8mb4/g, '')
    .replace(/\\/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.startsWith('(') && normalized.endsWith(')')
    ? normalized.slice(1, -1)
    : normalized;
}

test('migration 020 upgrades an isolated migration 019 schema and recovers when one table is missing', { skip: !enabled }, async () => {
  const { createPool } = require('../src/db');
  const { loadEnv } = require('../src/config');
  const { runMigrations } = require('../src/migrate');
  const pool = createPool(loadEnv());
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'botmerzz-publication-migrations-'));
  const slotId = randomUUID();
  const requestId = randomUUID();
  const scopeKey = 'a'.repeat(64);
  let slotInserted = false;
  let eventInserted = false;
  let holdInserted = false;
  try {
    const [[database]] = await pool.query('SELECT DATABASE() AS name, VERSION() AS version');
    assert.equal(database.name, databaseName);
    assert.match(database.version, /^8\.4\./);
    const [[tableCount]] = await pool.execute('SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema=DATABASE()');
    assert.equal(Number(tableCount.count), 0, 'publication migration schema must be fresh and disposable');

    const migrationDir = path.resolve(__dirname, '../migrations');
    const migrations = (await fs.readdir(migrationDir))
      .filter(file => /^\d+_[a-zA-Z0-9_-]+\.sql$/.test(file))
      .filter(file => Number(file.slice(0, file.indexOf('_'))) <= 19);
    await Promise.all(migrations.map(file => fs.copyFile(path.join(migrationDir, file), path.join(directory, file))));
    const applied = await runMigrations(pool, { migrationsDir: directory });
    assert.equal(applied.at(-1), '019_learning_shadow_admission.sql');
    assert.ok(!applied.includes('020_manual_publication_resolution.sql'));

    const [[prior]] = await pool.execute("SELECT COUNT(*) AS count FROM schema_migrations WHERE version='019_learning_shadow_admission.sql'");
    const [[migration020]] = await pool.execute("SELECT COUNT(*) AS count FROM schema_migrations WHERE version='020_manual_publication_resolution.sql'");
    assert.equal(Number(prior.count), 1, 'upgrade rehearsal must start at migration 019');
    assert.equal(Number(migration020.count), 0, 'migration 020 must not have been applied before the rehearsal');

    const [[oldStatusCheck]] = await pool.execute(`SELECT COUNT(*) AS count FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='slots' AND CONSTRAINT_NAME='slots_chk_1' AND CONSTRAINT_TYPE='CHECK'`);
    assert.equal(Number(oldStatusCheck.count), 1, 'migration 019 must retain the generated pre-020 status check');
    const [[newStatusCheck]] = await pool.execute(`SELECT COUNT(*) AS count FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='slots' AND CONSTRAINT_NAME='slots_status_allowed' AND CONSTRAINT_TYPE='CHECK'`);
    assert.equal(Number(newStatusCheck.count), 0, 'migration 020 must not exist before the rehearsal');

    await pool.execute("INSERT INTO slots (id,scheduled_at,status) VALUES (?,UTC_TIMESTAMP(3),'unknown')", [slotId]);
    slotInserted = true;
    await assert.rejects(pool.execute('UPDATE slots SET status=? WHERE id=?', ['admin_closed_unknown', slotId]),
      error => error.code === 'ER_CHECK_CONSTRAINT_VIOLATED');

    await fs.copyFile(path.join(migrationDir, '020_manual_publication_resolution.sql'), path.join(directory, '020_manual_publication_resolution.sql'));
    assert.deepEqual(await runMigrations(pool, { migrationsDir: directory }), ['020_manual_publication_resolution.sql']);
    assert.deepEqual(await runMigrations(pool, { migrationsDir: directory }), []);

    // Preserve the event table while removing the later table to model a committed partial DDL state.
    await pool.query('DROP TABLE automation_provider_holds');
    await pool.execute("DELETE FROM schema_migrations WHERE version='020_manual_publication_resolution.sql'");
    assert.deepEqual(await runMigrations(pool, { migrationsDir: directory }), ['020_manual_publication_resolution.sql']);

    // The complete DDL is also safe to repeat when the version ledger write was lost.
    await pool.execute("DELETE FROM schema_migrations WHERE version='020_manual_publication_resolution.sql'");
    assert.deepEqual(await runMigrations(pool, { migrationsDir: directory }), ['020_manual_publication_resolution.sql']);

    const [[statusCheck]] = await pool.execute(`SELECT cc.CHECK_CLAUSE, tc.ENFORCED
      FROM information_schema.CHECK_CONSTRAINTS cc
      JOIN information_schema.TABLE_CONSTRAINTS tc ON tc.CONSTRAINT_SCHEMA=cc.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME=cc.CONSTRAINT_NAME
      WHERE tc.TABLE_SCHEMA=DATABASE() AND tc.TABLE_NAME='slots' AND tc.CONSTRAINT_NAME='slots_status_allowed'`);
    const expectedStatuses = ['pending', 'generating', 'ready', 'publishing', 'published', 'partial', 'failed', 'unknown', 'canceled', 'skipped', 'admin_closed_unknown'];
    assert.ok(statusCheck);
    assert.equal(statusCheck.ENFORCED, 'YES');
    assert.equal(normalizeCheckClause(statusCheck.CHECK_CLAUSE), `status in (${expectedStatuses.map(status => `'${status}'`).join(',')})`);
    const [[oldCheckCount]] = await pool.execute(`SELECT COUNT(*) AS count FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='slots' AND CONSTRAINT_NAME='slots_chk_1' AND CONSTRAINT_TYPE='CHECK'`);
    assert.equal(Number(oldCheckCount.count), 0, 'the pre-020 generated check must be removed');
    const [[statusCheckCount]] = await pool.execute(`SELECT COUNT(*) AS count
      FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='slots' AND CONSTRAINT_TYPE='CHECK'`);
    assert.equal(Number(statusCheckCount.count), 1, 'only the replacement status check should remain on slots');
    const [[slotCount]] = await pool.execute('SELECT COUNT(*) AS count FROM slots WHERE id=?', [slotId]);
    assert.equal(Number(slotCount.count), 1, 'the test-owned pre-020 slot must survive the upgrade');
    const [acceptedStatus] = await pool.execute('UPDATE slots SET status=? WHERE id=?', ['admin_closed_unknown', slotId]);
    assert.equal(acceptedStatus.affectedRows, 1, 'the replacement check must allow admin_closed_unknown');
    await pool.execute('UPDATE slots SET status=? WHERE id=?', ['unknown', slotId]);
    await assert.rejects(pool.execute('UPDATE slots SET status=? WHERE id=?', ['invalid', slotId]),
      error => error.code === 'ER_CHECK_CONSTRAINT_VIOLATED');

    const [eventColumns] = await pool.execute(`SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
      FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='publication_resolution_events'
      ORDER BY ORDINAL_POSITION`);
    assert.deepEqual(eventColumns.map(row => [row.COLUMN_NAME, row.COLUMN_TYPE]), [
      ['id', 'bigint unsigned'], ['request_id', 'char(36)'], ['request_hash', 'char(64)'], ['slot_id', 'char(36)'],
      ['action', 'varchar(32)'], ['actor_id', 'bigint unsigned'], ['actor_email', 'varchar(254)'],
      ['previous_status', 'varchar(24)'], ['new_status', 'varchar(24)'], ['reason', 'varchar(1000)'],
      ['evidence_summary', 'varchar(2000)'], ['profile_id', 'varchar(128)'], ['account_id', 'varchar(128)'],
      ['provider_post_id', 'varchar(128)'], ['created_at', 'datetime(3)'],
    ]);
    for (const column of ['id', 'request_id', 'request_hash', 'slot_id', 'action', 'actor_id', 'previous_status', 'new_status', 'reason', 'evidence_summary', 'created_at']) {
      assert.equal(eventColumns.find(row => row.COLUMN_NAME === column).IS_NULLABLE, 'NO', `${column} must be required`);
    }
    assert.equal(eventColumns.find(row => row.COLUMN_NAME === 'profile_id').IS_NULLABLE, 'YES', 'profile_id must allow legacy closure without a target snapshot');
    assert.equal(eventColumns.find(row => row.COLUMN_NAME === 'account_id').IS_NULLABLE, 'YES', 'account_id must allow legacy closure without a target snapshot');

    const [eventIndexes] = await pool.execute(`SELECT INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX, NON_UNIQUE
      FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='publication_resolution_events'
      ORDER BY INDEX_NAME, SEQ_IN_INDEX`);
    assert.deepEqual(eventIndexes.map(row => `${row.INDEX_NAME}:${row.COLUMN_NAME}:${row.SEQ_IN_INDEX}:${row.NON_UNIQUE}`).sort(), [
      'PRIMARY:id:1:0', 'publication_resolution_slot:slot_id:1:1', 'publication_resolution_slot:created_at:2:1', 'request_id:request_id:1:0',
    ].sort());
    const [eventChecks] = await pool.execute(`SELECT cc.CHECK_CLAUSE
      FROM information_schema.CHECK_CONSTRAINTS cc
      JOIN information_schema.TABLE_CONSTRAINTS tc ON tc.CONSTRAINT_SCHEMA=cc.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME=cc.CONSTRAINT_NAME
      WHERE tc.TABLE_SCHEMA=DATABASE() AND tc.TABLE_NAME='publication_resolution_events' AND tc.CONSTRAINT_TYPE='CHECK'`);
    assert.deepEqual(eventChecks.map(row => normalizeCheckClause(row.CHECK_CLAUSE)).sort(), [
      "action in ('close_unverified','link_provider_post')",
      "(action = 'close_unverified') or ((profile_id is not null) and (account_id is not null))",
    ].sort());
    const [eventForeignKeys] = await pool.execute(`SELECT kcu.COLUMN_NAME, kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME, rc.DELETE_RULE
      FROM information_schema.REFERENTIAL_CONSTRAINTS rc
      JOIN information_schema.KEY_COLUMN_USAGE kcu ON kcu.CONSTRAINT_SCHEMA=rc.CONSTRAINT_SCHEMA AND kcu.CONSTRAINT_NAME=rc.CONSTRAINT_NAME
      WHERE rc.CONSTRAINT_SCHEMA=DATABASE() AND kcu.TABLE_NAME='publication_resolution_events'
        AND kcu.REFERENCED_TABLE_NAME IS NOT NULL`);
    assert.deepEqual(eventForeignKeys.map(row => [row.COLUMN_NAME, row.REFERENCED_TABLE_NAME, row.REFERENCED_COLUMN_NAME, row.DELETE_RULE]), [
      ['slot_id', 'slots', 'id', 'RESTRICT'],
    ]);

    const [holdColumns] = await pool.execute(`SELECT COLUMN_NAME, COLUMN_TYPE
      FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='automation_provider_holds'
      ORDER BY ORDINAL_POSITION`);
    assert.deepEqual(holdColumns.map(row => [row.COLUMN_NAME, row.COLUMN_TYPE]), [
      ['provider', 'varchar(32)'], ['scope_key', 'char(64)'], ['profile_id', 'varchar(128)'], ['account_id', 'varchar(128)'],
      ['reason_code', 'varchar(64)'], ['slot_id', 'char(36)'], ['active', 'tinyint(1)'], ['created_at', 'datetime(3)'],
      ['cleared_at', 'datetime(3)'], ['cleared_by', 'bigint unsigned'],
    ]);
    const [holdIndexes] = await pool.execute(`SELECT INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX, NON_UNIQUE
      FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='automation_provider_holds'
      ORDER BY INDEX_NAME, SEQ_IN_INDEX`);
    assert.deepEqual(holdIndexes.map(row => `${row.INDEX_NAME}:${row.COLUMN_NAME}:${row.SEQ_IN_INDEX}:${row.NON_UNIQUE}`).sort(), [
      'PRIMARY:provider:1:0', 'PRIMARY:scope_key:2:0', 'provider_holds_active:active:1:1', 'provider_holds_active:provider:2:1',
    ].sort());
    const [holdChecks] = await pool.execute(`SELECT cc.CHECK_CLAUSE
      FROM information_schema.CHECK_CONSTRAINTS cc
      JOIN information_schema.TABLE_CONSTRAINTS tc ON tc.CONSTRAINT_SCHEMA=cc.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME=cc.CONSTRAINT_NAME
      WHERE tc.TABLE_SCHEMA=DATABASE() AND tc.TABLE_NAME='automation_provider_holds' AND tc.CONSTRAINT_TYPE='CHECK'`);
    assert.deepEqual(holdChecks.map(row => normalizeCheckClause(row.CHECK_CLAUSE)).sort(), [
      "provider in ('openrouter','tebar')",
      "((provider = 'openrouter') and (profile_id is null) and (account_id is null)) or ((provider = 'tebar') and (profile_id is not null) and (account_id is not null))",
    ].sort());
    const [holdForeignKeys] = await pool.execute(`SELECT rc.CONSTRAINT_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS rc
      JOIN information_schema.KEY_COLUMN_USAGE kcu ON kcu.CONSTRAINT_SCHEMA=rc.CONSTRAINT_SCHEMA AND kcu.CONSTRAINT_NAME=rc.CONSTRAINT_NAME
      WHERE rc.CONSTRAINT_SCHEMA=DATABASE() AND kcu.TABLE_NAME='automation_provider_holds' AND kcu.REFERENCED_TABLE_NAME IS NOT NULL`);
    assert.deepEqual(holdForeignKeys, [], 'provider holds must not add database foreign-key dependencies');

    await pool.execute(`INSERT INTO publication_resolution_events
      (request_id,request_hash,slot_id,action,actor_id,previous_status,new_status,reason,evidence_summary,profile_id,account_id)
      VALUES (?,?,?,'close_unverified',1,'unknown','admin_closed_unknown','migration test reason','migration test evidence',NULL,NULL)`,
    [requestId, 'a'.repeat(64), slotId]);
    eventInserted = true;
    const [[closeEvent]] = await pool.execute('SELECT profile_id,account_id FROM publication_resolution_events WHERE request_id=?', [requestId]);
    assert.equal(closeEvent.profile_id, null);
    assert.equal(closeEvent.account_id, null);
    await assert.rejects(pool.execute(`INSERT INTO publication_resolution_events
      (request_id,request_hash,slot_id,action,actor_id,previous_status,new_status,reason,evidence_summary,profile_id,account_id)
      VALUES (?,?,?,'link_provider_post',1,'unknown','published','migration test reason','migration test evidence',NULL,NULL)`,
    [randomUUID(), 'b'.repeat(64), slotId]), error => error.code === 'ER_CHECK_CONSTRAINT_VIOLATED');
    await pool.execute(`INSERT INTO automation_provider_holds
      (provider,scope_key,profile_id,account_id,reason_code,slot_id) VALUES ('tebar',?,?,?,'publication_unknown',?)`,
    [scopeKey, 'migration-profile', 'migration-account', slotId]);
    holdInserted = true;
    await assert.rejects(pool.execute('DELETE FROM slots WHERE id=?', [slotId]), error => error.code === 'ER_ROW_IS_REFERENCED_2');
  } finally {
    if (eventInserted) await pool.execute('DELETE FROM publication_resolution_events WHERE slot_id=?', [slotId]);
    if (holdInserted) await pool.execute('DELETE FROM automation_provider_holds WHERE provider=? AND scope_key=?', ['tebar', scopeKey]);
    if (slotInserted) await pool.execute('DELETE FROM slots WHERE id=?', [slotId]);
    await pool.end();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
