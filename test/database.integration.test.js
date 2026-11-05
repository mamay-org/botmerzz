const test=require('node:test');
const assert=require('node:assert/strict');
const enabled=Boolean(process.env.DB_HOST&&process.env.DB_USER&&process.env.DB_NAME);

test('MySQL migrations and repository are reachable in integration environment',{skip:!enabled},async()=>{
  const {loadEnv}=require('../src/config');const {createPool}=require('../src/db');const {runMigrations}=require('../src/migrate');const {createRepository}=require('../src/repository');
  const config=loadEnv();const pool=createPool(config);
  try {
    await runMigrations(pool);
    await pool.execute("DELETE FROM schema_migrations WHERE version='002_notification_outbox.sql'");
    assert.deepEqual(await runMigrations(pool),['002_notification_outbox.sql']);
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
    const profileId=`test-profile-${randomUUID()}`;const accountId=`test-account-${randomUUID()}`;const eventId=randomUUID();
    await repo.setProviderTarget({accountId,profileId});
    await repo.applyWebhookEvent({eventId,payloadHash:createHash('sha256').update(eventId).digest('hex'),type:'account.disconnected',profileId,data:{account:{id:accountId}},accountId,notificationCode:'account_disconnected'});
    const eventKey=createHash('sha256').update(`tebar:${eventId}`).digest('hex');
    const [[queued]]=await pool.execute('SELECT COUNT(*) count FROM notification_outbox WHERE dedupe_key=?',[eventKey]);
    assert.equal(Number(queued.count),1);
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
  }
  finally { await pool.end(); }
});
