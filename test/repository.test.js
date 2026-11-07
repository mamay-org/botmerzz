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

test('hashtag migration initializes missing JSON settings without replacing existing values',()=>{
  const files=fs.readdirSync(require('node:path').resolve(__dirname,'../migrations'));
  assert.ok(files.includes('005_hashtags_default.sql'));
  const sql=fs.readFileSync(require.resolve('../migrations/005_hashtags_default.sql'),'utf8');
  assert.match(sql,/JSON_SET/);
  assert.match(sql,/JSON_ARRAY\(\)/);
  assert.match(sql,/JSON_CONTAINS_PATH/);
  assert.doesNotMatch(sql,/ALTER TABLE|DROP TABLE|DROP COLUMN/);
});
test('automation session migration fences each slot to one activation and permits timestamp reuse across sessions',()=>{
  const files=fs.readdirSync(require('node:path').resolve(__dirname,'../migrations'));
  assert.ok(files.includes('006_automation_sessions.sql'));
  const sql=fs.readFileSync(require.resolve('../migrations/006_automation_sessions.sql'),'utf8');
  assert.match(sql,/automation_session_id/);
  assert.match(sql,/slots_session_scheduled/);
  assert.match(sql,/automationSessionId/);
  assert.match(sql,/information_schema/);
});
test('repository contains atomic scheduling, webhook dedupe, and timezone-safe summaries',()=>{
  const source=fs.readFileSync(require.resolve('../src/repository.js'),'utf8');
  for(const method of ['ensureNextDueSlot','claimDueSlot','startPublishing','applyWebhookEvent','claimDailySummary']) assert.ok(source.includes(method),`missing ${method}`);
  assert.match(source,/automationSessionId/);
  assert.ok(!source.includes('CONVERT_TZ'));
  assert.match(source,/status='sending' AND created_at<DATE_SUB/);
  assert.match(source,/SELECT automation_enabled,settings_json FROM settings WHERE id=1 FOR UPDATE/);
});
