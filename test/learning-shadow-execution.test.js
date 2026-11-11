'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLearningShadowExecutionService } = require('../src/learning-shadow-execution');

function fixture(overrides = {}) {
  const calls=[];
  const context={
  settings:{brand:{name:'Kedai Merzz',voice:'Santai',contentDirection:'Pilih sudut kreatif.'},gameWhitelist:['Mobile Legends'],hashtags:['#KedaiMerzz'],trackedLinks:{topup:'https://kedaimerzz.com/topup',account:'https://kedaimerzz.com/account'},guardrails:{approved:true,forbiddenClaims:[],approvedClaims:[],hookVocabulary:[]},priceMode:'OFF',schedule:{}},
    facts:[],history:[{id:'old',status:'published',pillar:'topup',caption:'Pemain biasanya berbincang strategi.',completedAt:'2026-11-09T00:00:00.000Z',factBearing:false}],
  };
  const repository={getRuntimeState:async()=>structuredClone(context)};
  const service=createLearningShadowExecutionService({
    store:{acquireAdmission:async()=>({assertHealthy:async()=>{},release:async()=>{}}),start:async()=>`s${calls.length+1}`,finish:async()=>true},
    repository,
    configuration:{getActive:async()=>({model:'provider/model',version:12,status:'ACTIVE'})},
    learningStore:{getApprovedRuleVersions:async(ids)=>ids.map((id)=>({id,version:3,instruction:'Gunakan pemerhatian gamer.',productCategory:'account',contentTopic:'all',decision:'approved'}))},
    providerForModel:async(model)=>{calls.push({provider:model});return async()=>'';},
    generatorSampling:{temperature:0.4,topP:0.9},
    generatePostImpl:async(scenario,options)=>{
      calls.push({scenario,options});
      await options.generate({system:'system',user:'prompt',maxTokens:100});
      await options.generate({system:'audit',user:'caption',maxTokens:50});
      return {status:'ready',outcome:'passed',deterministicOutcome:'PASSED',semanticOutcome:'PASSED',failureCodes:[],text:'Teks tervalidasi.',attempts:1};
    },
    ...overrides,
  });
  return {service,calls,repository};
}

test('shadow execution compares the same read-only scenario and limits learning to approved matching rules', async()=>{
  const {service,calls}=fixture();
  const result=await service.evaluate({actorId:7,ruleIds:['4'],samples:1});
  assert.equal(result.status,'completed');
  const variants=calls.filter((call)=>call.options);
  assert.equal(variants.length,2);
  assert.deepEqual(variants[0].scenario,variants[1].scenario);
  assert.equal(variants[0].options.executionMode,'shadow');
  assert.equal(variants[0].options.learningRules.length,0);
  assert.equal(variants[1].options.learningRules[0].id,'4');
  assert.equal(variants[1].options.learningRules[0].version,3);
  assert.equal(variants[0].options.maxAttempts,1);
  assert.equal(variants[0].scenario.slot,undefined);
  assert.equal(variants[1].scenario.slot,undefined);
});

test('shadow execution rejects missing approval and mismatched rule scope before any provider call', async()=>{
  const {service,calls}=fixture({learningStore:{getApprovedRuleVersions:async()=>[]}});
  await assert.rejects(service.evaluate({actorId:7,ruleIds:['4'],samples:1}),{code:'APPROVED_RULES_REQUIRED'});
  assert.equal(calls.some((call)=>call.options),false);
});

test('shadow evaluation has no publishing, scheduler, or ready-slot mutation path', async()=>{
  let forbiddenCalls=0;
  const blocked=()=>{forbiddenCalls++;throw new Error('publishing path must not be reached');};
  const {service,repository}=fixture({publisherForProfile:blocked,scheduler:{runNow:blocked},dispatcher:{dispatch:blocked}});
  repository.saveSlot=blocked; repository.updateSlot=blocked; repository.createSlot=blocked;
  const result=await service.evaluate({actorId:7,ruleIds:['4'],samples:1});
  assert.equal(result.status,'completed');
  assert.equal(forbiddenCalls,0);
});

test('shadow execution serializes concurrent requests in one process', async()=>{
  let resume; let started=0;
  const {service}=fixture({generatePostImpl:async(_scenario,options)=>{
    started++;
    if(started===1) await new Promise((resolve)=>{resume=resolve;});
    await options.generate({system:'s',user:'u',maxTokens:10});
    return {status:'ready',outcome:'passed',deterministicOutcome:'PASSED',semanticOutcome:'PASSED',text:'ok'};
  }});
  const first=service.evaluate({actorId:7,ruleIds:['4'],samples:1});
  await new Promise((resolve)=>setImmediate(resolve));
  await assert.rejects(service.evaluate({actorId:7,ruleIds:['4'],samples:1}),{code:'SHADOW_BUSY'});
  resume(); await first;
});

test('shadow shutdown stops new work and aborts an in-flight provider request', async()=>{
  let signal; let started;
  const began=new Promise((resolve)=>{started=resolve;});
  const {service}=fixture({providerForModel:async()=>async(request)=>{
    signal=request.signal; started();
    return new Promise((_resolve,reject)=>request.signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{code:'SHADOW_SHUTTING_DOWN'})),{once:true}));
  },generatePostImpl:async(_scenario,options)=>{
    await options.generate({system:'s',user:'u',maxTokens:10});
    return {status:'ready',outcome:'passed',deterministicOutcome:'PASSED',semanticOutcome:'PASSED',text:'ok'};
  }});
  const running=service.evaluate({actorId:7,ruleIds:['4'],samples:1});
  await began;
  service.stop();
  assert.equal(signal.aborted,true);
  await assert.rejects(running);
  await assert.rejects(service.evaluate({actorId:7,ruleIds:['4'],samples:1}),{code:'SHADOW_SHUTTING_DOWN'});
});
