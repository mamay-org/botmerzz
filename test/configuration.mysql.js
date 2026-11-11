'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const enabled=process.env.NODE_ENV==='test'&&process.env.DB_NAME==='merzz_test'&&['localhost','127.0.0.1','::1'].includes(process.env.DB_HOST)&&process.env.ALLOW_DESTRUCTIVE_DB_TESTS==='true';

test('isolated MySQL bootstrap, version conflicts and account switch remain fail closed', {skip:!enabled}, async()=>{
  const {loadEnv}=require('../src/config');const {createPool}=require('../src/db');const {runMigrations}=require('../src/migrate');const {createConfigurationService}=require('../src/configuration');
  const pool=createPool(loadEnv());const slotId='feb84129-436f-4ccb-8976-dd3c613ff967';
  await runMigrations(pool);
  const [[settings]]=await pool.execute('SELECT settings_json,knowledge_json,automation_enabled FROM settings WHERE id=1');
  const [originalConfig]=await pool.execute('SELECT * FROM integration_config WHERE id=1');
  const [originalHistory]=await pool.execute('SELECT * FROM integration_config_history');
  const encode=value=>typeof value==='string'?value:JSON.stringify(value);
  try {
    await pool.execute('DELETE FROM integration_config_history');
    await pool.execute('DELETE FROM integration_config WHERE id=1');
    await pool.execute("UPDATE settings SET automation_enabled=FALSE,settings_json=JSON_REMOVE(settings_json,'$.integrationConfigInitialized','$.profileId','$.targetAccountId') WHERE id=1");
    const env={tebar:{profileId:'profile_old',accountId:'account_old'},openRouter:{model:'vendor/model'}};
    const service=createConfigurationService({pool,config:env});
    const concurrent=await Promise.all([service.bootstrap(),service.bootstrap()]);
    assert.equal(concurrent[0].version,1);assert.equal(concurrent[1].version,1);
    const alternative=createConfigurationService({pool,config:{tebar:{profileId:'other',accountId:'other'},openRouter:{model:'other/model'}}});
    assert.equal((await alternative.bootstrap()).accountId,'account_old');
    const updates=await Promise.allSettled([service.setModel({model:'vendor/a',expectedVersion:1}),service.setModel({model:'vendor/b',expectedVersion:1})]);
    assert.equal(updates.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(updates.find(x=>x.status==='rejected').reason.code,'CONFIG_CONFLICT');
    await pool.execute("INSERT INTO slots (id,scheduled_at,status) VALUES (?,UTC_TIMESTAMP(3),'unknown')",[slotId]);
    const before=await service.getActive();const blocked=await service.switchAccount({profileId:'profile_new',accountId:'account_new',expectedVersion:before.version});
    assert.equal(blocked.status,'BLOCKED_RECONCILIATION');assert.equal(blocked.accountId,'account_old');
    assert.equal((await service.resumeSwitch({expectedVersion:blocked.version})).status,'BLOCKED_RECONCILIATION');
    await pool.execute("UPDATE slots SET status='failed' WHERE id=?",[slotId]);
    const next=await service.resumeSwitch({expectedVersion:blocked.version});
    assert.equal(next.accountId,'account_new');assert.equal(next.model,before.model);
    const [[state]]=await pool.execute('SELECT automation_enabled FROM settings WHERE id=1');assert.equal(Number(state.automation_enabled),0);
    const repository=require('../src/repository').createRepository(pool);
    await repository.saveSettings(await repository.getSettings(),null);
    const [[marked]]=await pool.execute('SELECT settings_json FROM settings WHERE id=1');
    assert.equal((typeof marked.settings_json==='string'?JSON.parse(marked.settings_json):marked.settings_json).integrationConfigInitialized,true);
    await pool.execute('DELETE FROM integration_config WHERE id=1');
    await assert.rejects(alternative.bootstrap(),e=>e.code==='CONFIG_UNAVAILABLE');
  } finally {
    await pool.execute('DELETE FROM slots WHERE id=?',[slotId]);
    await pool.execute('DELETE FROM integration_config WHERE id=1');
    await pool.execute('DELETE FROM integration_config_history');
    for(const h of originalHistory) await pool.execute('INSERT INTO integration_config_history (version,profile_id,account_id,model,status,action,pending_profile_id,pending_account_id,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',[h.version,h.profile_id,h.account_id,h.model,h.status,h.action,h.pending_profile_id,h.pending_account_id,h.actor_id,h.created_at]);
    for(const c of originalConfig) await pool.execute('INSERT INTO integration_config (id,version,profile_id,account_id,model,status,pending_profile_id,pending_account_id,pending_model,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',[c.id,c.version,c.profile_id,c.account_id,c.model,c.status,c.pending_profile_id,c.pending_account_id,c.pending_model,c.updated_by,c.created_at,c.updated_at]);
    await pool.execute('UPDATE settings SET settings_json=?,knowledge_json=?,automation_enabled=? WHERE id=1',[encode(settings.settings_json),encode(settings.knowledge_json),settings.automation_enabled]);
    await pool.end();
  }
});
