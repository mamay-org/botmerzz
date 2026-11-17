'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const enabled = process.env.NODE_ENV === 'test' && process.env.DB_NAME === 'merzz_test'
  && ['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST) && process.env.ALLOW_DESTRUCTIVE_DB_TESTS === 'true';

test('disposable MySQL 8.4 publication resolution, restart, concurrency, holds, and account switch recovery', { skip: !enabled }, async t => {
  const { createPool } = require('../src/db');
  const { loadEnv } = require('../src/config');
  const { runMigrations } = require('../src/migrate');
  const { createRepository } = require('../src/repository');
  const { createConfigurationService } = require('../src/configuration');
  const pool = createPool(loadEnv());
  const created = [];
  let actorId;
  const profileId = `profile-${randomUUID()}`;
  const accountId = `account-${randomUUID()}`;
  const otherAccountId = `account-${randomUUID()}`;
  let tick = Date.now();
  let actorEmail;
  const input = slotId => ({ slotId, requestId: randomUUID(), actorId, reason: 'Original account reviewed.', evidenceSummary: 'Tebar history and original Threads account checked at the exact attempt time.' });
  async function slot(status = 'unknown', providerPostId = null) {
    const id = randomUUID(); created.push(id);
    await pool.execute('INSERT INTO slots (id,scheduled_at,status,provider_status,provider_post_id,caption,request_payload,idempotency_key,tebar_profile_id,tebar_account_id,error_code,publish_started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, new Date(tick++), status, 'unknown', providerPostId, 'Bila ada event gacha dalam MLBB...', JSON.stringify({ content: 'Bila ada event gacha dalam MLBB...', targets: [{ account_id: accountId }] }), `key-${id}`, profileId, accountId, 'network_error', new Date(tick++)]);
    return id;
  }
  let savedSettings; let savedConfig; let switchVersions = []; let dispatchSessionIds = [];
  try {
    const [[database]] = await pool.query('SELECT DATABASE() AS name,VERSION() AS version');
    assert.equal(database.name, 'merzz_test'); assert.match(database.version, /^8\.4\./);
    await runMigrations(pool);
    [[savedSettings]] = await pool.query('SELECT settings_json,knowledge_json,automation_enabled FROM settings WHERE id=1');
    [[savedConfig]] = await pool.query('SELECT * FROM integration_config WHERE id=1');
    actorEmail = `resolution-${randomUUID()}@example.test`;
    const [admin] = await pool.execute('INSERT INTO admins (email,password_hash) VALUES (?,?)', [actorEmail, 'test-only-password-hash']);
    actorId = admin.insertId;
    const repo = createRepository(pool);

    await t.test('migration can rerun after DDL completion and preserves existing unknown rows', async () => {
      const id = await slot();
      await pool.execute("DELETE FROM schema_migrations WHERE version='020_manual_publication_resolution.sql'");
      assert.deepEqual(await runMigrations(pool), ['020_manual_publication_resolution.sql']);
      assert.equal((await repo.getPublicationSlot(id)).status, 'unknown');
      await assert.rejects(pool.execute("UPDATE slots SET status='unrecognized_status' WHERE id=?", [id]));
      const request = input(id);
      const result = await repo.closeUnknownPublication(request);
      assert.equal(result.newStatus, 'admin_closed_unknown');
    });

    await t.test('closure is idempotent, preserves evidence and immutable target, and cannot replay after restart', async () => {
      const id = await slot(); const request = input(id);
      const [[before]] = await pool.execute('SELECT * FROM slots WHERE id=?', [id]);
      const results = await Promise.all([repo.closeUnknownPublication(request), createRepository(pool).closeUnknownPublication(request)]);
      assert.equal(results.filter(result => result.replayed).length, 1);
      assert.ok(results.every(result => result.actorEmail === actorEmail), 'actor email must come from the locked admin row');
      const [[after]] = await pool.execute('SELECT * FROM slots WHERE id=?', [id]);
      for (const field of ['caption', 'idempotency_key', 'tebar_profile_id', 'tebar_account_id', 'provider_post_id', 'error_code']) assert.equal(after[field], before[field], field);
      assert.deepEqual(after.request_payload, before.request_payload);
      assert.equal(after.status, 'admin_closed_unknown'); assert.equal(after.provider_status, 'unknown'); assert.ok(after.completed_at);
      assert.equal(await repo.updateSlot(id, { status: 'ready' }), false);
      assert.equal(await repo.updateSlot(id, { providerPostId: 'unexpected' }), false);
      assert.equal(await repo.updateSlot(id, { status: 'published', providerStatus: 'published' }), false);
      assert.equal((await createRepository(pool).listUnsettledSlots()).some(row => row.id === id), false);
      const [[events]] = await pool.execute('SELECT COUNT(*) AS count FROM publication_resolution_events WHERE slot_id=?', [id]); assert.equal(Number(events.count), 1);
      const [[audit]] = await pool.execute("SELECT COUNT(*) AS count FROM audit_logs WHERE admin_id=? AND action='publication.close_unverified' AND JSON_UNQUOTE(JSON_EXTRACT(details_json,'$.slotId'))=?", [actorId, id]); assert.equal(Number(audit.count), 1);
      const noticeKey = createHash('sha256').update(`publication-resolution:${request.requestId}`).digest('hex');
      assert.equal(await repo.getNotificationStatus(noticeKey), 'pending');
      await assert.rejects(repo.closeUnknownPublication({ ...request, reason: 'A different decision reason.' }), error => error.code === 'PUBLICATION_REQUEST_CONFLICT');
      const restartedPool = createPool(loadEnv());
      try {
        const restartedRepo = createRepository(restartedPool);
        assert.equal((await restartedRepo.getPublicationSlot(id)).status, 'admin_closed_unknown');
        assert.equal((await restartedRepo.closeUnknownPublication(request)).replayed, true);
        assert.equal((await restartedRepo.listUnsettledSlots()).some(row => row.id === id), false);
      } finally { await restartedPool.end(); }
    });

    await t.test('a publication found after closure is linked by a second audit event and remains GET-reconcilable', async () => {
      const id = await slot();
      const closeRequest = input(id);
      await repo.closeUnknownPublication(closeRequest);
      const postId = `late-${randomUUID()}`;
      const linkRequest = { ...input(id), providerPostId: postId, profileId, accountId };
      const linked = await repo.linkVerifiedProviderPost(linkRequest);
      assert.equal(linked.previousStatus, 'admin_closed_unknown');
      assert.equal(linked.newStatus, 'unknown');
      const state = await repo.getPublicationSlot(id);
      assert.equal(state.status, 'unknown');
      assert.equal(state.providerStatus, 'unknown');
      assert.equal(state.providerPostId, postId);
      assert.equal(state.completedAt, null);
      assert.ok((await createRepository(pool).listUnsettledSlots()).some(item => item.id === id));
      const [events] = await pool.execute('SELECT action,previous_status,new_status,provider_post_id FROM publication_resolution_events WHERE slot_id=? ORDER BY id', [id]);
      assert.deepEqual(events.map(event => [event.action,event.previous_status,event.new_status]), [
        ['close_unverified','unknown','admin_closed_unknown'],
        ['link_provider_post','admin_closed_unknown','unknown'],
      ]);
      assert.equal(events[1].provider_post_id, postId);
      // Keep this shared disposable database isolated for the account-switch assertions below.
      assert.equal(await repo.updateSlot(id, { status: 'failed', providerStatus: 'failed', errorCode: 'provider_error', completedAt: new Date() }), true);
    });

    await t.test('worker interruption recovers only stale publishing rows and stays non-replayable', async () => {
      const stale = await slot('publishing');
      const fresh = await slot('publishing');
      const now = new Date(Date.now());
      await pool.execute('UPDATE slots SET publish_started_at=? WHERE id=?', [new Date(now.getTime() - 5 * 60_000), stale]);
      await pool.execute('UPDATE slots SET publish_started_at=? WHERE id=?', [new Date(now.getTime() - 30_000), fresh]);
      const [[snapshotBefore]] = await pool.execute('SELECT request_payload,idempotency_key,tebar_profile_id,tebar_account_id FROM slots WHERE id=?', [stale]);

      const restartedPool = createPool(loadEnv());
      let results;
      try {
        results = await Promise.all([
          repo.recoverStalePublishing({ now }),
          createRepository(restartedPool).recoverStalePublishing({ now }),
        ]);
      } finally { await restartedPool.end(); }
      assert.equal(results.flat().filter(id => id === stale).length, 1);
      assert.equal(results.flat().includes(fresh), false);
      assert.deepEqual(await repo.recoverStalePublishing({ now }), []);

      const recovered = await repo.getPublicationSlot(stale);
      assert.equal(recovered.status, 'unknown');
      assert.equal(recovered.providerStatus, 'unknown');
      assert.equal(recovered.providerPostId, null);
      assert.equal(recovered.errorCode, 'unknown_outcome');
      assert.equal(recovered.completedAt, null);
      const [[snapshotAfter]] = await pool.execute('SELECT request_payload,idempotency_key,tebar_profile_id,tebar_account_id FROM slots WHERE id=?', [stale]);
      assert.deepEqual(snapshotAfter.request_payload, snapshotBefore.request_payload);
      for (const key of ['idempotency_key', 'tebar_profile_id', 'tebar_account_id']) assert.equal(snapshotAfter[key], snapshotBefore[key]);
      assert.ok((await repo.listUnsettledSlots()).some(item => item.id === stale));
      const [[activity]] = await pool.execute("SELECT COUNT(*) AS count FROM activity_logs WHERE slot_id=? AND event='publication_worker_interrupted'", [stale]);
      assert.equal(Number(activity.count), 1);

      assert.equal(await repo.closeUnknownPublication(input(stale)).then(result => result.newStatus), 'admin_closed_unknown');
      assert.equal((await repo.listUnsettledSlots()).some(item => item.id === stale), false);
      assert.equal(await repo.updateSlot(fresh, { status: 'failed', providerStatus: 'failed', completedAt: new Date() }), true);
    });

    await t.test('failed audit write rolls back manual closure, activity, and notification atomically', async () => {
      const id = await slot();
      const request = input(id);
      const constraint = `publication_audit_fail_${randomUUID().replaceAll('-', '')}`;
      await pool.query(`ALTER TABLE audit_logs ADD CONSTRAINT \`${constraint}\` CHECK (action <> 'publication.close_unverified' OR JSON_UNQUOTE(JSON_EXTRACT(details_json,'$.slotId')) <> '${id}')`);
      try {
        await assert.rejects(repo.closeUnknownPublication(request));
        assert.equal((await repo.getPublicationSlot(id)).status, 'unknown');
        const [[eventCount]] = await pool.execute('SELECT COUNT(*) AS count FROM publication_resolution_events WHERE request_id=?', [request.requestId]);
        const [[auditCount]] = await pool.execute("SELECT COUNT(*) AS count FROM audit_logs WHERE action='publication.close_unverified' AND JSON_UNQUOTE(JSON_EXTRACT(details_json,'$.slotId'))=?", [id]);
        const [[activityCount]] = await pool.execute("SELECT COUNT(*) AS count FROM activity_logs WHERE slot_id=? AND event='publication_close_unverified'", [id]);
        const noticeKey = createHash('sha256').update(`publication-resolution:${request.requestId}`).digest('hex');
        assert.equal(Number(eventCount.count), 0);
        assert.equal(Number(auditCount.count), 0);
        assert.equal(Number(activityCount.count), 0);
        assert.equal(await repo.getNotificationStatus(noticeKey), null);
      } finally {
        try { await pool.query(`ALTER TABLE audit_logs DROP CHECK \`${constraint}\``); }
        finally { await repo.updateSlot(id, { status: 'failed', providerStatus: 'failed', completedAt: new Date() }); }
      }
    });

    await t.test('concurrent different decisions have one winner and changed states reject closure', async () => {
      const id = await slot();
      const results = await Promise.allSettled([repo.closeUnknownPublication(input(id)), createRepository(pool).closeUnknownPublication(input(id))]);
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(results.find(result => result.status === 'rejected').reason.code, 'PUBLICATION_STATE_CONFLICT');
      for (const state of ['publishing', 'published', 'failed']) {
        const changed = await slot(state);
        await assert.rejects(repo.closeUnknownPublication(input(changed)), error => error.code === 'PUBLICATION_STATE_CONFLICT');
        await pool.execute("UPDATE slots SET status='failed' WHERE id=?", [changed]);
      }
      const linked = await slot('unknown', `existing-${randomUUID()}`);
      await assert.rejects(repo.closeUnknownPublication(input(linked)), error => error.code === 'PUBLICATION_STATE_CONFLICT');
      await pool.execute("UPDATE slots SET status='failed',provider_status='failed' WHERE id=?", [linked]);
    });

    await t.test('verified linking preserves original target and rejects reused provider IDs', async () => {
      const id = await slot(); const postId = `verified-${randomUUID()}`;
      const request = { ...input(id), providerPostId: postId, profileId, accountId };
      await assert.rejects(repo.linkVerifiedProviderPost({ ...request, accountId: otherAccountId }), error => error.code === 'PUBLICATION_TARGET_MISMATCH');
      await repo.linkVerifiedProviderPost(request);
      const linked = await repo.getPublicationSlot(id);
      assert.equal(linked.providerPostId, postId); assert.equal(linked.status, 'unknown'); assert.equal(linked.accountId, accountId);
      const other = await slot();
      await assert.rejects(repo.linkVerifiedProviderPost({ ...input(other), providerPostId: postId, profileId, accountId }), error => error.code === 'PROVIDER_POST_ALREADY_LINKED');
      await repo.updateSlot(id, { status: 'published', providerStatus: 'published', completedAt: new Date() });
      assert.equal((await repo.getPublicationSlot(id)).status, 'published');
      await repo.closeUnknownPublication(input(other));
    });

    await t.test('provider holds stay scoped and successful validation clears only the matching hold', async () => {
      await repo.recordProviderHold({ provider: 'tebar', profileId, accountId, reasonCode: 'unauthorized' });
      assert.equal((await repo.listActiveProviderHolds({ profileId, accountId })).length, 1);
      assert.equal((await repo.listActiveProviderHolds({ profileId, accountId: otherAccountId })).length, 0);
      await repo.recordProviderHold({ provider: 'openrouter', reasonCode: 'ai_unauthorized' });
      assert.equal((await repo.listActiveProviderHolds({ profileId, accountId: otherAccountId })).length, 1);
      await repo.clearProviderHold({ provider: 'tebar', profileId, accountId: otherAccountId, actorId });
      assert.equal((await repo.listActiveProviderHolds({ profileId, accountId })).length, 2);
      await repo.clearProviderHold({ provider: 'openrouter', actorId });
      assert.equal((await repo.listActiveProviderHolds({ profileId, accountId })).length, 1);
      await repo.clearProviderHold({ provider: 'tebar', profileId, accountId, actorId });
      assert.equal((await repo.listActiveProviderHolds({ profileId, accountId })).length, 0);
    });

    await t.test('account switch waits for every blocker and finishes with automation off', async () => {
      const { runDispatcher } = require('../src/dispatcher');
      const [[max]] = await pool.query('SELECT COALESCE(MAX(version),0) AS version FROM integration_config_history');
      const version = Number(max.version) + 10;
      const settings = { profileId, targetAccountId: accountId, integrationConfigInitialized: true, onboardingComplete: true };
      await pool.execute('UPDATE settings SET settings_json=?,automation_enabled=FALSE WHERE id=1', [JSON.stringify(settings)]);
      await pool.execute("INSERT INTO integration_config (id,version,profile_id,account_id,model,status) VALUES (1,?,?,?,'test/model','ACTIVE') ON DUPLICATE KEY UPDATE version=VALUES(version),profile_id=VALUES(profile_id),account_id=VALUES(account_id),model=VALUES(model),status='ACTIVE',pending_profile_id=NULL,pending_account_id=NULL,pending_model=NULL", [version, profileId, accountId]);
      const first = await slot(); const second = await slot();
      assert.deepEqual((await repo.listUnsettledSlots({ profileId, accountId })).map(item => item.id).sort(), [first, second].sort(), 'only this account-switch fixture may block the switch');
      const configuration = createConfigurationService({ pool, config: { tebar: { profileId, accountId }, openRouter: { model: 'test/model' } } });
      const blocked = await configuration.switchAccount({ profileId, accountId: otherAccountId, expectedVersion: version, actorId }); switchVersions.push(blocked.version);
      assert.equal(blocked.status, 'BLOCKED_RECONCILIATION');
      await repo.closeUnknownPublication(input(first));
      assert.equal((await configuration.resumeSwitch({ expectedVersion: blocked.version, actorId })).status, 'BLOCKED_RECONCILIATION');
      await repo.closeUnknownPublication(input(second));
      const active = await configuration.resumeSwitch({ expectedVersion: blocked.version, actorId }); switchVersions.push(active.version);
      assert.equal(active.accountId, otherAccountId); assert.equal(active.status, 'ACTIVE');
      assert.equal((await repo.getSettings()).automationEnabled, false);
      assert.equal((await repo.getPublicationSlot(first)).accountId, accountId);
      assert.equal((await repo.getPublicationSlot(second)).accountId, accountId);
      assert.equal((await repo.getPublicationSlot(first)).status, 'admin_closed_unknown');
      assert.equal((await repo.getPublicationSlot(second)).status, 'admin_closed_unknown');

      let publishRequests = [];
      const paused = await runDispatcher({
        repository: repo,
        publisher: { publishNow: async payload => { publishRequests.push(payload); return assert.fail('account switching must leave automation paused'); } },
        content: async () => assert.fail('paused automation must not generate content'),
        clock: () => new Date(Date.now() + 5_000),
      });
      assert.equal(paused.claimed, 0);
      assert.equal(paused.published, 0);
      assert.deepEqual(publishRequests, []);

      const readySettings = {
        schedule: { intervalMinutes: 60, timezone: 'Asia/Kuala_Lumpur' },
        brand: { name: 'Kedai Merzz', voice: 'Santai' },
        guardrails: { approved: true, forbiddenClaims: [], approvedClaims: [] },
        targetAccountId: otherAccountId,
        profileId,
        onboardingComplete: true,
      };
      await pool.execute('UPDATE settings SET settings_json=?,knowledge_json=? WHERE id=1', [
        JSON.stringify(readySettings), JSON.stringify({ brand: readySettings.brand, guardrails: readySettings.guardrails }),
      ]);
      const enabledAutomation = await repo.setAutomationEnabled(true, actorId);
      dispatchSessionIds.push(enabledAutomation.sessionId);
      assert.equal(enabledAutomation.changed, true);
      assert.equal((await repo.getRuntimeState()).accountId, otherAccountId);

      const sent = [];
      const dispatchNow = () => new Date(Date.now() + 5_000);
      const published = await runDispatcher({
        repository: repo,
        publisher: {
          publishNow: async (payload, idempotencyKey) => {
            sent.push({ payload, idempotencyKey });
            return { id: 'mock-new-account-post', status: 'published', targets: [{ accountId: otherAccountId, platform: 'threads', status: 'published' }] };
          },
        },
        content: async () => ({ status: 'ready', text: 'Mock post after deliberate reactivation.', pillar: 'topup', factBearing: false, factIds: [] }),
        clock: dispatchNow,
      });
      assert.equal(published.published, 1);
      assert.equal(sent.length, 1, 'one scheduled slot must produce exactly one mocked provider request');
      assert.deepEqual(sent[0].payload.targets, [{ account_id: otherAccountId }]);
      assert.notEqual(sent[0].payload.targets[0].account_id, accountId);
      const [[newSlot]] = await pool.execute('SELECT id,status,tebar_profile_id,tebar_account_id,request_payload FROM slots WHERE automation_session_id=? AND status=\'published\'', [enabledAutomation.sessionId]);
      assert.ok(newSlot);
      assert.equal(newSlot.tebar_profile_id, profileId);
      assert.equal(newSlot.tebar_account_id, otherAccountId);
      assert.equal(JSON.parse(typeof newSlot.request_payload === 'string' ? newSlot.request_payload : JSON.stringify(newSlot.request_payload)).targets[0].account_id, otherAccountId);
    });
  } finally {
    for (const sessionId of dispatchSessionIds) {
      const [sessionSlots] = await pool.execute('SELECT id FROM slots WHERE automation_session_id=?', [sessionId]);
      for (const sessionSlot of sessionSlots) if (!created.includes(sessionSlot.id)) created.push(sessionSlot.id);
    }
    if (actorId) {
      const [events] = await pool.execute('SELECT request_id FROM publication_resolution_events WHERE actor_id=?', [actorId]);
      for (const event of events) await pool.execute('DELETE FROM notification_outbox WHERE dedupe_key=?', [createHash('sha256').update(`publication-resolution:${event.request_id}`).digest('hex')]);
      await pool.execute('DELETE FROM publication_resolution_events WHERE actor_id=?', [actorId]);
      await pool.execute('DELETE FROM audit_logs WHERE admin_id=?', [actorId]);
      await pool.execute('DELETE FROM automation_provider_holds WHERE (provider=? AND profile_id=?) OR (provider=? AND cleared_by=?)', ['tebar', profileId, 'openrouter', actorId]);
      for (const version of switchVersions) await pool.execute('DELETE FROM integration_config_history WHERE version=?', [version]);
      await pool.execute('DELETE FROM admins WHERE id=?', [actorId]);
    }
    for (const id of created) {
      await pool.execute('DELETE FROM activity_logs WHERE slot_id=?', [id]);
      await pool.execute('DELETE FROM generation_learning_snapshots WHERE slot_id=?', [id]);
      await pool.execute('DELETE FROM generation_attempts WHERE slot_id=?', [id]);
      await pool.execute('DELETE FROM generation_slot_claims WHERE slot_id=?', [id]);
      await pool.execute('DELETE FROM slots WHERE id=?', [id]);
    }
    if (savedSettings) await pool.execute('UPDATE settings SET settings_json=?,knowledge_json=?,automation_enabled=? WHERE id=1', [typeof savedSettings.settings_json === 'string' ? savedSettings.settings_json : JSON.stringify(savedSettings.settings_json), typeof savedSettings.knowledge_json === 'string' ? savedSettings.knowledge_json : JSON.stringify(savedSettings.knowledge_json), savedSettings.automation_enabled]);
    if (savedConfig) await pool.execute('UPDATE integration_config SET version=?,profile_id=?,account_id=?,model=?,status=?,pending_profile_id=?,pending_account_id=?,pending_model=?,updated_by=? WHERE id=1', [savedConfig.version,savedConfig.profile_id,savedConfig.account_id,savedConfig.model,savedConfig.status,savedConfig.pending_profile_id,savedConfig.pending_account_id,savedConfig.pending_model,savedConfig.updated_by]);
    else if (savedSettings) await pool.execute('DELETE FROM integration_config WHERE id=1');
    await pool.end();
  }
});
