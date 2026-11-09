const test=require('node:test');
const assert=require('node:assert/strict');
const enabled=process.env.NODE_ENV==='test'&&process.env.DB_NAME==='merzz_test'&&process.env.ALLOW_DESTRUCTIVE_DB_TESTS==='true';

test('confirmed cancellation atomically settles provider state across repository restart', {skip:!enabled}, async()=>{
  const {randomUUID,createHash}=require('node:crypto');
  const {loadEnv}=require('../src/config');const {createPool}=require('../src/db');const {runMigrations}=require('../src/migrate');const {createRepository}=require('../src/repository');
  const pool=createPool(loadEnv());const id=randomUUID();const postId=`cancel-${randomUUID()}`;
  try {
    await runMigrations(pool);
    await pool.execute("INSERT INTO slots (id,scheduled_at,status,provider_status,provider_post_id) VALUES (?,?,'publishing','scheduled',?)",[id,new Date(),postId]);
    const noticeKey=createHash('sha256').update(`unknown_outcome:slot:${id}`).digest('hex');
    await createRepository(pool).enqueueNotification({dedupeKey:noticeKey,message:'Pending verification'});
    assert.equal(await createRepository(pool).recordCancellation(postId,{status:'canceled'}),true);
    const [[slot]]=await pool.execute('SELECT status,provider_status,cancellation_status,completed_at FROM slots WHERE id=?',[id]);
    assert.equal(slot.status,'canceled');assert.equal(slot.provider_status,'canceled');assert.equal(slot.cancellation_status,'canceled');assert.ok(slot.completed_at);
    assert.equal((await createRepository(pool).listUnsettledSlots()).some(item=>item.id===id),false);
    assert.equal(await createRepository(pool).getNotificationStatus(noticeKey),'failed');
  } finally { await pool.execute('DELETE FROM slots WHERE id=?',[id]);await pool.execute('DELETE FROM notification_outbox WHERE dedupe_key=?',[createHash('sha256').update(`unknown_outcome:slot:${id}`).digest('hex')]);await pool.end(); }
});

test('MySQL login throttles are shared and bound concurrent attempts across auth instances', {skip:!enabled}, async()=>{
  const {createHash,randomUUID}=require('node:crypto');
  const {loadEnv}=require('../src/config');const {createPool}=require('../src/db');const {runMigrations}=require('../src/migrate');const {createRepository}=require('../src/repository');const {createAuth}=require('../src/auth');
  const pool=createPool(loadEnv());const email=`throttle-${randomUUID()}@example.test`;const normalizedEmail=email.toLowerCase();const firstIp='192.0.2.101';const secondIp='192.0.2.102';const raceEmail=`parallel-${randomUUID()}@example.test`;const raceIps=['192.0.2.111','192.0.2.112','192.0.2.113','192.0.2.114'];const now=new Date();
  const hash=(scope,value)=>createHash('sha256').update(`${scope}\0${value}`).digest('hex');
  try{
    await runMigrations(pool);
    const firstRepository=createRepository(pool);const secondRepository=createRepository(pool);
    const options={clock:()=>now,maxFailures:20,maxFailuresPerAccount:1,maxFailuresPerIp:20,windowMs:60_000};
    const firstAuth=createAuth({repository:firstRepository,...options});const secondAuth=createAuth({repository:secondRepository,...options});
    await assert.rejects(firstAuth.login({email,password:'incorrect password',ip:firstIp}),error=>error.code==='INVALID_CREDENTIALS');
    await assert.rejects(secondAuth.login({email:email.toUpperCase(),password:'incorrect password',ip:secondIp}),error=>error.code==='LOGIN_RATE_LIMITED');
    assert.deepEqual(await secondRepository.getLoginAttemptCounts({email:normalizedEmail,ip:secondIp,now}),{pair:0,account:1,ip:0});
    const expiredAt=new Date(now.getTime()+60_001);
    assert.deepEqual(await secondRepository.getLoginAttemptCounts({email:normalizedEmail,ip:secondIp,now:expiredAt}),{pair:0,account:0,ip:0});
    const raceOptions={clock:()=>now,maxFailures:20,maxFailuresPerAccount:2,maxFailuresPerIp:20,windowMs:60_000};
    const raceAuths=[createAuth({repository:firstRepository,...raceOptions}),createAuth({repository:secondRepository,...raceOptions})];
    const results=await Promise.all(raceIps.map((ip,index)=>raceAuths[index%2].login({email:raceEmail,password:`wrong password ${index}`,ip}).then(
      ()=>({code:'UNEXPECTED_SUCCESS'}),error=>({code:error.code}),
    )));
    assert.equal(results.filter(result=>result.code==='INVALID_CREDENTIALS').length,2);
    assert.equal(results.filter(result=>result.code==='LOGIN_RATE_LIMITED').length,2);
    const raceCounts=await Promise.all(raceIps.map(ip=>secondRepository.getLoginAttemptCounts({email:raceEmail,ip,now})));
    assert.equal(raceCounts.reduce((total,counts)=>total+counts.account,0),raceIps.length*2);
    assert.equal(raceCounts.reduce((total,counts)=>total+counts.pair,0),2);
    assert.equal(raceCounts.reduce((total,counts)=>total+counts.ip,0),2);
  }finally{
    const keys=[[firstIp,normalizedEmail],[secondIp,normalizedEmail],...raceIps.map(ip=>[ip,raceEmail.toLowerCase()])]
      .flatMap(([ip,account])=>[['pair',hash('pair',`${ip}\0${account}`)],['ip',hash('ip',ip)]])
      .concat([['account',hash('account',normalizedEmail)],['account',hash('account',raceEmail.toLowerCase())]]);
    const conditions=keys.map(()=>'(scope=? AND subject_hash=?)').join(' OR ');
    await pool.execute(`DELETE FROM login_attempts WHERE ${conditions}`,keys.flat());
    await pool.end();
  }
});

