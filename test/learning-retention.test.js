'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { purgeExpiredEvidence } = require('../src/learning-retention');
const { sanitizeCaptionEvidence } = require('../src/learning-evidence');

test('caption evidence is withheld by default without exposing an identifying fingerprint', () => {
  assert.deepEqual(sanitizeCaptionEvidence('private opaque secret'), {status:'unavailable',reason:'policy_withheld',excerpt:null,fingerprint:null});
  assert.equal(sanitizeCaptionEvidence('').reason, 'missing');
});

test('retention clears only evidence fields, commits bounded batches and can rerun', async () => {
  const calls=[]; let done=false;
  const connection={beginTransaction:async()=>calls.push('begin'),commit:async()=>{calls.push('commit');done=true;},rollback:async()=>calls.push('rollback'),release:()=>calls.push('release'),execute:async(sql,args)=>{
    calls.push({sql,args});
    if(sql.startsWith('SELECT COUNT(*)')) return [[{count:0,oldest:null}]];
    if(sql.startsWith('SELECT event_id')) return [done ? [] : [{event_id:'e1',candidate_id:2}]];
    if(sql.startsWith('SELECT c.id')) return [done ? [] : [{id:3}]];
    return [{affectedRows:1}];
  }};
  const pool={getConnection:async()=>connection};
  const options={pool,retentionDays:30,batchSize:2,now:new Date('2026-01-31T00:00:00Z')};
  const first=await purgeExpiredEvidence(options);
  assert.equal(first.events,1); assert.equal(first.legacyCandidates,1);
  assert.equal(first.expiredEventBacklog,0); assert.equal(first.expiredLegacyBacklog,0);
  assert.equal(first.oldestExpiredAgeMs,0); assert.ok(first.cleanupDurationMs>=0);
  const second=await purgeExpiredEvidence(options);
  assert.equal(second.events,0); assert.equal(second.legacyCandidates,0);
  const sql=calls.filter(x=>x.sql).map(x=>x.sql).join('\n');
  assert.doesNotMatch(sql,/\bDELETE\b|learning_reviews|learning_rules|\bslots\b/i);
  assert.match(sql,/evidence_fingerprint\s*=\s*NULL/);
  assert.ok(calls.includes('commit'));
});

test('retention rolls back failed batches and validates bounds', async () => {
  let rollback=false; let released=false;
  const pool={getConnection:async()=>({beginTransaction:async()=>{},execute:async()=>{throw Error('unavailable');},rollback:async()=>{rollback=true;},release:()=>{released=true;}})};
  await assert.rejects(purgeExpiredEvidence({pool,retentionDays:30,batchSize:10}),/unavailable/);
  assert.equal(rollback,true); assert.equal(released,true);
  await assert.rejects(purgeExpiredEvidence({pool,retentionDays:0,batchSize:10}),TypeError);
  await assert.rejects(purgeExpiredEvidence({pool,retentionDays:30,batchSize:1001}),TypeError);
});
