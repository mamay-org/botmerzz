'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRepository } = require('../src/repository');

test('publication blocker inspection exposes safe evidence and rejects incomplete target snapshots', async () => {
  const base = { id: 'slot-id', status: 'unknown', provider_post_id: null, provider_status: 'unknown', tebar_profile_id: 'profile-1', tebar_account_id: 'account-1', caption: '<script>literal evidence</script>', error_code: 'network_error', publish_started_at: '2026-11-15T09:01:58Z', request_payload: { content: 'caption', targets: [{ account_id: 'account-1' }] }, idempotency_key: 'private-durable-key' };
  const rows = [base, { ...base, id: 'publishing', status: 'publishing' }, { ...base, id: 'missing', tebar_account_id: null }, { ...base, id: 'mismatch', request_payload: { targets: [{ account_id: 'another-account' }] } }, { ...base, id: 'linked', provider_post_id: 'post-1' }];
  const repository = createRepository({ execute: async () => [rows] });
  const slots = await repository.listPublicationBlockers();
  assert.equal(slots[0].resolutionEligible, true);
  assert.equal(slots[0].caption, base.caption);
  assert.equal(slots[0].publishStartedAt, base.publish_started_at);
  assert.equal(slots[0].errorCode, 'network_error');
  assert.ok(slots.every(slot => !Object.hasOwn(slot, 'requestPayload') && !Object.hasOwn(slot, 'idempotencyKey')));
  assert.equal(slots[1].resolutionEligible, false);
  assert.equal(slots[1].resolutionBlockedReason, 'PUBLICATION_NOT_UNKNOWN');
  assert.equal(slots[2].resolutionEligible, true, 'admin closure remains available for a legacy row without target metadata');
  assert.equal(slots[2].resolutionTargetValid, false);
  assert.equal(slots[2].linkEligible, false);
  assert.equal(slots[2].resolutionBlockedReason, null);
  assert.equal(slots[3].resolutionEligible, true, 'admin closure remains available for mismatched legacy request targets');
  assert.equal(slots[3].resolutionTargetValid, false);
  assert.equal(slots[3].linkEligible, false);
  assert.equal(slots[4].resolutionBlockedReason, 'PROVIDER_POST_ALREADY_LINKED');
});

test('closed unknown slots remain discoverable for late verified publication evidence without exposing payload keys', async () => {
  const rows = [
    { id: 'closed-valid', caption: 'Original caption', scheduled_at: '2026-11-15T16:00:00Z', status: 'admin_closed_unknown', provider_status: 'unknown', provider_post_id: null, error_code: 'network_error', completed_at: '2026-11-16T00:00:00Z', tebar_profile_id: 'profile-1', tebar_account_id: 'account-1', request_payload: { content: 'secret caption', idempotency_key: 'private-key', targets: [{ account_id: 'account-1' }] } },
    { id: 'closed-mismatch', status: 'admin_closed_unknown', provider_status: 'unknown', provider_post_id: null, tebar_profile_id: 'profile-1', tebar_account_id: 'account-1', request_payload: { targets: [{ account_id: 'different-account' }] } },
  ];
  const repository = createRepository({ execute: async () => [rows] });
  const slots = await repository.listClosedUnknownSlots();
  assert.equal(slots[0].lateLinkEligible, true);
  assert.equal(slots[0].providerStatus, 'unknown');
  assert.equal(slots[0].caption, 'Original caption');
  assert.ok(!Object.hasOwn(slots[0], 'requestPayload'));
  assert.ok(!Object.hasOwn(slots[0], 'idempotencyKey'));
  assert.equal(slots[1].lateLinkEligible, false);
  assert.equal(slots[1].lateLinkBlockedReason, 'PUBLICATION_TARGET_MISMATCH');
});

test('closed unknown slot lookup can find an exact ID outside the recent-list query', async () => {
  const id = '5fe16cbd-0249-4bb3-9b67-b5ae1b1e0d30';
  const queries = [];
  const row = { id, status: 'admin_closed_unknown', provider_post_id: null, provider_status: 'unknown',
    tebar_profile_id: 'profile-1', tebar_account_id: 'account-1', request_payload: { targets: [{ account_id: 'account-1' }] } };
  const repository = createRepository({ execute: async (sql, params) => { queries.push({ sql, params }); return [[row]]; } });
  const slots = await repository.listClosedUnknownSlots(id);
  assert.equal(slots.length, 1);
  assert.equal(slots[0].id, id);
  assert.equal(slots[0].lateLinkEligible, true);
  assert.deepEqual(queries[0].params, [id]);
  assert.match(queries[0].sql, /status='admin_closed_unknown' AND provider_post_id IS NULL AND id=\?/);
  assert.match(queries[0].sql, /LIMIT 100$/);
  await assert.rejects(repository.listClosedUnknownSlots('not-a-uuid'), error => error.code === 'INVALID_REQUEST' && error.status === 400);
  assert.equal(queries.length, 1);
});