test('MySQL migrations and repository are reachable in integration environment',{skip:!enabled},async()=>{
  const {loadEnv}=require('../src/config');const {createPool}=require('../src/db');const {runMigrations}=require('../src/migrate');const {createRepository}=require('../src/repository');
  const config=loadEnv();let pool=createPool(config);
  try {
    await runMigrations(pool);
    await pool.execute("DELETE FROM schema_migrations WHERE version='002_notification_outbox.sql'");
    assert.deepEqual(await runMigrations(pool),['002_notification_outbox.sql']);
    await pool.execute("DELETE FROM schema_migrations WHERE version='003_multi_admin.sql'");
    assert.deepEqual(await runMigrations(pool),['003_multi_admin.sql']);
    await pool.execute("DELETE FROM schema_migrations WHERE version='006_automation_sessions.sql'");
    assert.deepEqual(await runMigrations(pool),['006_automation_sessions.sql']);
    await pool.execute("DELETE FROM schema_migrations WHERE version='008_notification_message_capacity.sql'");
    assert.deepEqual(await runMigrations(pool),['008_notification_message_capacity.sql']);
    const repo=createRepository(pool);
    assert.equal(await repo.healthCheck(),true);
    const settings=await repo.getSettings();assert.equal(settings.automationEnabled,false);assert.deepEqual(settings.hashtags,[]);
    const contentDirection='Utamakan soalan santai tentang pengalaman bermain bersama kawan.';
    const hookVocabulary=['Cerita pengalaman','Sembang santai'];
    const savedHashtags=await repo.saveSettings({...settings,hashtags:['#KedaiMerzz','#MobileLegends'],brand:{...(settings.brand||{}),contentDirection},guardrails:{...(settings.guardrails||{}),hookVocabulary}},null);
    assert.deepEqual(savedHashtags.hashtags,['#KedaiMerzz','#MobileLegends']);
    assert.equal(savedHashtags.brand.contentDirection,contentDirection);
    assert.deepEqual(savedHashtags.guardrails.hookVocabulary,hookVocabulary);
    const [[storedHashtagSettings]]=await pool.execute('SELECT settings_json, knowledge_json FROM settings WHERE id=1');
    const storedHashtagJson=typeof storedHashtagSettings.settings_json==='string'?storedHashtagSettings.settings_json:JSON.stringify(storedHashtagSettings.settings_json);
    assert.deepEqual(JSON.parse(storedHashtagJson).hashtags,['#KedaiMerzz','#MobileLegends']);
    assert.equal(JSON.parse(storedHashtagJson).brand.contentDirection,contentDirection);
    const storedKnowledgeJson=typeof storedHashtagSettings.knowledge_json==='string'?storedHashtagSettings.knowledge_json:JSON.stringify(storedHashtagSettings.knowledge_json);
    assert.deepEqual(JSON.parse(storedKnowledgeJson).guardrails.hookVocabulary,hookVocabulary);
    assert.deepEqual((await repo.getSettings()).guardrails.hookVocabulary,hookVocabulary);
    await pool.execute("DELETE FROM schema_migrations WHERE version='005_hashtags_default.sql'");
    assert.deepEqual(await runMigrations(pool),['005_hashtags_default.sql']);
    assert.deepEqual((await repo.getSettings()).hashtags,['#KedaiMerzz','#MobileLegends']);
    await repo.saveSettings({...await repo.getSettings(),hashtags:settings.hashtags,brand:settings.brand,guardrails:settings.guardrails},null);
    const facts=await repo.listFacts();assert.equal(typeof facts,'object');
    const dedupeKey=require('node:crypto').randomBytes(32).toString('hex');
    const longKey=require('node:crypto').randomBytes(32).toString('hex');
    assert.equal(await repo.enqueueNotification({dedupeKey:longKey,message:'x'.repeat(4000)}),true);
    const [[longRow]]=await pool.execute('SELECT CHAR_LENGTH(message) AS n FROM notification_outbox WHERE dedupe_key=?',[longKey]);
    assert.equal(Number(longRow.n),4000);
    assert.equal(await repo.enqueueNotification({dedupeKey,message:'Integration test notification'}),true);
    assert.equal(await repo.enqueueNotification({dedupeKey,message:'Integration test notification'}),false);
    const claimed=await repo.claimNotifications(10);
    const notice=claimed.find((row)=>row.message==='Integration test notification');
    assert.ok(notice);
    await repo.markNotificationSent(notice.id);
    assert.equal(await repo.getNotificationStatus(dedupeKey),'sent');
    const {createHash,randomUUID}=require('node:crypto');
    const {hashPassword}=require('../src/auth');
    await pool.execute('DELETE FROM admins');
    const first=await repo.createAdmin({email:`first-${randomUUID()}@example.test`,passwordHash:await hashPassword('first secure password')});
    const second=await repo.createAdmin({email:`second-${randomUUID()}@example.test`,passwordHash:await hashPassword('second secure password'),actorId:first.id});
    assert.equal((await repo.listAdmins()).length,2);
    const savedTemplate=await repo.createTemplate({name:`Account-${randomUUID()}`,category:'account',data:{attributes:['Rank Mythic']},actorId:first.id});
    assert.deepEqual((await repo.listTemplates()).find(item=>item.id===savedTemplate.id).data,{attributes:['Rank Mythic']});
    assert.equal((await repo.updateTemplate(savedTemplate.id,{name:`Updated-${randomUUID()}`,actorId:second.id})).updatedBy,second.id);
    assert.equal(await repo.deleteTemplate(savedTemplate.id,first.id),true);
    assert.equal(await repo.getTemplate(savedTemplate.id),null);
    const sessionToken=randomUUID().replaceAll('-','').padEnd(64,'a').slice(0,64);
    await repo.createSession({tokenHash:sessionToken,adminId:second.id,csrfToken:'c'.repeat(64),expiresAt:new Date(Date.now()+3600000)});
    const unchanged=await repo.updateAdmin(second.id,{email:second.email},first.id);
    assert.equal(unchanged.credentialsChanged,false);
    assert.ok(await repo.getSession(sessionToken));
    const changed=await repo.updateAdmin(second.id,{email:`changed-${randomUUID()}@example.test`,passwordHash:await hashPassword('updated secure password')},first.id);
    assert.equal(changed.active,true);
    assert.equal(await repo.getSession(sessionToken),null);
    await repo.updateAdmin(second.id,{active:false},first.id);
    await assert.rejects(repo.updateAdmin(first.id,{active:false},first.id),error=>error.code==='LAST_ADMIN');
    assert.deepEqual((await repo.listAdmins()).filter(admin=>admin.active).map(admin=>admin.id),[first.id]);
    await pool.execute('DELETE FROM admins');
    const profileId=`test-profile-${randomUUID()}`;const accountId=`test-account-${randomUUID()}`;const eventId=randomUUID();
    await repo.setProviderTarget({accountId,profileId});
    await repo.applyWebhookEvent({eventId,payloadHash:createHash('sha256').update(eventId).digest('hex'),type:'account.disconnected',profileId,data:{account:{id:accountId}},accountId,notificationCode:'account_disconnected'});
    const eventKey=createHash('sha256').update(`tebar:${eventId}`).digest('hex');
    const [[queued]]=await pool.execute('SELECT COUNT(*) count FROM notification_outbox WHERE dedupe_key=?',[eventKey]);
    assert.equal(Number(queued.count),1);
    const publishedEventId=randomUUID();const publishedPostId=`post-${randomUUID()}`;const publishedSlotId=randomUUID();const webhookPublishedAt=new Date(Date.now()-2*60*1000);
    await pool.execute("INSERT INTO slots (id,scheduled_at,status,provider_post_id,request_payload,tebar_profile_id,tebar_account_id,tebar_config_version) VALUES (?,?,'published',?,?,?,?,1)",[
      publishedSlotId,new Date(Date.now()+Math.floor(Math.random()*1000)),publishedPostId,JSON.stringify({targets:[{account_id:accountId}]}),profileId,accountId,
    ]);
    await repo.applyWebhookEvent({eventId:publishedEventId,payloadHash:createHash('sha256').update(publishedEventId).digest('hex'),type:'post.published',profileId,data:{post_id:publishedPostId,account_id:accountId,status:'published',published_at:webhookPublishedAt.toISOString()},accountId,notificationCode:'post_published'});
    const publishedDedupeKey=createHash('sha256').update(`post_published:slot:${publishedSlotId}`).digest('hex');
    const pendingUnknownKey=createHash('sha256').update(`unknown_outcome:slot:${publishedSlotId}`).digest('hex');
    await repo.enqueueNotification({dedupeKey:pendingUnknownKey,message:'Pending verification'});
    await repo.updateSlot(publishedSlotId,{status:'published'});
    assert.equal(await repo.getNotificationStatus(pendingUnknownKey),'failed','a confirmed outcome supersedes a queued unknown notification');
    const [[publishedNotice]]=await pool.execute('SELECT message FROM notification_outbox WHERE dedupe_key=?',[publishedDedupeKey]);
    assert.match(publishedNotice.message,/POSTING BERHASIL/);
    assert.match(publishedNotice.message,new RegExp(`Slot ID: ${publishedSlotId}$`));
    const [[publishedSnapshot]]=await pool.execute('SELECT status,provider_status,completed_at FROM slots WHERE id=?',[publishedSlotId]);
    assert.equal(new Date(publishedSnapshot.completed_at).getTime(),webhookPublishedAt.getTime(),'webhook publication time anchors hourly cadence');
    const delayedScheduledEventId=randomUUID();
    await repo.applyWebhookEvent({eventId:delayedScheduledEventId,payloadHash:createHash('sha256').update(delayedScheduledEventId).digest('hex'),type:'post.scheduled',profileId,data:{post_id:publishedPostId,account_id:accountId,status:'scheduled'},accountId,notificationCode:null});
    const [[afterScheduledWebhook]]=await pool.execute('SELECT status,provider_status,completed_at FROM slots WHERE id=?',[publishedSlotId]);
    assert.equal(afterScheduledWebhook.status,publishedSnapshot.status,'a delayed scheduled event cannot regress a terminal local status');
    assert.equal(afterScheduledWebhook.provider_status,publishedSnapshot.provider_status,'a delayed scheduled event cannot replace the confirmed provider status');
    assert.equal(new Date(afterScheduledWebhook.completed_at).getTime(),new Date(publishedSnapshot.completed_at).getTime(),'a delayed scheduled event cannot clear or move the completion timestamp');
    const delayedCanceledEventId=randomUUID();
    await repo.applyWebhookEvent({eventId:delayedCanceledEventId,payloadHash:createHash('sha256').update(delayedCanceledEventId).digest('hex'),type:'post.canceled',profileId,data:{post_id:publishedPostId,account_id:accountId,status:'canceled'},accountId,notificationCode:'provider_error'});
    const [[afterCanceledWebhook]]=await pool.execute('SELECT status,provider_status,completed_at FROM slots WHERE id=?',[publishedSlotId]);
    assert.equal(afterCanceledWebhook.status,publishedSnapshot.status,'a stale cancellation cannot replace a terminal published outcome');
    assert.equal(afterCanceledWebhook.provider_status,publishedSnapshot.provider_status);
    assert.equal(new Date(afterCanceledWebhook.completed_at).getTime(),new Date(publishedSnapshot.completed_at).getTime());
    const delayedCanceledKey=createHash('sha256').update(`tebar:${delayedCanceledEventId}`).digest('hex');
    const [[delayedCanceledNotice]]=await pool.execute('SELECT COUNT(*) count FROM notification_outbox WHERE dedupe_key=?',[delayedCanceledKey]);
    assert.equal(Number(delayedCanceledNotice.count),0,'a stale cancellation must not enqueue a fresh failure notice');
    const unrelatedId=randomUUID();
    await repo.applyWebhookEvent({eventId:unrelatedId,payloadHash:createHash('sha256').update(unrelatedId).digest('hex'),type:'account.disconnected',profileId:`other-${profileId}`,data:{account:{id:accountId}},accountId,notificationCode:'account_disconnected'});
    const unrelatedKey=createHash('sha256').update(`tebar:${unrelatedId}`).digest('hex');
    const [[unrelated]]=await pool.execute('SELECT COUNT(*) count FROM notification_outbox WHERE dedupe_key=?',[unrelatedKey]);
    assert.equal(Number(unrelated.count),0);
    const oldSlotId=randomUUID(); const oldPostId=`old-post-${randomUUID()}`;
    await pool.execute("INSERT INTO slots (id,scheduled_at,status,provider_post_id,request_payload,tebar_profile_id,tebar_account_id,tebar_config_version) VALUES (?,?,'publishing',?,?,?,?,1)",[oldSlotId,new Date(),oldPostId,JSON.stringify({targets:[{account_id:accountId}]}),profileId,accountId]);
    await repo.setProviderTarget({profileId:`new-profile-${randomUUID()}`,accountId:`new-account-${randomUUID()}`});
    const oldPublishedEvent=randomUUID();
    await repo.applyWebhookEvent({eventId:oldPublishedEvent,payloadHash:createHash('sha256').update(oldPublishedEvent).digest('hex'),type:'post.published',profileId,data:{post_id:oldPostId,account_id:accountId,status:'published'},notificationCode:'post_published'});
    const [[oldPublished]]=await pool.execute('SELECT status,provider_status FROM slots WHERE id=?',[oldSlotId]);
    assert.equal(oldPublished.status,'published','old profile webhook must match immutable slot target');
    const lateFailure=randomUUID();
    await repo.applyWebhookEvent({eventId:lateFailure,payloadHash:createHash('sha256').update(lateFailure).digest('hex'),type:'post.failed',profileId,data:{post_id:oldPostId,account_id:accountId,status:'failed'},notificationCode:'provider_error'});
    const [[afterLateFailure]]=await pool.execute('SELECT status,provider_status FROM slots WHERE id=?',[oldSlotId]);
    assert.equal(afterLateFailure.status,'published','late terminal event must not reverse confirmed publication');
    assert.equal(afterLateFailure.provider_status,'published');
    await repo.updateSlot(oldSlotId,{status:'publishing',providerStatus:'scheduled'});
    const [[afterStaleRead]]=await pool.execute('SELECT status,provider_status FROM slots WHERE id=?',[oldSlotId]);
    assert.equal(afterStaleRead.status,'published','stale reconciliation must not overwrite a terminal webhook');
    assert.equal(afterStaleRead.provider_status,'published');
    await pool.execute('DELETE FROM slots WHERE id=?',[oldSlotId]);
    const raceSlotId=randomUUID(); const racePostId=`race-post-${randomUUID()}`;
    await pool.execute("INSERT INTO slots (id,scheduled_at,status,provider_status,provider_post_id,request_payload,tebar_profile_id,tebar_account_id,tebar_config_version) VALUES (?,?,'canceled','canceled',?,?,?,?,1)",[raceSlotId,new Date(),racePostId,JSON.stringify({targets:[{account_id:accountId}]}),profileId,accountId]);
    const conflictEvent=randomUUID();
    await repo.applyWebhookEvent({eventId:conflictEvent,payloadHash:createHash('sha256').update(conflictEvent).digest('hex'),type:'post.published',profileId,data:{post_id:racePostId,account_id:accountId,status:'published'},notificationCode:'post_published'});
    const [[conflict]]=await pool.execute('SELECT status,provider_status FROM slots WHERE id=?',[raceSlotId]);
    assert.equal(conflict.status,'unknown','publication after cancellation requires provider reconciliation');
    await repo.recordCancellation(racePostId,{status:'canceled'});
    await repo.updateSlot(raceSlotId,{status:'canceled',providerStatus:'canceled',completedAt:new Date().toISOString()});
    const [[afterStaleCancellation]]=await pool.execute('SELECT status,error_code FROM slots WHERE id=?',[raceSlotId]);
    assert.equal(afterStaleCancellation.status,'unknown','stale cancellation must not clear a publication conflict');
    assert.equal(afterStaleCancellation.error_code,'provider_status_conflict');
    const {reconcileUnsettled}=require('../src/dispatcher');
    const realList=await repo.listUnsettledSlots();
    const raceRepo={...repo,listUnsettledSlots:async()=>realList.filter(item=>item.id===raceSlotId)};
    await reconcileUnsettled({repository:raceRepo,publisherForProfile:async profile=>({getPost:async()=>({id:racePostId,status:'published',targets:[{accountId,platform:'threads',status:'published'}]})})});
    const [[resolvedConflict]]=await pool.execute('SELECT status FROM slots WHERE id=?',[raceSlotId]);
    assert.equal(resolvedConflict.status,'published','provider confirmation resolves a cancellation/publication conflict');
    await pool.execute('DELETE FROM slots WHERE id=?',[raceSlotId]);
    const conflictingGetSlot=randomUUID();
    await pool.execute("INSERT INTO slots (id,scheduled_at,status,provider_status,provider_post_id) VALUES (?,?,'canceled','canceled',?)",[conflictingGetSlot,new Date(),`get-conflict-${randomUUID()}`]);
    await repo.updateSlot(conflictingGetSlot,{status:'published',providerStatus:'published'});
    const [[conflictingGet]]=await pool.execute('SELECT status,provider_status FROM slots WHERE id=?',[conflictingGetSlot]);
    assert.equal(conflictingGet.status,'unknown','conflicting publication from a stale provider response requires verification');
    await pool.execute('DELETE FROM slots WHERE id=?',[conflictingGetSlot]);
    const concurrentSlotId=randomUUID(); const concurrentPostId=`concurrent-post-${randomUUID()}`;const concurrentEvent=randomUUID();
    await pool.execute("INSERT INTO slots (id,scheduled_at,status,provider_post_id,request_payload,tebar_profile_id,tebar_account_id,tebar_config_version) VALUES (?,?,'publishing',?,?,?,?,1)",[concurrentSlotId,new Date(),concurrentPostId,JSON.stringify({targets:[{account_id:accountId}]}),profileId,accountId]);
    await Promise.all([
      repo.applyWebhookEvent({eventId:concurrentEvent,payloadHash:createHash('sha256').update(concurrentEvent).digest('hex'),type:'post.published',profileId,data:{post_id:concurrentPostId,account_id:accountId,status:'published'},notificationCode:'post_published'}),
      repo.updateSlot(concurrentSlotId,{status:'publishing',providerStatus:'scheduled'}),
    ]);
    const [[concurrentResult]]=await pool.execute('SELECT status,provider_status FROM slots WHERE id=?',[concurrentSlotId]);
    assert.equal(concurrentResult.status,'published','concurrent stale response cannot overwrite confirmed publication');
    assert.equal(concurrentResult.provider_status,'published');
    await pool.execute('DELETE FROM slots WHERE id=?',[concurrentSlotId]);
    await repo.setProviderTarget({profileId,accountId});
    const localDate=`${2100+Math.floor(Math.random()*7000)}-01-01`;
    assert.equal(await repo.claimDailySummary({localDate,timezone:'Asia/Kuala_Lumpur'}),true);
    assert.equal(await repo.claimDailySummary({localDate,timezone:'Asia/Kuala_Lumpur'}),false);
    await pool.execute("UPDATE daily_summaries SET created_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 11 MINUTE) WHERE local_date=? AND timezone=?",[localDate,'Asia/Kuala_Lumpur']);
    assert.equal(await repo.claimDailySummary({localDate,timezone:'Asia/Kuala_Lumpur'}),true);
    await repo.finishDailySummary({localDate,timezone:'Asia/Kuala_Lumpur',status:'sent'});
    assert.equal(await repo.claimDailySummary({localDate,timezone:'Asia/Kuala_Lumpur'}),false);

    const reportIds=[randomUUID(),randomUUID(),randomUUID()];
    try {
      for (const [i,status] of ['published','failed','unknown'].entries()) {
        await pool.execute('INSERT INTO slots (id,scheduled_at,status,pillar,error_code) VALUES (?,?,?,?,?)',
          [reportIds[i],new Date(`${localDate}T04:00:0${i}.000Z`),status,'topup',status==='failed'?'content_validation_failed':null]);
      }
      const report=await repo.getDailySummary({localDate,timezone:'Asia/Kuala_Lumpur'});
      assert.equal(report.published,1);assert.equal(report.failed,1);assert.equal(report.unknown,1);
      assert.deepEqual(report.categories,{topup:1});
      assert.deepEqual(report.failures,[{code:'content_validation_failed',count:1}]);
      assert.deepEqual(new Set(report.affectedSlotIds),new Set(reportIds.slice(1)));
    } finally { for(const id of reportIds) await pool.execute('DELETE FROM slots WHERE id=?',[id]); }

    const mysqlDateSlotId=randomUUID();
    const expectedIsoCompletedAt='2026-11-07T01:29:30.083Z';
    await pool.execute("INSERT INTO slots (id,scheduled_at,status) VALUES (?,?, 'pending')",[mysqlDateSlotId,new Date()]);
    try {
      await repo.updateSlot(mysqlDateSlotId,{completedAt:expectedIsoCompletedAt});
      const [[isoCompletedAtRow]]=await pool.execute('SELECT completed_at FROM slots WHERE id=?',[mysqlDateSlotId]);
      assert.equal(new Date(isoCompletedAtRow.completed_at).toISOString(),expectedIsoCompletedAt,'ISO completion timestamps persist as exact UTC milliseconds');
      await assert.rejects(repo.updateSlot(mysqlDateSlotId,{completedAt:'not-a-valid-timestamp'}),{code:'INVALID_COMPLETED_AT'});

      const reconciledSlotId=randomUUID();
      const reconciledPostId=`post-${randomUUID()}`;
      await pool.execute("INSERT INTO slots (id,scheduled_at,status,provider_post_id,request_payload) VALUES (?,?, 'publishing',?,?)",[
        reconciledSlotId,new Date(),reconciledPostId,JSON.stringify({targets:[{account_id:'threads-account'}]}),
      ]);
      try {
        const {reconcileUnsettled}=require('../src/dispatcher');
        const reconciliationRepository={...repo,listUnsettledSlots:async()=>[{id:reconciledSlotId,providerPostId:reconciledPostId,requestPayload:{targets:[{account_id:'threads-account'}]}}]};
        const reconciled=await reconcileUnsettled({repository:reconciliationRepository,publisher:{getPost:async()=>({
          id:reconciledPostId,status:'published',targets:[{accountId:'threads-account',platform:'threads',status:'published',publishedAt:expectedIsoCompletedAt}],
        })},clock:()=>new Date('2026-11-07T01:30:00.000Z')});
        assert.equal(reconciled,1);
        const [[reconciledCompletedAt]]=await pool.execute('SELECT completed_at FROM slots WHERE id=?',[reconciledSlotId]);
        assert.equal(new Date(reconciledCompletedAt.completed_at).toISOString(),expectedIsoCompletedAt,'reconciliation provider time reaches MySQL as UTC datetime');
      } finally {
        await pool.execute('DELETE FROM slots WHERE id=?',[reconciledSlotId]);
      }
    } finally {
      await pool.execute('DELETE FROM slots WHERE id=?',[mysqlDateSlotId]);
    }

    const [[previousSettings]]=await pool.execute('SELECT settings_json,knowledge_json,automation_enabled FROM settings WHERE id=1');
    const jsonValue=(value)=>typeof value==='string'?value:JSON.stringify(value);
    const priorSettingsJson=jsonValue(previousSettings.settings_json);
    const priorKnowledgeJson=jsonValue(previousSettings.knowledge_json);
    let testSlotId;
    try {
      const testSettings={
        schedule:{intervalHours:6,timezone:'Asia/Kuala_Lumpur',activeDays:[1,2,3,4,5,6,7],activeStart:'00:00',activeEnd:'00:00'},
        priceMode:'OFF',gameWhitelist:['Mobile Legends'],brand:{name:'Kedai Merzz',voice:'Santai'},
        guardrails:{approved:true,forbiddenClaims:[],approvedClaims:[]},
        trackedLinks:{topup:'https://kedaimerzz.com/topup',account:'https://kedaimerzz.com/akun'},
        targetAccountId:`scheduler-test-${randomUUID()}`,profileId:`profile-test-${randomUUID()}`,onboardingComplete:true,automationSessionId:randomUUID(),
      };
      await pool.execute('UPDATE settings SET settings_json=?,knowledge_json=?,automation_enabled=TRUE WHERE id=1',[
        JSON.stringify(testSettings),JSON.stringify({brand:testSettings.brand,guardrails:testSettings.guardrails}),
      ]);
      await pool.execute("INSERT INTO integration_config (id,version,profile_id,account_id,model,status) VALUES (1,1,?,?,'test/model','ACTIVE') ON DUPLICATE KEY UPDATE profile_id=VALUES(profile_id),account_id=VALUES(account_id),model=VALUES(model),status='ACTIVE'",[testSettings.profileId,testSettings.targetAccountId]);
      // This is an explicitly isolated destructive-test database. Remove prior
      // integration-run slots so their cadence cannot affect the concurrency case.
      await pool.execute('DELETE FROM slots');
      const scheduledAt=new Date(Date.now()-1000);
      const due=await repo.ensureDueSlot({scheduledAt,sessionId:testSettings.automationSessionId});
      testSlotId=due.id;
      const claims=await Promise.all([
        repo.claimDueSlot({now:new Date(),minimumIntervalHours:6}),
        repo.claimDueSlot({now:new Date(),minimumIntervalHours:6}),
      ]);
      const winners=claims.filter(Boolean);
      assert.equal(winners.length,1,'only one concurrent database claim may win');
      const payload={content:'scheduler persistence test',targets:[{account_id:testSettings.targetAccountId}]};
      const idempotencyKey=`restart-${randomUUID()}`;
      await repo.savePreparedSlot(due.id,{requestPayload:payload,idempotencyKey,caption:payload.content,pillar:'topup'});
      await pool.execute('UPDATE slots SET claimed_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 11 MINUTE) WHERE id=?',[due.id]);

      await pool.end();
      pool=createPool(config);
      const afterRestart=createRepository(pool);
      const reclaimed=await afterRestart.claimDueSlot({now:new Date(),minimumIntervalHours:6});
      assert.equal(reclaimed.id,due.id);
      assert.equal(reclaimed.status,'ready');
      assert.deepEqual(reclaimed.requestPayload,payload);
      assert.equal(reclaimed.idempotencyKey,idempotencyKey);

      await pool.execute('DELETE FROM slots');
      await pool.execute('UPDATE settings SET automation_enabled=FALSE,settings_json=JSON_REMOVE(settings_json,\'$.automationSessionId\',\'$.nextSlotAt\',\'$.activationFirstPostAt\') WHERE id=1');
      const oldSessionId=randomUUID();
      const oldPublishedAt=new Date(Date.now()-10*60*1000);
      await pool.execute("INSERT INTO slots (id,scheduled_at,automation_session_id,status,completed_at) VALUES (?,?,?,'published',?)",[randomUUID(),new Date(Date.now()-30*60*1000),oldSessionId,oldPublishedAt]);
      const firstActivation=await afterRestart.setAutomationEnabled(true,null);
      assert.equal(firstActivation.changed,true);
      assert.equal(firstActivation.immediate,true,'a new activation starts immediately despite recent history from another session');
      assert.ok(Math.abs(new Date(firstActivation.firstPostAt)-Date.now())<5000);
      const [[firstSessionRow]]=await pool.execute('SELECT settings_json FROM settings WHERE id=1');
      const firstSessionSettings=JSON.parse(jsonValue(firstSessionRow.settings_json));
      const firstSessionId=firstSessionSettings.automationSessionId;
      assert.match(firstSessionId,/^[0-9a-f-]{36}$/i);
      const firstPlan=await afterRestart.ensureNextDueSlot({now:new Date(firstActivation.firstPostAt),schedule:testSettings.schedule});
      assert.ok(firstPlan.slot);
      assert.equal(firstPlan.slot.automationSessionId,firstSessionId);
      const firstClaim=await afterRestart.claimDueSlot({now:new Date(firstActivation.firstPostAt),minimumIntervalHours:1});
      assert.equal(firstClaim.id,firstPlan.slot.id);
      assert.equal(firstClaim.automationSessionId,firstSessionId);

      const failureAt=new Date(new Date(firstActivation.firstPostAt).getTime()+12*60*1000);
      await afterRestart.updateSlot(firstClaim.id,{status:'failed',providerStatus:'failed',errorCode:'provider_error',completedAt:failureAt});
      const retryDueAt=new Date(failureAt.getTime()+3600000);
      const retryPlan=await afterRestart.ensureNextDueSlot({now:new Date(failureAt.getTime()+1000),schedule:testSettings.schedule});
      assert.ok(retryPlan.slot);
      assert.equal(retryPlan.slot.automationSessionId,firstSessionId);
      assert.ok(Math.abs(new Date(retryPlan.slot.scheduledAt)-retryDueAt)<5000,'a confirmed failure anchors the next attempt one hour after confirmation');

      assert.equal((await afterRestart.setAutomationEnabled(false,null)).changed,true);
      const [[pausedState]]=await pool.execute('SELECT settings_json,automation_enabled FROM settings WHERE id=1');
      const pausedSettings=JSON.parse(jsonValue(pausedState.settings_json));
      assert.equal(Boolean(pausedState.automation_enabled),false);
      assert.equal(pausedSettings.nextSlotAt,undefined);
      assert.equal(pausedSettings.activationFirstPostAt,undefined);
      assert.equal(pausedSettings.automationSessionId,undefined);
      const [[pausedSlots]]=await pool.execute('SELECT SUM(status=\'canceled\') canceled,SUM(status=\'failed\') failed FROM slots');
      assert.equal(Number(pausedSlots.canceled),1,'pause cancels the unclaimed retry slot but preserves prior failure history');
      assert.equal(Number(pausedSlots.failed),1);
      assert.equal(await afterRestart.claimDueSlot({now:retryDueAt,minimumIntervalHours:1}),null);

      const resumedAt=new Date();
      const secondActivation=await afterRestart.setAutomationEnabled(true,null);
      assert.equal(secondActivation.changed,true);
      assert.equal(secondActivation.immediate,true,'reactivation does not inherit the prior session failure cooldown');
      assert.ok(Math.abs(new Date(secondActivation.firstPostAt)-resumedAt)<5000);
      const [[secondSessionRow]]=await pool.execute('SELECT settings_json FROM settings WHERE id=1');
      const secondSessionSettings=JSON.parse(jsonValue(secondSessionRow.settings_json));
      const secondSessionId=secondSessionSettings.automationSessionId;
      assert.notEqual(secondSessionId,firstSessionId);
      const delayedFirstRunAt=new Date(new Date(secondActivation.firstPostAt).getTime()+20*60*1000);
      const secondPlan=await afterRestart.ensureNextDueSlot({now:delayedFirstRunAt,schedule:testSettings.schedule});
      assert.equal(secondPlan.slot.automationSessionId,secondSessionId);
      assert.ok(Math.abs(new Date(secondPlan.slot.scheduledAt)-new Date(secondActivation.firstPostAt))<5000,'the activation-first slot remains available after a temporary verification block');
      const secondClaim=await afterRestart.claimDueSlot({now:delayedFirstRunAt,minimumIntervalHours:1});
      assert.equal(secondClaim.id,secondPlan.slot.id,'only the newest activation session can claim a slot');
      assert.equal(secondClaim.automationSessionId,secondSessionId);
      assert.equal((await afterRestart.setAutomationEnabled(true,null)).changed,false,'repeated enable does not create another session or immediate slot');

      const successAt=new Date(delayedFirstRunAt.getTime()+9*60*1000);
      await afterRestart.updateSlot(secondClaim.id,{status:'published',providerStatus:'published',completedAt:successAt});
      const successNext=await afterRestart.ensureNextDueSlot({now:new Date(successAt.getTime()+1000),schedule:testSettings.schedule});
      assert.ok(successNext.slot);
      assert.ok(Math.abs(new Date(successNext.slot.scheduledAt)-new Date(successAt.getTime()+3600000))<5000,'success anchors the following post one hour after provider confirmation');

      assert.equal((await afterRestart.setAutomationEnabled(false,null)).changed,true);
    } finally {
      if (testSlotId) await pool.execute('DELETE FROM slots WHERE id=?',[testSlotId]);
      await pool.execute('UPDATE settings SET settings_json=?,knowledge_json=?,automation_enabled=? WHERE id=1',[
        priorSettingsJson,priorKnowledgeJson,previousSettings.automation_enabled,
      ]);
    }
  }
  finally { await pool.end(); }
});

