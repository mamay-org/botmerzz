const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {createRepository}=require('../src/repository');

test('repository requires a parameterized MySQL pool',()=>{assert.throws(()=>createRepository(null),/mysql pool/);});
test('login attempts reserve atomically under MySQL row locks and release success reservations',async()=>{
  const statements=[];const events=[];
  const now=new Date('2026-01-01T00:00:00.000Z');
  const pool={
    async execute(sql,params){statements.push({sql,params});if(sql.startsWith('SELECT scope,attempt_count FROM login_attempts'))return [[{scope:'pair',attempt_count:'2'},{scope:'account',attempt_count:4},{scope:'ip',attempt_count:7}]];return [{affectedRows:1}];},
    async getConnection(){return{
      async beginTransaction(){events.push('begin');},
      async execute(sql,params){statements.push({sql,params});if(sql.startsWith('SELECT scope,subject_hash,attempt_count,window_started_at,expires_at FROM login_attempts'))return [[{scope:'pair',subject_hash:'a'.repeat(64),attempt_count:1,window_started_at:now,expires_at:new Date(now.getTime()+900000)},{scope:'account',subject_hash:'b'.repeat(64),attempt_count:1,window_started_at:now,expires_at:new Date(now.getTime()+900000)},{scope:'ip',subject_hash:'c'.repeat(64),attempt_count:1,window_started_at:now,expires_at:new Date(now.getTime()+900000)}]];return [{affectedRows:1}];},
      async commit(){events.push('commit');},
      async rollback(){events.push('rollback');},
      release(){events.push('release');},
    };},
  };
  const repository=createRepository(pool);
  assert.deepEqual(await repository.getLoginAttemptCounts({email:'Admin@example.test',ip:'203.0.113.8',now}),{pair:2,account:4,ip:7});
  const read=statements[0];
  assert.match(read.sql,/expires_at>\?/);
  assert.doesNotMatch(read.sql,/Admin@example\.test|203\.0\.113\.8/);
  assert.equal(read.params[read.params.length-1],now);
  const result=await repository.reserveLoginAttempt({email:'Admin@example.test',ip:'203.0.113.8',now,windowMs:900000,limits:{pair:8,account:20,ip:40}});
  assert.equal(result.allowed,true);
  assert.deepEqual(result.counts,{pair:1,account:1,ip:1});
  assert.deepEqual(events,['begin','commit','release']);
  const increments=statements.filter(({sql})=>sql.startsWith('INSERT INTO login_attempts'));
  assert.equal(increments.length,3);
  assert.ok(increments.every(({sql})=>/ON DUPLICATE KEY UPDATE/.test(sql)));
  assert.ok(increments.every(({sql})=>/attempt_count=IF\(expires_at<=\?,1,attempt_count\+1\)/.test(sql)));
  assert.ok(increments.every(({sql})=>!/LEAST\(/.test(sql)));
  assert.ok(increments.every(({params})=>!params.includes('Admin@example.test')&&!params.includes('203.0.113.8')));
  assert.ok(statements.some(({sql})=>/DELETE FROM login_attempts WHERE expires_at<=\? LIMIT 1000/.test(sql)));
  assert.ok(statements.some(({sql})=>/FOR UPDATE/.test(sql)));
  await repository.releaseLoginReservation(result.reservation);
  const releases=statements.filter(({sql})=>sql.startsWith('UPDATE login_attempts SET attempt_count=GREATEST'));
  assert.equal(releases.length,3);
  assert.ok(releases.every(({params})=>params.length===4&&/^[a-f0-9]{64}$/.test(params[1])));
  const deleted=statements.filter(({sql})=>sql.startsWith('DELETE FROM login_attempts WHERE scope=?'));
  assert.equal(deleted.length,3);
});

test('login throttle rejects invalid reservation windows without writing',async()=>{
  let writes=0;
  const pool={execute:async()=>{writes++;return[[]];},getConnection:async()=>{writes++;throw new Error('should not connect');}};
  const repository=createRepository(pool);
  await assert.rejects(repository.getLoginAttemptCounts({email:'a@example.test',ip:'127.0.0.1',now:'not a date'}),error=>error.code==='INVALID_LOGIN_THROTTLE_TIME');
  await assert.rejects(repository.reserveLoginAttempt({email:'a@example.test',ip:'127.0.0.1',now:new Date(),windowMs:0,limits:{pair:8,account:20,ip:40}}),error=>error.code==='INVALID_LOGIN_THROTTLE_WINDOW');
  await assert.rejects(repository.reserveLoginAttempt({email:'a@example.test',ip:'127.0.0.1',now:new Date(),windowMs:1000,limits:{pair:10_001,account:20,ip:40}}),error=>error.code==='INVALID_LOGIN_THROTTLE_LIMITS');
  assert.equal(writes,0);
});

test('login throttle keys retain distinct full overlong email identities',async()=>{
  const queries=[];
  const pool={execute:async(sql,params)=>{queries.push({sql,params});return[[]];}};
  const repository=createRepository(pool);const prefix='a'.repeat(254);
  await repository.getLoginAttemptCounts({email:`${prefix}-first@example.test`,ip:'203.0.113.1',now:new Date()});
  await repository.getLoginAttemptCounts({email:`${prefix}-second@example.test`,ip:'203.0.113.1',now:new Date()});
  assert.notEqual(queries[0].params[3],queries[1].params[3]);
  assert.doesNotMatch(queries[0].sql,/a{254}/);
});

test('blocked login reservations report the longest remaining fixed-window delay and roll back',async()=>{
  const now=new Date('2026-01-01T00:00:00.000Z');const expiresAt=(seconds)=>new Date(now.getTime()+seconds*1000);
  const events=[];const queries=[];
  const pool={
    async execute(sql,params){queries.push({sql,params});return[{affectedRows:1}];},
    async getConnection(){return{
      async beginTransaction(){events.push('begin');},
      async execute(sql,params){queries.push({sql,params});if(sql.startsWith('SELECT scope,subject_hash,attempt_count,window_started_at,expires_at FROM login_attempts'))return [[
        {scope:'pair',subject_hash:'a'.repeat(64),attempt_count:2,window_started_at:now,expires_at:expiresAt(19)},
        {scope:'account',subject_hash:'b'.repeat(64),attempt_count:3,window_started_at:now,expires_at:expiresAt(43)},
        {scope:'ip',subject_hash:'c'.repeat(64),attempt_count:1,window_started_at:now,expires_at:expiresAt(8)},
      ]];return[{affectedRows:1}];},
      async commit(){events.push('commit');},
      async rollback(){events.push('rollback');},
      release(){events.push('release');},
    };},
  };
  const repository=createRepository(pool);
  const result=await repository.reserveLoginAttempt({email:'admin@example.test',ip:'203.0.113.1',now,windowMs:900_000,limits:{pair:1,account:2,ip:20}});
  assert.equal(result.allowed,false);
  assert.equal(result.retryAfterSeconds,43);
  assert.deepEqual(events,['begin','rollback','release']);
});

test('initial schema includes durable publish facts, idempotency, and partial delivery state',()=>{
  const sql=fs.readFileSync(require.resolve('../migrations/001_initial.sql'),'utf8');
  for(const field of ['idempotency_key','request_payload','provider_post_id','fact_bearing','fact_ids','partial']) assert.ok(sql.includes(field),`missing ${field}`);
});
test('login throttle migration is restart-safe and expires indexed hashed counters',()=>{
  const files=fs.readdirSync(require('node:path').resolve(__dirname,'../migrations'));
  assert.ok(files.includes('009_login_attempts.sql'));
  const sql=fs.readFileSync(require.resolve('../migrations/009_login_attempts.sql'),'utf8');
  assert.match(sql,/CREATE TABLE IF NOT EXISTS login_attempts/);
  assert.match(sql,/PRIMARY KEY \(scope, subject_hash\)/);
  assert.match(sql,/KEY login_attempts_expires_at \(expires_at\)/);
  assert.match(sql,/attempt_count INT UNSIGNED/);
  assert.doesNotMatch(sql,/ALTER TABLE|DROP TABLE|DROP COLUMN/);
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
