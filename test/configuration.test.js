'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {validId,validModel,snapshot,createConfigurationService}=require('../src/configuration');
const {createConfigurationValidators}=require('../src/configuration-providers');
const {createServer}=require('../src/server');

const config={tebar:{apiKey:'test-only'},openRouter:{apiKey:'test-only',generatorSampling:{temperature:0.4}}};
function configurationPool({status='ACTIVE',unsettledCount=0,automationEnabled=1}={}){
  const calls=[];
  const connection={
    beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release:()=>{},
    query:async sql=>{
      if(sql.includes('SELECT settings_json'))return [[{settings_json:JSON.stringify({profileId:'old-profile',targetAccountId:'old-account',onboardingComplete:true,automationSessionId:'old-session'}),automation_enabled:automationEnabled}]];
      if(sql.includes('SELECT * FROM integration_config'))return [[{version:status==='BLOCKED_RECONCILIATION'?2:1,profile_id:'old-profile',account_id:'old-account',model:'vendor/model',status,pending_profile_id:status==='BLOCKED_RECONCILIATION'?'next-profile':null,pending_account_id:status==='BLOCKED_RECONCILIATION'?'next-account':null,pending_model:status==='BLOCKED_RECONCILIATION'?'vendor/model':null}]];
      return [[]];
    },
    execute:async(sql,params=[])=>{
      calls.push({sql,params});
      if(sql.includes('SELECT COUNT(*) AS count FROM slots')){
        const scoped=sql.includes('tebar_profile_id=?')&&params[0]==='old-profile'&&params[1]==='old-account';
        return [[{count:scoped?unsettledCount:unsettledCount+1}],[]];
      }
      return [{affectedRows:1},[]];
    },
  };
  return {calls,pool:{getConnection:async()=>connection,execute:connection.execute}};
}
test('configuration input and snapshots fail closed on malformed values',()=>{
  assert.equal(validId('profile_123'),true);assert.equal(validId('x/../z'),false);
  assert.equal(validModel('google/gemini-2.5-flash:free'),true);assert.equal(validModel('https://bad.test'),false);
  assert.throws(()=>snapshot({version:1,status:'ACTIVE',profile_id:'x',account_id:null,model:'x/y'}),e=>e.code==='CONFIG_UNAVAILABLE');
  assert.throws(()=>snapshot({version:1,status:'BLOCKED_RECONCILIATION',profile_id:'x',account_id:'y',model:'x/y'}),e=>e.code==='CONFIG_UNAVAILABLE');
  assert.ok(Object.isFrozen(snapshot({version:1,status:'ACTIVE',profile_id:'x',account_id:'y',model:'x/y'})));
});
test('account switch scopes blockers to the outgoing target and cancels only its session or exact target',async()=>{
  const {calls,pool}=configurationPool();
  const service=createConfigurationService({pool,config});
  const switched=await service.switchAccount({profileId:'next-profile',accountId:'next-account',expectedVersion:1});
  assert.equal(switched.status,'ACTIVE');
  const cancel=calls.find(call=>call.sql.startsWith("UPDATE slots SET status='canceled'"));
  assert.match(cancel.sql,/automation_session_id=\?/);
  assert.match(cancel.sql,/tebar_profile_id=\? AND tebar_account_id=\?/);
  assert.deepEqual(cancel.params,['old-session','old-profile','old-account']);
  const blockers=calls.find(call=>call.sql.includes('SELECT COUNT(*) AS count FROM slots'));
  assert.match(blockers.sql,/tebar_profile_id=\?/);
  assert.deepEqual(blockers.params,['old-profile','old-account']);
});
test('account switch does not treat a stale automation session as active',async()=>{
  const {calls,pool}=configurationPool({automationEnabled:0});
  const service=createConfigurationService({pool,config});
  await service.switchAccount({profileId:'next-profile',accountId:'next-account',expectedVersion:1});
  const cancel=calls.find(call=>call.sql.startsWith("UPDATE slots SET status='canceled'"));
  assert.doesNotMatch(cancel.sql,/automation_session_id=\?/);
  assert.deepEqual(cancel.params,['old-profile','old-account']);
});
test('resuming an account switch remains blocked by unsettled work on the outgoing account',async()=>{
  const {calls,pool}=configurationPool({status:'BLOCKED_RECONCILIATION',unsettledCount:1});
  const service=createConfigurationService({pool,config});
  const result=await service.resumeSwitch({expectedVersion:2});
  assert.equal(result.status,'BLOCKED_RECONCILIATION');
  const blockers=calls.find(call=>call.sql.includes('SELECT COUNT(*) AS count FROM slots'));
  assert.match(blockers.sql,/tebar_profile_id=\?/);
  assert.deepEqual(blockers.params,['old-profile','old-account']);
  assert.equal(calls.some(call=>call.sql.startsWith('UPDATE settings SET settings_json=?')),false);
});
test('account verification rejects mismatch, non-Threads, inactive and suspended targets',async()=>{
  let target={id:'acct',profileId:'profile',platform:'threads',status:'active',planSuspended:false,username:'tester'};
  const validator=createConfigurationValidators({config,tebarFactory:()=>({listAccounts:async()=>[target]})});
  assert.equal((await validator.validateAccount({profileId:'profile',accountId:'acct'})).username,'tester');
  assert.equal((await validator.validateAccount({profileId:'profile',accountId:'acct'})).platform,'threads');
  for(const change of [{profileId:'other'},{platform:'instagram'},{status:'expired'},{planSuspended:true},{planSuspended:null},{planSuspended:undefined}]) {
    target={id:'acct',profileId:'profile',platform:'threads',status:'active',planSuspended:false,...change};
    await assert.rejects(validator.validateAccount({profileId:'profile',accountId:'acct'}),e=>e.code==='ACCOUNT_NOT_AVAILABLE');
  }
});
test('Tebar adapter preserves unknown suspension state instead of treating it as safe',async()=>{
  const {createTebarClient}=require('../src/providers/tebar');
  const api=createTebarClient({apiKey:'test-only',profileId:'profile',http:{request:async()=>({data:{data:[
    {id:'a',profile_id:'profile',platform:'threads',status:'active'},
    {id:'b',profile_id:'profile',platform:'threads',status:'active',plan_suspended:false},
    {id:'c',profile_id:'profile',platform:'threads',status:'active',plan_suspended:'false'},
  ]}})}});
  assert.deepEqual((await api.listAccounts()).map(account=>account.planSuspended),[null,false,null]);
});
test('model validation checks metadata, application token and sampling parameters, and provider errors',async()=>{
  let metadata={id:'vendor/model:free',name:'Test',architecture:{input_modalities:['text'],output_modalities:['text']},supported_parameters:['max_tokens','temperature']};
  const client={request:async options=>options.url.endsWith('/key')?({data:{data:{label:'sk-or-...890'}}}):({data:{data:metadata}})};
  const validator=createConfigurationValidators({config,http:client});
  assert.deepEqual(await validator.validateModel('vendor/model:free'),{id:'vendor/model:free',name:'Test',provider:'vendor',status:'AVAILABLE',reason:null});
  metadata={...metadata,supported_parameters:['temperature']};
  await assert.rejects(validator.validateModel('vendor/model:free'),e=>e.code==='MODEL_INCOMPATIBLE');
  metadata={...metadata,architecture:{input_modalities:['image'],output_modalities:['text']}};
  await assert.rejects(validator.validateModel('vendor/model:free'),e=>e.code==='MODEL_INCOMPATIBLE');
  const down=createConfigurationValidators({config,http:{request:async()=>{throw Object.assign(new Error('secret'),{response:{status:429}});}}});
  await assert.rejects(down.validateModel('vendor/model:free'),e=>e.code==='OPENROUTER_RATE_LIMITED'&&!e.message.includes('secret'));
});
test('successful model validation verifies the authenticated OpenRouter key before using catalog metadata',async()=>{
  const requests=[];const model={id:'vendor/model',name:'Test',architecture:{input_modalities:['text'],output_modalities:['text']},supported_parameters:['max_tokens','temperature']};
  const validator=createConfigurationValidators({config,http:{request:async options=>{
    requests.push(options);
    if(options.url==='https://openrouter.ai/api/v1/key')return {data:{data:{label:'sk-or-secret-prefix'}}};
    return {data:{data:model}};
  }}});
  const result=await validator.validateModel('vendor/model');
  assert.deepEqual(result,{id:'vendor/model',name:'Test',provider:'vendor',status:'AVAILABLE',reason:null});
  assert.deepEqual(requests.map(request=>request.url),['https://openrouter.ai/api/v1/key','https://openrouter.ai/api/v1/model/vendor/model']);
  assert.ok(requests.every(request=>request.method==='GET'&&request.headers.Authorization==='Bearer test-only'));
  assert.doesNotMatch(JSON.stringify(result),/sk-or-secret-prefix/);
});
test('model catalog returns searchable safe metadata with compatibility and a short cache',async()=>{
  let now=1000,calls=0,request;
  const models=[
    {id:'google/good-model',name:'Good Text Model',architecture:{input_modalities:['text'],output_modalities:['text']},supported_parameters:['max_completion_tokens','temperature']},
    {id:'anthropic/no-temperature',name:'No Sampling Model',architecture:{input_modalities:['text'],output_modalities:['text']},supported_parameters:['max_tokens']},
    {id:'vendor/vision-only',name:'Vision Only',architecture:{input_modalities:['image'],output_modalities:['text']},supported_parameters:['max_tokens']},
    {id:'vendor/metadata-pending',name:'Metadata Pending'},
    {id:'invalid-id',name:'Invalid identifier'},
  ];
  const validator=createConfigurationValidators({config,clock:()=>now,http:{request:async options=>{calls++;request=options;return {data:{data:models}};}}});
  const first=await validator.listModels();
  assert.deepEqual(first.map(({id,status,provider})=>({id,status,provider})),[
    {id:'google/good-model',status:'AVAILABLE',provider:'google'},
    {id:'anthropic/no-temperature',status:'INCOMPATIBLE',provider:'anthropic'},
    {id:'vendor/vision-only',status:'INCOMPATIBLE',provider:'vendor'},
    {id:'vendor/metadata-pending',status:'UNVERIFIED',provider:'vendor'},
  ]);
  assert.ok(first[1].reason);
  assert.equal(request.headers.Authorization,'Bearer test-only');
  assert.equal(calls,1);
  await validator.listModels();
  assert.equal(calls,1);
  now+=5*60_000+1;
  await validator.listModels();
  assert.equal(calls,2);
});
test('provider timeouts and rate limits fail closed without exposing upstream details',async()=>{
  const secret='sensitive-provider-response';
  for(const [provider,failure,expected] of [
    ['tebar',Object.assign(new Error(secret),{code:'ECONNABORTED'}),'TEBAR_UNAVAILABLE'],
    ['tebar',Object.assign(new Error(secret),{response:{status:429,data:{error:{message:secret}}}}),'TEBAR_RATE_LIMITED'],
    ['openrouter',Object.assign(new Error(secret),{code:'ECONNABORTED'}),'OPENROUTER_UNAVAILABLE'],
    ['openrouter',Object.assign(new Error(secret),{response:{status:429,data:{error:{message:secret}}}}),'OPENROUTER_RATE_LIMITED'],
  ]) {
    let request;
    const validator=createConfigurationValidators({config,http:{request:async options=>{request=options;throw failure;}}});
    const operation=provider==='tebar' ? validator.validateAccount({profileId:'profile',accountId:'acct'}) : validator.validateModel('vendor/model');
    await assert.rejects(operation,error=>error.code===expected && error.status===503 && !error.message.includes(secret) && !JSON.stringify(error).includes(secret));
    assert.equal(request.timeout,provider==='tebar'?30000:15000);
    assert.equal(request.maxRedirects,0);
  }
});
test('integration API enforces auth, CSRF, strict fields, confirmation, validation and version conflict',async t=>{
  let authenticated=false,writes=0,checks=0;const logs=[];const serverConfig={nodeEnv:'test',baseUrl:'http://localhost',tebar:{}};
  const store={getActive:async()=>({version:1,profileId:'old',accountId:'oldacct',model:'vendor/model',status:'ACTIVE'}),history:async()=>[],recordValidation:async()=>{},switchAccount:async({expectedVersion})=>{if(expectedVersion!==1)throw Object.assign(new Error('conflict'),{code:'CONFIG_CONFLICT',status:409});writes++;return {version:2,status:'ACTIVE'};}};
  const validator={validateAccount:async()=>{checks++;return {id:'acct',profileId:'profile',username:'tester',status:'active'};}};
  const auth={authenticate:async()=>authenticated?{admin:{id:7},csrfToken:'c'.repeat(43)}:null};
  const server=http.createServer(createServer({config:serverConfig,repository:{},auth,services:{configuration:store,configurationValidators:validator,logger:{info:(event,details)=>logs.push({event,details})}}}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections?.();}));
  const base=`http://127.0.0.1:${server.address().port}`;serverConfig.baseUrl=base;
  const cookie=`merzz_admin=${'a'.repeat(43)}`;
  const send=(path,body,csrf='c'.repeat(43))=>fetch(base+path,{method:'PUT',headers:{origin:base,cookie,'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify(body)});
  const unauthorized=await fetch(base+'/api/integrations');assert.equal(unauthorized.status,401);assert.match(unauthorized.headers.get('x-correlation-id'),/^[a-f0-9-]{36}$/);
  authenticated=true;
  const input={profileId:'profile',accountId:'acct',expectedVersion:1,confirmed:true};
  assert.equal((await send('/api/integrations/account',input,'bad')).status,403);
  assert.equal((await send('/api/integrations/account',{...input,extra:'bad'})).status,400);
  assert.equal((await send('/api/integrations/account',{...input,confirmed:false})).status,400);
  assert.equal((await send('/api/integrations/account',{...input,expectedVersion:2})).status,409);
  assert.equal((await send('/api/integrations/account',input)).status,200);
  assert.equal(writes,1);assert.equal(checks,2);
  assert.ok(logs.some(entry=>entry.event==='integration.http'&&entry.details.status===200&&entry.details.correlationId));
  assert.doesNotMatch(JSON.stringify(logs),/cccccccccc|acct|profile|Bearer|password/i);
});
test('OpenRouter catalog and model activation stay authenticated, CSRF-protected, validated and versioned',async t=>{
  let authenticated=false,modelVersion=1,writes=0,validations=0,catalogReads=0;
  const store={
    recordValidation:async()=>{},
    setModel:async({model,expectedVersion})=>{
      if(expectedVersion!==modelVersion)throw Object.assign(new Error('conflict'),{code:'CONFIG_CONFLICT',status:409});
      writes++;modelVersion++;
      return {version:modelVersion,profileId:'profile',accountId:'account',model,status:'ACTIVE'};
    },
  };
  const validator={
    listModels:async()=>{catalogReads++;return [{id:'vendor/good',name:'Good Model',provider:'vendor',status:'AVAILABLE',reason:null}];},
    validateModel:async(model)=>{
      validations++;
      if(model==='vendor/bad')throw Object.assign(new Error('MODEL_INCOMPATIBLE'),{code:'MODEL_INCOMPATIBLE',status:422});
      if(model==='vendor/unverified')throw Object.assign(new Error('MODEL_METADATA_UNVERIFIED'),{code:'MODEL_METADATA_UNVERIFIED',status:503});
      return {id:model,name:'Good Model',provider:'vendor',status:'AVAILABLE',reason:null};
    },
  };
  const serverConfig={nodeEnv:'test',baseUrl:'http://localhost',tebar:{}};
  const server=http.createServer(createServer({config:serverConfig,repository:{},auth:{authenticate:async()=>authenticated?{admin:{id:7},csrfToken:'c'.repeat(43)}:null},services:{configuration:store,configurationValidators:validator}}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections?.();}));
  const base=`http://127.0.0.1:${server.address().port}`;
  serverConfig.baseUrl=base;
  const cookie=`merzz_admin=${'a'.repeat(43)}`;
  const request=(path,method='GET',body,csrf='c'.repeat(43))=>fetch(base+path,{method,headers:{origin:base,cookie,'content-type':'application/json','x-csrf-token':csrf},...(body===undefined?{}:{body:JSON.stringify(body)})});
  assert.equal((await fetch(base+'/api/integrations/models')).status,401);
  authenticated=true;
  const catalog=await request('/api/integrations/models');
  assert.equal(catalog.status,200);
  assert.deepEqual((await catalog.json()).models[0],{id:'vendor/good',name:'Good Model',provider:'vendor',status:'AVAILABLE',reason:null});
  assert.equal(catalogReads,1);
  assert.equal((await request('/api/integrations/validate-model','POST',{model:'vendor/good'},'bad')).status,403);
  assert.equal((await request('/api/integrations/validate-model','POST',{model:'bad format'})).status,400);
  const validated=await request('/api/integrations/validate-model','POST',{model:'vendor/good'});
  assert.equal(validated.status,200);
  assert.equal((await validated.json()).model.status,'AVAILABLE');
  const unverified=await request('/api/integrations/validate-model','POST',{model:'vendor/unverified'});
  assert.equal(unverified.status,503);
  assert.deepEqual(await unverified.json(),{error:'MODEL_METADATA_UNVERIFIED'});
  assert.equal((await request('/api/integrations/model','PUT',{model:'vendor/bad',expectedVersion:1})).status,422);
  assert.equal(writes,0);
  assert.equal((await request('/api/integrations/model','PUT',{model:'vendor/good',expectedVersion:2})).status,409);
  assert.equal(writes,0);
  const saved=await request('/api/integrations/model','PUT',{model:'vendor/good',expectedVersion:1});
  assert.equal(saved.status,200);
  assert.equal((await saved.json()).configuration.model,'vendor/good');
  assert.equal(writes,1);
  assert.equal(modelVersion,2);
  assert.doesNotMatch(JSON.stringify({catalogReads,validations,writes}),/Bearer|test-only|password/i);
});