test('MySQL checks prepared caption evidence atomically before publishing', { skip: !enabled }, async () => {
  const { randomUUID } = require('node:crypto');
  const { loadEnv } = require('../src/config');
  const { createPool } = require('../src/db');
  const { runMigrations } = require('../src/migrate');
  const { createRepository } = require('../src/repository');
  const { contentSafetyHash } = require('../src/content-safety');
  const pool = createPool(loadEnv());
  await runMigrations(pool);
  const repo = createRepository(pool);
  const [[previous]] = await pool.execute('SELECT settings_json, knowledge_json, automation_enabled FROM settings WHERE id=1');
  const [previousFacts] = await pool.execute('SELECT service, summary_json, active, updated_at FROM service_facts');
  const encode = (value) => typeof value === 'string' ? value : JSON.stringify(value);
  const sessionId = randomUUID();
  const settings = {
    schedule: { intervalHours: 1, timezone: 'Asia/Kuala_Lumpur' },
    priceMode: 'ON', gameWhitelist: ['Mobile Legends'],
    brand: { name: 'Kedai Merzz', voice: 'Santai' },
    guardrails: { approved: true, forbiddenClaims: [], approvedClaims: [] },
    trackedLinks: {}, automationSessionId: sessionId, onboardingComplete: true,
    targetAccountId: 'integration-account', profileId: 'integration-profile',
  };
  const knowledge = { brand: settings.brand, guardrails: settings.guardrails };
  try {
    await pool.execute('DELETE FROM slots');
    await pool.execute('UPDATE settings SET settings_json=?,knowledge_json=?,automation_enabled=TRUE WHERE id=1', [JSON.stringify(settings), JSON.stringify(knowledge)]);
    await pool.execute("INSERT INTO integration_config (id,version,profile_id,account_id,model,status) VALUES (1,1,?,?,'test/model','ACTIVE') ON DUPLICATE KEY UPDATE profile_id=VALUES(profile_id),account_id=VALUES(account_id),model=VALUES(model),status='ACTIVE'",[settings.profileId,settings.targetAccountId]);
    await pool.execute('DELETE FROM service_facts');
    const cases = ['valid', 'changed', 'inactive', 'expired', 'settings', 'legacy'];
    for (const [index, scenario] of cases.entries()) {
      await pool.execute('DELETE FROM slots');
      await pool.execute('UPDATE settings SET settings_json=?,knowledge_json=? WHERE id=1', [JSON.stringify(settings), JSON.stringify(knowledge)]);
      await pool.execute("INSERT INTO service_facts (service,summary_json,active,updated_at) VALUES ('topup',?,TRUE,UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE summary_json=VALUES(summary_json),active=TRUE,updated_at=UTC_TIMESTAMP(3)", [JSON.stringify({ game: 'Mobile Legends', price: '30' })]);
      if (scenario === 'expired') await pool.execute("UPDATE service_facts SET updated_at=DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 25 HOUR) WHERE service='topup'");
      const [[fact]] = await pool.execute("SELECT updated_at FROM service_facts WHERE service='topup'");
      const id = randomUUID();
      await pool.execute("INSERT INTO slots (id,scheduled_at,automation_session_id,status,tebar_profile_id,tebar_account_id,tebar_config_version) VALUES (?,?,?,'generating',?,?,1)", [id, new Date(Date.now() - 5000 - index), sessionId,settings.profileId,settings.targetAccountId]);
      const payload = { content: 'Cerita pilihan pemain.', targets: [{ account_id: settings.targetAccountId }] };
      const hash = scenario === 'legacy' ? null : contentSafetyHash(await repo.getSettings());
      assert.equal(await repo.savePreparedSlot(id, {
        requestPayload: payload, idempotencyKey: `test-${id}`, caption: payload.content, pillar: 'topup',
        factBearing: false, factIds: [], factVersions: [{ id: 'topup', updatedAt: fact.updated_at }], contentSafetyHash: hash,
      }), true, scenario);
      if (scenario === 'changed') await pool.execute("UPDATE service_facts SET updated_at=DATE_ADD(updated_at, INTERVAL 1 SECOND) WHERE service='topup'");
      if (scenario === 'inactive') await pool.execute("UPDATE service_facts SET active=FALSE WHERE service='topup'");
      if (scenario === 'settings') await pool.execute("UPDATE settings SET knowledge_json=JSON_SET(knowledge_json,'$.brand.voice','Berbeza') WHERE id=1");
      const result = await repo.startPublishing(id, { now: new Date() });
      assert.equal(result, scenario === 'valid' ? true : 'stale_facts', scenario);
      const [[slot]] = await pool.execute('SELECT status FROM slots WHERE id=?', [id]);
      assert.equal(slot.status, scenario === 'valid' ? 'publishing' : 'ready', scenario);
    }
  } finally {
    await pool.execute('DELETE FROM slots');
    await pool.execute('DELETE FROM service_facts');
    for (const fact of previousFacts) await pool.execute('INSERT INTO service_facts (service,summary_json,active,updated_at) VALUES (?,?,?,?)', [fact.service, encode(fact.summary_json), fact.active, fact.updated_at]);
    await pool.execute('UPDATE settings SET settings_json=?,knowledge_json=?,automation_enabled=? WHERE id=1', [encode(previous.settings_json), encode(previous.knowledge_json), previous.automation_enabled]);
    await pool.end();
  }
});

