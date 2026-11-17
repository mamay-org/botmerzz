'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {randomUUID} = require('node:crypto');
const execFileAsync=promisify(execFile);
const container=process.env.BOTMERZZ_TEST_MYSQL_CONTAINER||'';
const enabled=process.env.NODE_ENV==='test'&&process.env.DB_NAME==='merzz_test'
  &&['localhost','127.0.0.1','::1'].includes(process.env.DB_HOST)
  &&process.env.ALLOW_DESTRUCTIVE_DB_TESTS==='true'
  &&/^botmerzz-p1-final-[a-z0-9-]+$/i.test(container);

test('MySQL restart cancels shadow admission and a new worker waits for ambiguous running results',{skip:!enabled},async()=>{
  const {loadEnv}=require('../src/config');
  const {createPool,endOptionalPoolBounded}=require('../src/db');
  const {runMigrations}=require('../src/migrate');
  const {createLearningShadowStore}=require('../src/learning-shadow');
  const email=`shadow-db-restart-${randomUUID()}@example.test`;
  const config=loadEnv();
  const pool=createPool(config);
  let recoveryPool;
  let adminId;
  let evaluationId;
  let admission;
  try{
    await runMigrations(pool);
    const [admin]=await pool.execute('INSERT INTO admins (email,password_hash) VALUES (?,?)',[email,'not-a-real-password-hash']);
    adminId=admin.insertId;
    const store=createLearningShadowStore(pool);
    await pool.execute("UPDATE learning_shadow_evaluations SET created_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 10 MINUTE) WHERE status='running'");
    await store.reconcileStale();
    admission=await store.acquireAdmission();
    evaluationId=await store.start({actorId:adminId,modelId:'provider/model',configurationVersion:'test',ruleVersions:[],retrievalContext:{},sampling:{},requestedSamples:1});
    const lockLost=new Promise((resolve)=>admission.signal.addEventListener('abort',resolve,{once:true}));
    await execFileAsync('docker',['restart',container],{timeout:30_000});
    await store.get(evaluationId).catch(()=>{});
    await admission.assertHealthy().catch(()=>{});
    await Promise.race([lockLost,new Promise((resolve)=>setTimeout(resolve,5_000))]);
    assert.equal(admission.signal.aborted,true,'closing the MySQL lock connection must stop new provider work');
    await admission.release();
    admission=null;

    recoveryPool=createPool(config);
    let ready=false;
    for(let attempt=0;attempt<60&&!ready;attempt++){
      try{await recoveryPool.execute('SELECT 1');ready=true;}
      catch{await new Promise((resolve)=>setTimeout(resolve,250));}
    }
    assert.equal(ready,true,'isolated MySQL must become ready after restart');
    await runMigrations(recoveryPool);
    const recoveredStore=createLearningShadowStore(recoveryPool);
    await assert.rejects(recoveredStore.acquireAdmission(),{code:'SHADOW_RECOVERY_PENDING'});
    await recoveryPool.execute('UPDATE learning_shadow_evaluations SET created_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 10 MINUTE) WHERE id=?',[evaluationId]);
    const recoveredAdmission=await recoveredStore.acquireAdmission();
    assert.equal((await recoveredStore.get(evaluationId)).failureCode,'SHADOW_WORKER_INTERRUPTED');
    await recoveredAdmission.release();
  }finally{
    await admission?.release().catch(()=>{});
    if(!recoveryPool)recoveryPool=createPool(config);
    if(evaluationId){
      await recoveryPool.execute('DELETE FROM learning_shadow_reviews WHERE evaluation_id=?',[evaluationId]).catch(()=>{});
      await recoveryPool.execute('DELETE FROM learning_shadow_evaluations WHERE id=?',[evaluationId]).catch(()=>{});
    }
    if(adminId)await recoveryPool.execute('DELETE FROM learning_shadow_start_limits WHERE actor_id=?',[adminId]).catch(()=>{});
    if(adminId)await recoveryPool.execute('DELETE FROM admins WHERE id=?',[adminId]).catch(()=>{});
    await endOptionalPoolBounded(pool,1000);
    await endOptionalPoolBounded(recoveryPool,1000);
  }
});
