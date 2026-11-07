const test=require('node:test');
const assert=require('node:assert/strict');
const enabled=process.env.NODE_ENV==='test'&&process.env.DB_NAME==='merzz_test'&&process.env.ALLOW_DESTRUCTIVE_DB_TESTS==='true';

test('MySQL migrations and repository are reachable in integration environment',{skip:!enabled},async()=>{
  const {loadEnv}=require('../src/config');const {createPool}=require('../src/db');const {runMigrations}=require('../src/migrate');const {createRepository}=require('../src/repository');
  const config=loadEnv();let pool=createPool(config);
  try {
    await runMigrations(pool);
    await pool.execute("DELETE FROM schema_migrations WHERE version='002_notification_outbox.sql'");
    assert.deepEqual(await runMigrations(pool),['002_notification_outbox.sql']);
    await pool.execute("DELETE FROM schema_migrations WHERE version='003_multi_admin.sql'");
    assert.deepEqual(await runMigrations(pool),['003_multi_admin.sql']);
    const repo=createRepository(pool);
    assert.equal(await repo.healthCheck(),true);
    const settings=await repo.getSettings();assert.equal(settings.automationEnabled,false);
    const facts=await repo.listFacts();assert.equal(typeof facts,'object');
    const dedupeKey=require('node:crypto').randomBytes(32).toString('hex');
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
    const publishedEventId=randomUUID();const publishedPostId=`post-${randomUUID()}`;const publishedSlotId=randomUUID();
    await pool.execute("INSERT INTO slots (id,scheduled_at,status,provider_post_id,request_payload) VALUES (?,?,'published',?,?)",[
      publishedSlotId,new Date(Date.now()+Math.floor(Math.random()*1000)),publishedPostId,JSON.stringify({targets:[{account_id:accountId}]}),
    ]);
    await repo.applyWebhookEvent({eventId:publishedEventId,payloadHash:createHash('sha256').update(publishedEventId).digest('hex'),type:'post.published',profileId,data:{post_id:publishedPostId,account_id:accountId,status:'published'},accountId,notificationCode:'post_published'});
    const publishedDedupeKey=createHash('sha256').update(`post_published:slot:${publishedSlotId}`).digest('hex');
    const [[publishedNotice]]=await pool.execute('SELECT message FROM notification_outbox WHERE dedupe_key=?',[publishedDedupeKey]);
    assert.match(publishedNotice.message,/post_published/);
    const unrelatedId=randomUUID();
    await repo.applyWebhookEvent({eventId:unrelatedId,payloadHash:createHash('sha256').update(unrelatedId).digest('hex'),type:'account.disconnected',profileId:`other-${profileId}`,data:{account:{id:accountId}},accountId,notificationCode:'account_disconnected'});
    const unrelatedKey=createHash('sha256').update(`tebar:${unrelatedId}`).digest('hex');
    const [[unrelated]]=await pool.execute('SELECT COUNT(*) count FROM notification_outbox WHERE dedupe_key=?',[unrelatedKey]);
    assert.equal(Number(unrelated.count),0);
    const localDate=`${2100+Math.floor(Math.random()*7000)}-01-01`;
    assert.equal(await repo.claimDailySummary({localDate,timezone:'Asia/Kuala_Lumpur'}),true);
    assert.equal(await repo.claimDailySummary({localDate,timezone:'Asia/Kuala_Lumpur'}),false);
    await pool.execute("UPDATE daily_summaries SET created_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 11 MINUTE) WHERE local_date=? AND timezone=?",[localDate,'Asia/Kuala_Lumpur']);
    assert.equal(await repo.claimDailySummary({localDate,timezone:'Asia/Kuala_Lumpur'}),true);
    await repo.finishDailySummary({localDate,timezone:'Asia/Kuala_Lumpur',status:'sent'});
    assert.equal(await repo.claimDailySummary({localDate,timezone:'Asia/Kuala_Lumpur'}),false);

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
        trackedLinks:{topup:'https://example.test/topup',account:'https://example.test/account'},
        targetAccountId:`scheduler-test-${randomUUID()}`,profileId:`profile-test-${randomUUID()}`,onboardingComplete:true,
      };
      await pool.execute('UPDATE settings SET settings_json=?,knowledge_json=?,automation_enabled=TRUE WHERE id=1',[
        JSON.stringify(testSettings),JSON.stringify({brand:testSettings.brand,guardrails:testSettings.guardrails}),
      ]);
      // This is an explicitly isolated destructive-test database. Remove prior
      // integration-run slots so their cadence cannot affect the concurrency case.
      await pool.execute('DELETE FROM slots');
      const scheduledAt=new Date(Date.now()-1000);
      const due=await repo.ensureDueSlot({scheduledAt});
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
      const priorPostAt=new Date(Date.now()-30*60*1000);
      const priorPostId=randomUUID();
      const priorPublishedAt=new Date(Date.now()-10*60*1000);
      await pool.execute("INSERT INTO slots (id,scheduled_at,status,completed_at) VALUES (?,?,'published',?)",[priorPostId,priorPostAt,priorPublishedAt]);
      const stalePendingId=randomUUID();
      await pool.execute("INSERT INTO slots (id,scheduled_at,status) VALUES (?,?,'pending')",[stalePendingId,new Date(Date.now()+5*3600000)]);
      await pool.execute('UPDATE settings SET automation_enabled=FALSE WHERE id=1');
      const cooldown=await afterRestart.setAutomationEnabled(true,null);
      assert.equal(cooldown.changed,true);
      assert.equal(cooldown.immediate,false);
      assert.ok(new Date(cooldown.firstPostAt)-Date.now()>45*60*1000);
      assert.ok(new Date(cooldown.firstPostAt)-Date.now()<55*60*1000);
      const [[staleCount]]=await pool.execute("SELECT COUNT(*) count FROM slots WHERE status IN ('pending','generating','ready')");
      assert.equal(Number(staleCount.count),0);
      const cooldownDue=new Date(cooldown.firstPostAt);
      const earlyCooldownPlan=await afterRestart.ensureNextDueSlot({now:new Date(cooldownDue.getTime()-10*60*1000),schedule:testSettings.schedule});
      assert.ok(earlyCooldownPlan.slot);
      assert.ok(Math.abs(new Date(earlyCooldownPlan.slot.scheduledAt)-cooldownDue)<5000);
      const cooldownPlan=await afterRestart.ensureNextDueSlot({now:cooldownDue,schedule:testSettings.schedule});
      assert.ok(cooldownPlan.slot);
      assert.ok(Math.abs(new Date(cooldownPlan.slot.scheduledAt)-cooldownDue)<5000);
      const firstActivationClaim=await afterRestart.claimDueSlot({now:cooldownDue,minimumIntervalHours:1});
      assert.equal(firstActivationClaim.id,cooldownPlan.slot.id);
      const [[afterCooldownSettings]]=await pool.execute('SELECT settings_json FROM settings WHERE id=1');
      const cooldownSettings=JSON.parse(jsonValue(afterCooldownSettings.settings_json));
      assert.equal(cooldownSettings.activationFirstPostAt,undefined);
      assert.ok(Math.abs(new Date(cooldownSettings.nextSlotAt)-cooldownDue-6*3600000)<5000);

      await pool.execute('DELETE FROM slots');
      await pool.execute('UPDATE settings SET automation_enabled=FALSE WHERE id=1');
      const inFlightId=randomUUID();
      const inFlightStartedAt=new Date(Date.now()-30*60*1000);
      await pool.execute("INSERT INTO slots (id,scheduled_at,status,publish_started_at) VALUES (?,?,'publishing',?)",[inFlightId,inFlightStartedAt,inFlightStartedAt]);
      const delayedActivation=await afterRestart.setAutomationEnabled(true,null);
      const delayedFirstAt=new Date(delayedActivation.firstPostAt);
      const firstPendingBeforeCooldown=await afterRestart.ensureNextDueSlot({now:new Date(delayedFirstAt.getTime()-10*60*1000),schedule:testSettings.schedule});
      assert.ok(firstPendingBeforeCooldown.slot);
      assert.ok(Math.abs(new Date(firstPendingBeforeCooldown.slot.scheduledAt)-delayedFirstAt)<5000);
      const providerCompletionAt=new Date(Date.now()+10*60*1000);
      await pool.execute("UPDATE slots SET status='published',completed_at=? WHERE id=?",[providerCompletionAt,inFlightId]);
      const reanchoredFirst=await afterRestart.ensureNextDueSlot({now:new Date(delayedFirstAt.getTime()-5*60*1000),schedule:testSettings.schedule});
      assert.ok(reanchoredFirst.slot);
      assert.ok(Math.abs(new Date(reanchoredFirst.slot.scheduledAt)-new Date(providerCompletionAt.getTime()+3600000))<5000);
      const [[reanchoredSettingsRow]]=await pool.execute('SELECT settings_json FROM settings WHERE id=1');
      const reanchoredSettings=JSON.parse(jsonValue(reanchoredSettingsRow.settings_json));
      assert.ok(Math.abs(new Date(reanchoredSettings.activationFirstPostAt)-new Date(reanchoredFirst.slot.scheduledAt))<5000);
      const dueAfterProviderCompletion=await afterRestart.ensureNextDueSlot({now:new Date(reanchoredFirst.slot.scheduledAt),schedule:testSettings.schedule});
      assert.ok(dueAfterProviderCompletion.slot);
      assert.ok(Math.abs(new Date(dueAfterProviderCompletion.slot.scheduledAt)-new Date(providerCompletionAt.getTime()+3600000))<5000);

      await pool.execute('DELETE FROM slots');
      await pool.execute('UPDATE settings SET automation_enabled=FALSE WHERE id=1');
      const immediate=await afterRestart.setAutomationEnabled(true,null);
      assert.equal(immediate.changed,true);
      assert.equal(immediate.immediate,true);
      assert.ok(Math.abs(new Date(immediate.firstPostAt)-Date.now())<5000);
      const duePlan=await afterRestart.ensureNextDueSlot({now:new Date(),schedule:testSettings.schedule});
      assert.ok(duePlan.slot);
      assert.ok(Math.abs(new Date(duePlan.slot.scheduledAt)-Date.now())<10000);
      const [[afterImmediateSettings]]=await pool.execute('SELECT settings_json FROM settings WHERE id=1');
      const nextAfterImmediate=JSON.parse(jsonValue(afterImmediateSettings.settings_json)).nextSlotAt;
      assert.ok(Math.abs(new Date(nextAfterImmediate)-new Date(immediate.firstPostAt)-6*3600000)<5000);
      const simulatedPublishedAt=new Date(new Date(immediate.firstPostAt).getTime()+20*60*1000);
      await pool.execute("UPDATE slots SET status='published',completed_at=? WHERE id=?",[simulatedPublishedAt,duePlan.slot.id]);
      const oneHourAfterActivation=new Date(new Date(immediate.firstPostAt).getTime()+3600000);
      await pool.execute('UPDATE settings SET settings_json=JSON_SET(settings_json,\'$.schedule.intervalHours\',1,\'$.nextSlotAt\',?) WHERE id=1',[oneHourAfterActivation.toISOString()]);
      const earlySlot=await afterRestart.ensureDueSlot({scheduledAt:oneHourAfterActivation});
      assert.ok(earlySlot);
      assert.equal(await afterRestart.claimDueSlot({now:oneHourAfterActivation,minimumIntervalHours:1}),null);
      const [[heldEarlySlot]]=await pool.execute('SELECT status FROM slots WHERE id=?',[earlySlot.id]);
      assert.equal(heldEarlySlot.status,'pending');
      const nextHourly=await afterRestart.ensureNextDueSlot({now:oneHourAfterActivation,schedule:{...testSettings.schedule,intervalHours:1}});
      assert.ok(nextHourly.slot);
      assert.ok(Math.abs(new Date(nextHourly.slot.scheduledAt)-new Date(simulatedPublishedAt.getTime()+3600000))<5000);
      assert.equal((await afterRestart.setAutomationEnabled(true,null)).changed,false);
    } finally {
      if (testSlotId) await pool.execute('DELETE FROM slots WHERE id=?',[testSlotId]);
      await pool.execute('UPDATE settings SET settings_json=?,knowledge_json=?,automation_enabled=? WHERE id=1',[
        priorSettingsJson,priorKnowledgeJson,previousSettings.automation_enabled,
      ]);
    }
  }
  finally { await pool.end(); }
});