test('MySQL fences a concurrent account switch against publication start', {skip:!enabled}, async()=>{
  const {randomUUID}=require('node:crypto');
  const {loadEnv}=require('../src/config');const {createPool}=require('../src/db');const {runMigrations}=require('../src/migrate');
  const {createRepository}=require('../src/repository');const {createConfigurationService}=require('../src/configuration');const {contentSafetyHash}=require('../src/content-safety');
  const config=loadEnv();const pool=createPool(config);await runMigrations(pool);
  const [[priorSettings]]=await pool.execute('SELECT settings_json,knowledge_json,automation_enabled FROM settings WHERE id=1');
  const [[priorConfig]]=await pool.execute('SELECT * FROM integration_config WHERE id=1');
  const encode=value=>typeof value==='string'?value:JSON.stringify(value);
  const version=Date.now();const sessionId=randomUUID();const profileId=`old-profile-${randomUUID()}`;const accountId=`old-account-${randomUUID()}`;
  const settings={schedule:{intervalHours:1,timezone:'Asia/Kuala_Lumpur'},brand:{name:'Kedai Merzz',voice:'Santai'},guardrails:{approved:true,forbiddenClaims:[],approvedClaims:[]},targetAccountId:accountId,profileId,automationSessionId:sessionId,onboardingComplete:true};
  const knowledge={brand:settings.brand,guardrails:settings.guardrails};const id=randomUUID();const payload={content:'slot lama',targets:[{account_id:accountId}]};
  try{
    await pool.execute('DELETE FROM slots');
    await pool.execute('UPDATE settings SET settings_json=?,knowledge_json=?,automation_enabled=TRUE WHERE id=1',[JSON.stringify(settings),JSON.stringify(knowledge)]);
    await pool.execute("INSERT INTO integration_config (id,version,profile_id,account_id,model,status) VALUES (1,?,?,?,'test/model','ACTIVE') ON DUPLICATE KEY UPDATE version=VALUES(version),profile_id=VALUES(profile_id),account_id=VALUES(account_id),model=VALUES(model),status='ACTIVE',pending_profile_id=NULL,pending_account_id=NULL,pending_model=NULL",[version,profileId,accountId]);
    await pool.execute("INSERT INTO slots (id,scheduled_at,automation_session_id,status,tebar_profile_id,tebar_account_id,tebar_config_version,request_payload,idempotency_key,caption,pillar,fact_ids,fact_versions,content_safety_hash) VALUES (?,?,?,'ready',?,?,?,?,?,'slot lama','topup',?,?,?)",[id,new Date(),sessionId,profileId,accountId,version,JSON.stringify(payload),`key-${id}`,JSON.stringify([]),JSON.stringify([]),contentSafetyHash(settings)]);
    const repository=createRepository(pool);const service=createConfigurationService({pool,config});
    const [started,switched]=await Promise.all([
      repository.startPublishing(id,{now:new Date()}),
      service.switchAccount({profileId:`new-profile-${randomUUID()}`,accountId:`new-account-${randomUUID()}`,expectedVersion:version,actorId:null}),
    ]);
    const [[slot]]=await pool.execute('SELECT status,tebar_profile_id,tebar_account_id,request_payload FROM slots WHERE id=?',[id]);
    assert.equal(slot.tebar_profile_id,profileId);assert.equal(slot.tebar_account_id,accountId);
    assert.equal(JSON.parse(encode(slot.request_payload)).targets[0].account_id,accountId);
    if(started===true){assert.equal(switched.status,'BLOCKED_RECONCILIATION');assert.equal(slot.status,'publishing');}
    else {assert.equal(started,false);assert.equal(switched.status,'ACTIVE');assert.equal(slot.status,'canceled');}
  }finally{
    await pool.execute('DELETE FROM slots');
    await pool.execute('DELETE FROM integration_config_history WHERE version>=?',[version]);
    if(priorConfig)await pool.execute('UPDATE integration_config SET version=?,profile_id=?,account_id=?,model=?,status=?,pending_profile_id=?,pending_account_id=?,pending_model=?,updated_by=? WHERE id=1',[priorConfig.version,priorConfig.profile_id,priorConfig.account_id,priorConfig.model,priorConfig.status,priorConfig.pending_profile_id,priorConfig.pending_account_id,priorConfig.pending_model,priorConfig.updated_by]);
    else await pool.execute('DELETE FROM integration_config WHERE id=1');
    await pool.execute('UPDATE settings SET settings_json=?,knowledge_json=?,automation_enabled=? WHERE id=1',[encode(priorSettings.settings_json),encode(priorSettings.knowledge_json),priorSettings.automation_enabled]);
    await pool.end();
  }
});
