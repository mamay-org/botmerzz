'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {validId,validModel,snapshot}=require('../src/configuration');
const {createConfigurationValidators}=require('../src/configuration-providers');
const {createServer}=require('../src/server');

const config={tebar:{apiKey:'test-only'},openRouter:{apiKey:'test-only',generatorSampling:{temperature:0.4}}};
test('configuration input and snapshots fail closed on malformed values',()=>{
  assert.equal(validId('profile_123'),true);assert.equal(validId('x/../z'),false);
  assert.equal(validModel('google/gemini-2.5-flash:free'),true);assert.equal(validModel('https://bad.test'),false);
  assert.throws(()=>snapshot({version:1,status:'ACTIVE',profile_id:'x',account_id:null,model:'x/y'}),e=>e.code==='CONFIG_UNAVAILABLE');
  assert.throws(()=>snapshot({version:1,status:'BLOCKED_RECONCILIATION',profile_id:'x',account_id:'y',model:'x/y'}),e=>e.code==='CONFIG_UNAVAILABLE');
  assert.ok(Object.isFrozen(snapshot({version:1,status:'ACTIVE',profile_id:'x',account_id:'y',model:'x/y'})));
});
test('account verification rejects mismatch, non-Threads, inactive and suspended targets',async()=>{
  let target={id:'acct',profileId:'profile',platform:'threads',status:'active',planSuspended:false,username:'tester'};
  const validator=createConfigurationValidators({config,tebarFactory:()=>({listAccounts:async()=>[target]})});
  assert.equal((await validator.validateAccount({profileId:'profile',accountId:'acct'})).username,'tester');
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
test('model validation checks metadata, sampling parameters and provider errors',async()=>{
  let metadata={id:'vendor/model:free',name:'Test',architecture:{input_modalities:['text'],output_modalities:['text']},supported_parameters:['max_tokens','temperature']};
  const client={request:async()=>({data:{data:metadata}})};
  const validator=createConfigurationValidators({config,http:client});
  assert.equal((await validator.validateModel('vendor/model:free')).id,'vendor/model:free');
  metadata={...metadata,supported_parameters:['max_tokens']};
  await assert.rejects(validator.validateModel('vendor/model:free'),e=>e.code==='MODEL_INCOMPATIBLE');
  metadata={...metadata,architecture:{input_modalities:['image'],output_modalities:['text']}};
  await assert.rejects(validator.validateModel('vendor/model:free'),e=>e.code==='MODEL_INCOMPATIBLE');
  const down=createConfigurationValidators({config,http:{request:async()=>{throw Object.assign(new Error('secret'),{response:{status:429}});}}});
  await assert.rejects(down.validateModel('vendor/model:free'),e=>e.code==='OPENROUTER_RATE_LIMITED'&&!e.message.includes('secret'));
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
