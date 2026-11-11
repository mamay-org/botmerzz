'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');

const enabled = process.env.NODE_ENV === 'test'
  && process.env.DB_NAME === 'merzz_test'
  && ['localhost','127.0.0.1','::1'].includes(process.env.DB_HOST)
  && process.env.ALLOW_DESTRUCTIVE_DB_TESTS === 'true';

test('shadow evaluation persistence, constraints, and reviews on isolated MySQL', {skip:!enabled}, async () => {
  const { loadEnv } = require('../src/config');
  const { createPool } = require('../src/db');
  const { runMigrations } = require('../src/migrate');
  const { createLearningShadowStore } = require('../src/learning-shadow');
  const pool = createPool(loadEnv());
  const email = `shadow-${randomUUID()}@example.test`;
  let adminId;
  let evaluationId;
  let staleEvaluationId;
  let interruptedEvaluationId;
  let peerPool;
  try {
    await runMigrations(pool);
    const [[migration]] = await pool.execute("SELECT COUNT(*) AS n FROM schema_migrations WHERE version='016_learning_shadow_evaluation.sql'");
    assert.equal(Number(migration.n),1);
    const [admin] = await pool.execute('INSERT INTO admins (email,password_hash) VALUES (?,?)',[email,'not-a-real-password-hash']);
    adminId = admin.insertId;
    const store = createLearningShadowStore(pool);
    peerPool=createPool(loadEnv());
    const peerStore=createLearningShadowStore(peerPool);
    const [quotaChecks] = await pool.execute("SELECT COUNT(*) AS n FROM schema_migrations WHERE version='019_learning_shadow_admission.sql'");
    assert.equal(Number(quotaChecks[0].n),1);
    await pool.execute('DELETE FROM learning_shadow_start_limits WHERE actor_id=?',[adminId]);
    for (let index=0;index<3;index++) assert.equal((await store.consumeStartQuota(adminId)).allowed,true);
    const limited = await peerStore.consumeStartQuota(adminId);
    assert.equal(limited.allowed,false); assert.ok(limited.retryAfterSeconds>0);
    await pool.execute('UPDATE learning_shadow_start_limits SET window_started_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 16 MINUTE) WHERE actor_id=?',[adminId]);
    const concurrentQuota=await Promise.all(Array.from({length:6},(_,index)=>(index%2?store:peerStore).consumeStartQuota(adminId)));
    assert.equal(concurrentQuota.filter((item)=>item.allowed).length,3);
    assert.equal(concurrentQuota.filter((item)=>!item.allowed).length,3);

    const firstAdmission=await store.acquireAdmission();
    await assert.rejects(peerStore.acquireAdmission(),{code:'SHADOW_BUSY'});
    await firstAdmission.release();

    const childCode = `const {loadEnv}=require('./src/config');const {createPool}=require('./src/db');const {createLearningShadowStore}=require('./src/learning-shadow');(async()=>{const pool=createPool(loadEnv());const store=createLearningShadowStore(pool);const quota=await store.consumeStartQuota(${Number(adminId)});if(quota.allowed)throw new Error('cross-process quota was not enforced');await store.acquireAdmission();const id=await store.start({actorId:${Number(adminId)},modelId:'provider/model',configurationVersion:'test',ruleVersions:[],retrievalContext:{},sampling:{},requestedSamples:1});process.stdout.write(JSON.stringify({id,quota})+'\\n');setInterval(()=>{},1000);})().catch(()=>process.exit(2));`;
    const worker=spawn(process.execPath,['-e',childCode],{cwd:process.cwd(),env:process.env,stdio:['ignore','pipe','pipe']});
    const childOutput = new Promise((resolve,reject)=>{
      let buffer=''; const timeout=setTimeout(()=>reject(new Error('shadow worker reservation timed out')),10_000);
      worker.stdout.setEncoding('utf8'); worker.stdout.on('data',(chunk)=>{buffer+=chunk;const newline=buffer.indexOf('\n');if(newline>=0){clearTimeout(timeout);resolve(buffer.slice(0,newline));}});
      worker.once('exit',(code)=>{if(code!==null&&code!==0){clearTimeout(timeout);reject(new Error(`shadow worker exited ${code}`));}});
    });
    const workerRecord=JSON.parse(await childOutput);
    assert.equal(workerRecord.quota.allowed,false,'a separate Node process must observe the shared administrator quota');
    assert.ok(workerRecord.quota.retryAfterSeconds>0);
    interruptedEvaluationId=String(workerRecord.id);
    const workerExit=new Promise((resolve,reject)=>{worker.once('exit',resolve);worker.once('error',reject);});
    worker.kill('SIGKILL');
    await workerExit;
    let admissionError;
    for (let retry=0;retry<40;retry++) {
      try { const admission=await store.acquireAdmission(); await admission.release(); break; }
      catch (error) { admissionError=error; if(error.code==='SHADOW_BUSY') await new Promise((resolve)=>setTimeout(resolve,50)); else break; }
    }
    assert.equal(admissionError?.code,'SHADOW_RECOVERY_PENDING','restart must not admit work while a recent interrupted row remains unresolved');
    await pool.execute('UPDATE learning_shadow_evaluations SET created_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 10 MINUTE) WHERE id=?',[interruptedEvaluationId]);
    const recoveredAdmission=await store.acquireAdmission();
    assert.equal((await store.get(interruptedEvaluationId)).failureCode,'SHADOW_WORKER_INTERRUPTED');
    await recoveredAdmission.release();
    evaluationId = await store.start({actorId:adminId,modelId:'provider/model',configurationVersion:'3',ruleVersions:[{id:'7',version:2}],retrievalContext:{productCategory:'topup',contentTopic:'community'},sampling:{temperature:0.3},requestedSamples:1});
    staleEvaluationId = await store.start({actorId:adminId,modelId:'provider/model',configurationVersion:'3',ruleVersions:[],retrievalContext:{},sampling:{},requestedSamples:1});
    await pool.execute('UPDATE learning_shadow_evaluations SET created_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 10 MINUTE) WHERE id=?',[staleEvaluationId]);
    assert.equal(await store.reconcileStale(),1);
    const stale = await store.get(staleEvaluationId);
    assert.equal(stale.status,'failed'); assert.equal(stale.failureCode,'SHADOW_WORKER_INTERRUPTED');
    await assert.rejects(pool.execute(
      'INSERT INTO learning_shadow_evaluations (actor_id,model_id,rule_versions_json,retrieval_context_json,sampling_json,requested_samples,results_json) VALUES (?,?,?,?,?,?,?)',
      [adminId,'provider/model','[{"id":"1"},{"id":"2"},{"id":"3"},{"id":"4"},{"id":"5"},{"id":"6"}]','{}','{}',1,'[]'],
    ));
    assert.equal(await store.finish(evaluationId,{status:'completed',completedSamples:1,providerCalls:2,estimatedMaxTokens:1000,results:[{sampleIndex:1,baseline:{outcome:'passed',validatedCaption:'Asas BM.'},learning:{outcome:'passed',validatedCaption:'Pembelajaran BM.'}}]}),true);
    const run = await store.get(evaluationId);
    assert.equal(run.id,String(evaluationId));
    assert.equal(run.actorId,String(adminId));
    assert.equal(run.results[0].learning.validatedCaption,'Pembelajaran BM.');
    const review = await store.recordReview(evaluationId,{sampleIndex:1,variant:'learning',feedbackType:'positive',ratings:{hook:4,language:5}},adminId);
    assert.equal(review.evaluationId,String(evaluationId));
    assert.equal((await store.listReviews(evaluationId)).length,1);
    await assert.rejects(store.recordReview(evaluationId,{sampleIndex:1,variant:'learning',feedbackType:'positive',ratings:{hook:4}},adminId),{code:'SHADOW_REVIEW_EXISTS'});
    assert.ok((await store.list({limit:10})).evaluations.some((item)=>item.id===String(evaluationId)));
  } finally {
    for (const id of [evaluationId,staleEvaluationId,interruptedEvaluationId].filter(Boolean)) {
      await pool.execute('DELETE FROM learning_shadow_reviews WHERE evaluation_id=?',[id]);
      await pool.execute('DELETE FROM learning_shadow_evaluations WHERE id=?',[id]);
    }
    if (adminId) await pool.execute('DELETE FROM learning_shadow_start_limits WHERE actor_id=?',[adminId]);
    if (adminId) await pool.execute('DELETE FROM admins WHERE id=?',[adminId]);
    await peerPool?.end();
    await pool.end();
  }
});