test('repository refuses unaudited administrative status patches and malformed decisions before connecting', async () => {
  let calls = 0;
  const repository = createRepository({ execute: async () => { calls++; }, getConnection: async () => { calls++; throw Error('must not connect'); } });
  await assert.rejects(repository.updateSlot('slot-id', { status: 'admin_closed_unknown' }), error => error.code === 'PUBLICATION_RESOLUTION_REQUIRED');
  await assert.rejects(repository.closeUnknownPublication({ slotId: 'invalid', requestId: 'invalid', actorId: 1, reason: 'Valid reason.', evidenceSummary: 'Valid evidence summary.' }), error => error.code === 'INVALID_REQUEST');
  await assert.rejects(repository.recordProviderHold({ provider: 'tebar', profileId: 'profile-1', accountId: 'account-1', reasonCode: 'network_error' }), error => error.code === 'INVALID_REQUEST');
  assert.equal(calls, 0);
});

test('unsettled-slot query can scope valid targets and keeps incomplete or mismatched target snapshots globally visible', async () => {
  const queries = [];
  const repository = createRepository({ execute: async (sql, params) => { queries.push({ sql, params }); return [[]]; } });
  await repository.listUnsettledSlots({ profileId: 'profile-current', accountId: 'account-current' });
  const scoped = queries[0];
  assert.deepEqual(scoped.params, ['profile-current', 'account-current']);
  assert.match(scoped.sql, /tebar_profile_id IS NULL OR tebar_account_id IS NULL/);
  assert.match(scoped.sql, /tebar_profile_id=\? AND tebar_account_id=\?/);
  assert.match(scoped.sql, /JSON_LENGTH\(JSON_EXTRACT\(request_payload,'\$\.targets'\)\)/);
  assert.match(scoped.sql, /JSON_UNQUOTE\(JSON_EXTRACT\(request_payload,'\$\.targets\[0\]\.account_id'\)\)<>tebar_account_id/);
  await repository.listUnsettledSlots();
  assert.deepEqual(queries[1].params, []);
  assert.doesNotMatch(queries[1].sql, /tebar_profile_id IS NULL OR tebar_account_id IS NULL/);
});

test('stale publishing recovery accepts a validated slot allowlist and does no query for an empty scope', async () => {
  const statements = [];
  let connections = 0;
  const connection = {
    beginTransaction: async () => {},
    execute: async (sql, params) => {
      statements.push({ sql, params });
      if (sql.includes('SELECT id FROM slots')) return [[{ id: 'slot-a' }]];
      return [{ affectedRows: 1 }];
    },
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
  };
  const repository = createRepository({
    execute: async () => { throw new Error('unexpected pool-level query'); },
    getConnection: async () => { connections++; return connection; },
  });
  const now = new Date('2026-11-17T00:00:00.000Z');
  const recovered = await repository.recoverStalePublishing({ now, slotIds: ['slot-a', 'slot-a', '', null, 'x'.repeat(129)] });
  assert.deepEqual(recovered, ['slot-a']);
  const scan = statements.find(({ sql }) => sql.includes('SELECT id FROM slots'));
  assert.match(scan.sql, /AND id IN \(\?\)/);
  assert.deepEqual(scan.params, [new Date(now.getTime() - 120_000), 'slot-a']);

  const statementCount = statements.length;
  assert.deepEqual(await repository.recoverStalePublishing({ now, slotIds: ['', null, 'x'.repeat(129)] }), []);
  assert.equal(connections, 1);
  assert.equal(statements.length, statementCount);
});

test('automation re-enable scopes unresolved blockers to the configured target and ambiguous rows', async () => {
  const statements = [];
  const connection = {
    beginTransaction: async () => {},
    query: async sql => {
      statements.push({ sql, params: [] });
      if (sql.includes('settings_json,automation_enabled')) return [[{ settings_json: JSON.stringify({ profileId: 'profile-current', targetAccountId: 'account-current' }), automation_enabled: 0 }]];
      if (sql.includes('integration_config')) return [[{ status: 'ACTIVE', profile_id: 'profile-current', account_id: 'account-current', model: 'vendor/model' }]];
      return [[]];
    },
    execute: async (sql, params) => { statements.push({ sql, params }); return [[{ id: 'relevant-blocker' }]]; },
    rollback: async () => {}, commit: async () => {}, release: () => {},
  };
  const repository = createRepository({ execute: async () => { throw new Error('unexpected pool query'); }, getConnection: async () => connection });
  await assert.rejects(repository.setAutomationEnabled(true), error => error.code === 'RECONCILIATION_REQUIRED');
  const blockerQuery = statements.find(({ sql }) => sql.includes('SELECT id FROM slots'));
  assert.deepEqual(blockerQuery.params, ['profile-current', 'account-current']);
  assert.match(blockerQuery.sql, /tebar_profile_id IS NULL OR tebar_account_id IS NULL/);
  assert.match(blockerQuery.sql, /tebar_profile_id=\? AND tebar_account_id=\?/);
});
