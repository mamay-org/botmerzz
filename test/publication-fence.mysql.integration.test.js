'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const databaseName = 'merzz_test_publication_upgrade';
const enabled = process.env.NODE_ENV === 'test' && process.env.DB_NAME === databaseName
  && ['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST)
  && process.env.ALLOW_DESTRUCTIVE_DB_TESTS === 'true';

test('MySQL serializes a publish outcome with recovery and admin closure, and denies a stale worker afterward', { skip: !enabled }, async () => {
  const { createPool } = require('../src/db');
  const { loadEnv } = require('../src/config');
  const { runMigrations } = require('../src/migrate');
  const { createRepository } = require('../src/repository');
  const pool = createPool(loadEnv());
  const recoveryPool = createPool(loadEnv());
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const requestIds = [randomUUID(), randomUUID()];
  const sessionId = randomUUID();
  const profileId = `fence-profile-${randomUUID()}`;
  const accountId = `fence-account-${randomUUID()}`;
  let adminId;
  let savedSettings;
  let savedAutomation;
  let savedIntegration;
  let insertedIntegration = false;
  let releaseProviderStub;
  let fencePromise;

  try {
    const [[database]] = await pool.query('SELECT DATABASE() AS name, VERSION() AS version');
    assert.equal(database.name, databaseName);
    assert.match(database.version, /^8\.4\./);
    await runMigrations(pool);
    [[savedSettings]] = await pool.query('SELECT settings_json,automation_enabled FROM settings WHERE id=1');
    savedAutomation = savedSettings.automation_enabled;
    [[savedIntegration]] = await pool.query('SELECT * FROM integration_config WHERE id=1');
    if (savedIntegration) {
      await pool.execute("UPDATE integration_config SET profile_id=?,account_id=?,status='ACTIVE',version=version+1 WHERE id=1", [profileId, accountId]);
    } else {
      await pool.execute("INSERT INTO integration_config (id,version,profile_id,account_id,model,status) VALUES (1,1,?,?,'test/model','ACTIVE')", [profileId, accountId]);
      insertedIntegration = true;
    }
    const [admin] = await pool.execute('INSERT INTO admins (email,password_hash) VALUES (?,?)', [`fence-${randomUUID()}@example.test`, 'test-only-password-hash']);
    adminId = admin.insertId;
    await pool.execute('UPDATE settings SET settings_json=?,automation_enabled=TRUE WHERE id=1', [JSON.stringify({ automationSessionId: sessionId, profileId, targetAccountId: accountId })]);

    const staleAt = new Date(Date.now() - 10 * 60_000);
    for (let index = 0; index < ids.length; index++) {
      await pool.execute(`INSERT INTO slots (id,scheduled_at,automation_session_id,status,provider_status,error_code,publish_started_at,request_payload,idempotency_key,tebar_profile_id,tebar_account_id)
        VALUES (?,?,?,'publishing','unknown','network_error',?,?,?,?,?)`,
      [ids[index], new Date(Date.now() + index * 1000), sessionId, index === 0 ? staleAt : new Date(),
        index === 0 ? JSON.stringify({ content: 'Mocked fence request', targets: [{ account_id: accountId }] }) : null,
        index === 0 ? `fence-${ids[index]}` : null, index === 0 ? profileId : null, index === 0 ? accountId : null]);
    }

    const repository = createRepository(pool);
    const secondRepository = createRepository(recoveryPool);
    const events = [];
    let providerStubEntered;
    const providerStarted = new Promise(resolve => { providerStubEntered = resolve; });
    const providerRelease = new Promise(resolve => { releaseProviderStub = resolve; });

    fencePromise = repository.withPublicationFence(ids[0], async recordOutcome => {
      // This callback stands in for the provider mutation. No provider client is created.
      events.push('provider-stub-entered');
      providerStubEntered();
      await providerRelease;
      await recordOutcome({ status: 'unknown', providerStatus: 'unknown', errorCode: 'unknown_outcome' });
      events.push('outcome-recorded');
      return 'outcome-saved';
    }).then(result => { events.push('fence-committed'); return result; });

    await providerStarted;
    const recoveredDuringFence = await secondRepository.recoverStalePublishing({ now: new Date() });
    assert.equal(recoveredDuringFence.includes(ids[0]), false, 'SKIP LOCKED must leave a live publisher-owned slot untouched');

    let closeLockRequested;
    const lockRequest = new Promise(resolve => { closeLockRequested = resolve; });
    const closePool = {
      execute: (...args) => pool.execute(...args),
      query: (...args) => pool.query(...args),
      getConnection: async () => {
        const connection = await pool.getConnection();
        const query = connection.query.bind(connection);
        connection.query = (sql, ...args) => {
          if (String(sql).includes('settings') && String(sql).includes('FOR UPDATE')) closeLockRequested();
          return query(sql, ...args);
        };
        return connection;
      },
    };
    const closeRepository = createRepository(closePool);
    const input = (slotId, requestId) => ({ slotId, requestId, actorId: adminId,
      reason: 'Provider outcome is still unverified.',
      evidenceSummary: 'Test-only mock callback; no live provider request was sent.' });
    const closeEvents = [];
    const closeFirst = closeRepository.closeUnknownPublication(input(ids[0], requestIds[0]))
      .then(result => { closeEvents.push('close-committed'); return result; });
    await lockRequest;
    assert.deepEqual(events, ['provider-stub-entered']);
    releaseProviderStub();
    const [fenceResult, closeResult] = await Promise.all([fencePromise, closeFirst]);
    assert.equal(fenceResult, 'outcome-saved');
    assert.equal(closeResult.previousStatus, 'unknown');
    assert.equal((await repository.getPublicationSlot(ids[0])).status, 'admin_closed_unknown');
    assert.deepEqual(events, ['provider-stub-entered', 'outcome-recorded', 'fence-committed']);
    assert.deepEqual(closeEvents, ['close-committed']);

    await pool.execute('UPDATE slots SET publish_started_at=? WHERE id IN (?,?)', [staleAt, ids[1], ids[2]]);
    const recoveredAfterPause = await secondRepository.recoverStalePublishing({ now: new Date(), slotIds: [ids[1]] });
    assert.ok(recoveredAfterPause.includes(ids[1]), 'a stale row without target metadata must be made operator-resolvable');
    assert.equal(recoveredAfterPause.includes(ids[2]), false, 'a scoped recovery must leave unrelated stale slots unchanged');
    assert.equal((await repository.getPublicationSlot(ids[2])).status, 'publishing');
    const recoveredOutOfScope = await secondRepository.recoverStalePublishing({ now: new Date() });
    assert.ok(recoveredOutOfScope.includes(ids[2]), 'the unrelated slot remains recoverable by a later global sweep');
    await repository.closeUnknownPublication(input(ids[1], requestIds[1]));
    let staleProviderStubCalled = false;
    const staleWorkerResult = await repository.withPublicationFence(ids[1], async () => {
      staleProviderStubCalled = true;
    });
    assert.equal(staleWorkerResult, false);
    assert.equal(staleProviderStubCalled, false, 'a stale worker must not reach the provider callback after closure');

    const [[eventsForSlots]] = await pool.execute('SELECT COUNT(*) AS count FROM publication_resolution_events WHERE slot_id IN (?,?)', ids);
    assert.equal(Number(eventsForSlots.count), 2);
  } finally {
    releaseProviderStub?.();
    await fencePromise?.catch(() => {});
    await pool.execute('UPDATE settings SET settings_json=?,automation_enabled=? WHERE id=1', [JSON.stringify(savedSettings?.settings_json || {}), savedAutomation ?? false]).catch(() => {});
    if (insertedIntegration) await pool.execute('DELETE FROM integration_config WHERE id=1').catch(() => {});
    else if (savedIntegration) await pool.execute(`UPDATE integration_config SET version=?,profile_id=?,account_id=?,model=?,status=?,pending_profile_id=?,pending_account_id=?,pending_model=?,updated_by=?,updated_at=? WHERE id=1`,
      [savedIntegration.version, savedIntegration.profile_id, savedIntegration.account_id, savedIntegration.model, savedIntegration.status,
        savedIntegration.pending_profile_id, savedIntegration.pending_account_id, savedIntegration.pending_model, savedIntegration.updated_by, savedIntegration.updated_at]).catch(() => {});
    if (adminId) {
      await pool.execute('DELETE FROM publication_resolution_events WHERE slot_id IN (?,?)', ids).catch(() => {});
      await pool.execute('DELETE FROM activity_logs WHERE slot_id IN (?,?)', ids).catch(() => {});
      await pool.execute('DELETE FROM notification_outbox WHERE dedupe_key IN (?,?)', requestIds.map(id => require('node:crypto').createHash('sha256').update(`publication-resolution:${id}`).digest('hex'))).catch(() => {});
      await pool.execute('DELETE FROM audit_logs WHERE admin_id=?', [adminId]).catch(() => {});
      await pool.execute(`DELETE FROM slots WHERE id IN (${ids.map(() => '?').join(',')})`, ids).catch(() => {});
      await pool.execute('DELETE FROM admins WHERE id=?', [adminId]).catch(() => {});
    }
    await recoveryPool.end();
    await pool.end();
  }
});
