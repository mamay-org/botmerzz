const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {createRepository}=require('../src/repository');

test('repository requires a parameterized MySQL pool',()=>{assert.throws(()=>createRepository(null),/mysql pool/);});
test('initial schema includes durable publish facts, idempotency, and partial delivery state',()=>{
  const sql=fs.readFileSync(require.resolve('../migrations/001_initial.sql'),'utf8');
  for(const field of ['idempotency_key','request_payload','provider_post_id','fact_bearing','fact_ids','partial']) assert.ok(sql.includes(field),`missing ${field}`);
});

test('notification migration contains only restart-safe DDL',()=>{
  const sql=fs.readFileSync(require.resolve('../migrations/002_notification_outbox.sql'),'utf8');
  assert.match(sql,/CREATE TABLE IF NOT EXISTS notification_outbox/);
  assert.doesNotMatch(sql,/ALTER TABLE|DROP TABLE|DROP COLUMN/);
});
test('repository contains atomic scheduling, webhook dedupe, and timezone-safe summaries',()=>{
  const source=fs.readFileSync(require.resolve('../src/repository.js'),'utf8');
  for(const method of ['ensureNextDueSlot','claimDueSlot','startPublishing','applyWebhookEvent','claimDailySummary']) assert.ok(source.includes(method),`missing ${method}`);
  assert.ok(!source.includes('CONVERT_TZ'));
  assert.match(source,/status='sending' AND created_at<DATE_SUB/);
  assert.match(source,/SELECT automation_enabled FROM settings WHERE id=1 FOR UPDATE/);
});
