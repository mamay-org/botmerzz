'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const enabled = process.env.NODE_ENV === 'test' && process.env.DB_NAME === 'merzz_test_publication_upgrade'
  && ['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST)
  && process.env.ALLOW_DESTRUCTIVE_DB_TESTS === 'true';

test('legacy publishing rows without a verified target can be recovered and closed without enabling post linking', { skip: !enabled }, async () => {
  const { createPool } = require('../src/db');
  const { loadEnv } = require('../src/config');
  const { runMigrations } = require('../src/migrate');
  const { createRepository } = require('../src/repository');
  const pool = createPool(loadEnv());
  const slotIds = [randomUUID(), randomUUID()];
  let actorId;
  try {
    const [[database]] = await pool.query('SELECT DATABASE() AS name, VERSION() AS version');
    assert.equal(database.name, 'merzz_test_publication_upgrade');
    assert.match(database.version, /^8\.4\./);
    await runMigrations(pool);
    const [admin] = await pool.execute('INSERT INTO admins (email,password_hash) VALUES (?,?)', [`legacy-resolution-${randomUUID()}@example.test`, 'test-only-password-hash']);
    actorId = admin.insertId;
    const old = new Date(Date.now() - 10 * 60_000);
    await pool.execute(`INSERT INTO slots (id,scheduled_at,status,provider_status,error_code,publish_started_at,request_payload,idempotency_key,tebar_profile_id,tebar_account_id)
      VALUES (?,?,'publishing','unknown','network_error',?,NULL,NULL,NULL,NULL),
             (?,?,'publishing','unknown','network_error',?,JSON_OBJECT('targets',JSON_ARRAY(JSON_OBJECT('account_id','replacement-account'))),NULL,'original-profile','original-account')`,
      [slotIds[0], new Date(Date.now() - 20_000), old, slotIds[1], new Date(Date.now() - 10_000), old]);

    const repository = createRepository(pool);
    const now = new Date();
    const recovered = await repository.recoverStalePublishing({ now });
    assert.deepEqual([...recovered].sort(), [...slotIds].sort());
    for (const slotId of slotIds) {
      const slot = await repository.getPublicationSlot(slotId);
      assert.equal(slot.status, 'unknown');
      assert.equal(slot.providerPostId, null);
      const request = {
        slotId, requestId: randomUUID(), actorId,
        reason: 'Legacy target cannot be proven; close conservatively.',
        evidenceSummary: 'Old slot has no usable immutable single-account target snapshot.',
      };
      const result = await repository.closeUnknownPublication(request);
      assert.equal(result.newStatus, 'admin_closed_unknown');
      assert.equal(result.providerPostId, null);
      await assert.rejects(repository.linkVerifiedProviderPost({
        ...request, requestId: randomUUID(), providerPostId: `late-${randomUUID()}`,
        profileId: 'original-profile', accountId: 'original-account',
      }), error => error.code === 'PUBLICATION_TARGET_MISMATCH');
      assert.equal((await repository.getPublicationSlot(slotId)).status, 'admin_closed_unknown');
      const [[event]] = await pool.execute('SELECT action,profile_id,account_id FROM publication_resolution_events WHERE slot_id=? ORDER BY id DESC LIMIT 1', [slotId]);
      assert.equal(event.action, 'close_unverified');
    }
    const [[event]] = await pool.execute('SELECT profile_id,account_id FROM publication_resolution_events WHERE slot_id=?', [slotIds[0]]);
    assert.equal(event.profile_id, null);
    assert.equal(event.account_id, null);
  } finally {
    await pool.execute('DELETE FROM publication_resolution_events WHERE slot_id IN (?,?)', slotIds).catch(() => {});
    await pool.execute('DELETE FROM activity_logs WHERE slot_id IN (?,?)', slotIds).catch(() => {});
    await pool.execute('DELETE FROM slots WHERE id IN (?,?)', slotIds).catch(() => {});
    if (actorId) await pool.execute('DELETE FROM admins WHERE id=?', [actorId]).catch(() => {});
    await pool.end();
  }
});
