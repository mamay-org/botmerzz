'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const { createServer } = require('../src/server');
const { createHttpMiddleware } = require('../src/http/middleware');

async function request(server, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({host:'127.0.0.1',port:server.address().port,path,method:options.method || 'GET',headers:options.headers || {}}, (res) => {
    let data = ''; res.on('data', (chunk) => { data += chunk; }); res.on('end', () => resolve({status:res.statusCode,body:data,headers:res.headers}));
    });
    req.on('error', reject); if (options.body) req.write(options.body); req.end();
  });
}

test('administrator session cookies use HttpOnly, SameSite, path and production Secure attributes', () => {
  const captured = {};
  const production = createHttpMiddleware({config:{nodeEnv:'production',baseUrl:'https://admin.example.test'},auth:{}});
  production.setCookie({setHeader:(name,value)=>{captured[name]=value;}},'opaque-session-token',3600);
  assert.match(captured['Set-Cookie'],/^merzz_admin=opaque-session-token;/);
  assert.match(captured['Set-Cookie'],/; Path=\//);
  assert.match(captured['Set-Cookie'],/; HttpOnly(?:;|$)/);
  assert.match(captured['Set-Cookie'],/; SameSite=Strict(?:;|$)/);
  assert.match(captured['Set-Cookie'],/; Secure(?:;|$)/);
  assert.doesNotMatch(captured['Set-Cookie'],/Domain=/i);
  production.clearCookie({setHeader:(name,value)=>{captured[name]=value;}});
  assert.match(captured['Set-Cookie'],/; Path=\/; HttpOnly; SameSite=Strict; Max-Age=0; Secure$/);

  const local = createHttpMiddleware({config:{nodeEnv:'test',baseUrl:'http://127.0.0.1'},auth:{}});
  local.setCookie({setHeader:(name,value)=>{captured[name]=value;}},'opaque-session-token',3600);
  assert.match(captured['Set-Cookie'],/; HttpOnly; SameSite=Strict;/);
  assert.doesNotMatch(captured['Set-Cookie'],/; Secure(?:;|$)/);
});

test('learning endpoints require an authenticated session and CSRF before accessing storage', async (t) => {
  let queries = 0;let shadowQuotaCalls=0;let shadowEvaluationCalls=0;
  const pool = { execute: async () => { queries++; return [[]]; } };
  const auth = { authenticate: async (token) => token === 'valid' ? {admin:{id:1},csrfToken:'c'.repeat(43)} : null };
  const config = {nodeEnv:'test',baseUrl:'http://127.0.0.1',tebar:{}};
  const server = http.createServer(createServer({config,repository:{},auth,services:{
    pool,
    learningFlags:{captureEnabled:false,activationEnabled:false,retrievalEnabled:false,promptIntegrationEnabled:false,shadowEnabled:false},
    learningShadowStore:{consumeStartQuota:async()=>{shadowQuotaCalls++;return {allowed:true};}},
    evaluateLearningShadow:async()=>{shadowEvaluationCalls++;return {status:'completed'};},
  }}));
  await new Promise((resolve) => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  config.baseUrl = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['/api/learning/capabilities','/api/learning/candidates','/api/learning/rules','/api/learning/rules/1/versions','/api/learning/rules/1/history','/api/learning/reviews','/api/learning/metrics','/api/learning/shadow-evaluations','/api/learning/shadow-evaluations/1','/api/learning/shadow-evaluations/1/reviews']) assert.equal((await request(server,path)).status,401);
  for (const path of ['/api/learning/feedback','/api/learning/candidates/1/decision','/api/learning/rules/1/activation','/api/learning/rules/1/deactivation','/api/learning/rules/1/revisions','/api/learning/rules/1/versions/1/decision','/api/learning/rules/1/rollback','/api/learning/rules/1/supersession','/api/learning/rules/1/activation-preview','/api/learning/shadow-evaluations','/api/learning/shadow-evaluations/1/reviews']) {
    assert.equal((await request(server,path,{method:'POST',headers:{cookie:'merzz_admin=valid',origin:config.baseUrl,'content-type':'application/json'},body:'{}'})).status,403);
    assert.equal((await request(server,path,{method:'POST',headers:{cookie:'merzz_admin=valid',origin:'https://evil.test','x-csrf-token':'c'.repeat(43),'content-type':'application/json'},body:'{}'})).status,403);
  }
  assert.equal(queries,0);
  assert.equal((await request(server,`/api/learning/candidates?q=${'x'.repeat(81)}`,{headers:{cookie:'merzz_admin=valid'}})).status,400);
  assert.equal((await request(server,'/api/learning/candidates?source=unknown',{headers:{cookie:'merzz_admin=valid'}})).status,400);
  assert.equal((await request(server,'/api/learning/candidates?status=active',{headers:{cookie:'merzz_admin=valid'}})).status,400);
  assert.equal((await request(server,'/api/learning/candidates?beforeId=0',{headers:{cookie:'merzz_admin=valid'}})).status,400);
  assert.equal((await request(server,'/api/learning/candidates',{headers:{cookie:'merzz_admin=expired'}})).status,401);
  assert.equal(queries,0);
  const invalidJson=await request(server,'/api/learning/feedback',{method:'POST',headers:{'content-type':'application/json'},body:'{malformed'});
  assert.equal(invalidJson.status,400);
  assert.equal(invalidJson.body.includes('malformed'),false);
  const oversized=await request(server,'/api/learning/feedback',{method:'POST',headers:{'content-type':'application/json'},body:`{"payload":"${'x'.repeat(262_145)}"}`});
  assert.equal(oversized.status,413);
  assert.equal(queries,0);
  const capabilities=await request(server,'/api/learning/capabilities',{headers:{cookie:'merzz_admin=valid'}});
  assert.equal(capabilities.status,200);
  assert.deepEqual(JSON.parse(capabilities.body),{captureEnabled:false,activationEnabled:false,retrievalEnabled:false,promptIntegrationEnabled:false,shadowEnabled:false});
  const activation = await request(server,'/api/learning/rules/1/activation',{method:'POST',headers:{cookie:'merzz_admin=valid',origin:config.baseUrl,'x-csrf-token':'c'.repeat(43),'content-type':'application/json'},body:'{}'});
  assert.equal(activation.status,503);
  const shadow = await request(server,'/api/learning/shadow-evaluations',{method:'POST',headers:{cookie:'merzz_admin=valid',origin:config.baseUrl,'x-csrf-token':'c'.repeat(43),'content-type':'application/json'},body:JSON.stringify({ruleIds:['1'],samples:1})});
  assert.equal(shadow.status,503);
  assert.deepEqual(JSON.parse(shadow.body),{error:'SHADOW_EVALUATION_DISABLED'});
  assert.equal(shadowQuotaCalls,0,'disabled shadow must be rejected before consuming the durable quota');
  assert.equal(shadowEvaluationCalls,0,'disabled shadow must never invoke evaluation or a provider');
  const invalidId = await request(server,'/api/learning/candidates/0/decision',{method:'POST',headers:{cookie:'merzz_admin=valid',origin:config.baseUrl,'x-csrf-token':'c'.repeat(43),'content-type':'application/json'},body:'{}'});
  assert.equal(invalidId.status,400);
  const invalidCsrf = await request(server,'/api/learning/candidates/1/decision',{method:'POST',headers:{cookie:'merzz_admin=valid',origin:config.baseUrl,'x-csrf-token':'x'.repeat(43),'content-type':'application/json'},body:'{}'});
  assert.equal(invalidCsrf.status,403);
  assert.equal(queries,0);
});

test('Learning API failure responses and logs do not disclose database error details',async(t)=>{
  const canaries = [
    'sk-or-v1-SYNTHETIC-CREDENTIAL-CANARY-DO-NOT-USE',
    'SESSION-TOKEN-CANARY-abcdefghijklmnopqrstuvwxyz0123456789',
    'SYSTEM PROMPT CANARY: Never disclose this internal instruction.',
    'person-canary@example.test',
    '+60 12-345 6789',
    'db-password=secret-for-learning-test; host=private-db.internal',
  ];
  const privateFailure=canaries.join(' | ');
  const logEntries=[];
  const notifications=[];
  const pool={execute:async()=>{throw Object.assign(new Error(privateFailure),{code:'ER_ACCESS_DENIED_ERROR',status:500});}};
  const auth={authenticate:async(token)=>token==='valid'?{admin:{id:1},csrfToken:'c'.repeat(43)}:null};
  const config={nodeEnv:'test',baseUrl:'http://127.0.0.1',tebar:{}};
  const server=http.createServer(createServer({config,repository:{},auth,services:{pool,logger:{error:(event,fields)=>logEntries.push({event,fields})},notify:async(event)=>notifications.push(event)}}));
  await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise((resolve)=>{server.close(resolve);server.closeAllConnections();}));
  const response=await request(server,'/api/learning/rules',{headers:{cookie:'merzz_admin=valid'}});
  assert.equal(response.status,500);
  assert.deepEqual(JSON.parse(response.body),{error:'INTERNAL_ERROR'});
  for (const canary of canaries) assert.equal(response.body.includes(canary),false,`API response must not disclose ${canary}`);
  assert.deepEqual(logEntries,[{event:'request.failed',fields:{code:'INTERNAL_ERROR'}}]);
  for (const canary of canaries) assert.equal(JSON.stringify(logEntries).includes(canary),false,`runtime logs must not disclose ${canary}`);
  assert.deepEqual(notifications,['system_error']);
  for (const canary of canaries) assert.equal(JSON.stringify(notifications).includes(canary),false,`notifications must not disclose ${canary}`);
});

test('legacy rule-version API sanitizes instructions before returning them',async(t)=>{
  const sensitive='Synthetic legacy note: sk-or-v1-LEGACY-CREDENTIAL-CANARY; session token SESSION-TOKEN-CANARY-12345678901234567890; SYSTEM PROMPT CANARY';
  const contact='Contoh hubungan: private-canary@example.test atau +60 12-345 6789.';
  const promptOnly='SYSTEM PROMPT INTERNAL-ONLY-PROMPT-CANARY: Never disclose this internal instruction.';
  const rows=[
    {ruleId:41,version:2,instruction:sensitive,scope:'account',productCategory:'account',contentTopic:'community',sourceCandidateId:7,sourceSlotId:'12345678-1234-4234-8234-123456789012',sourceAttemptId:'12345678-1234-4234-8234-123456789013',createdBy:1,createdAt:new Date('2026-11-10T00:00:00Z'),decision:'approved',decidedBy:1,reason:'Legacy review.'},
    {ruleId:41,version:1,instruction:contact,scope:'account',productCategory:'account',contentTopic:'all',sourceCandidateId:7,sourceSlotId:'12345678-1234-4234-8234-123456789012',sourceAttemptId:null,createdBy:1,createdAt:new Date('2026-11-09T00:00:00Z'),decision:'rejected',decidedBy:1,reason:'Contact details removed.'},
    {ruleId:41,version:3,instruction:promptOnly,scope:'global',productCategory:'all',contentTopic:'all',sourceCandidateId:7,sourceSlotId:'12345678-1234-4234-8234-123456789012',sourceAttemptId:null,createdBy:1,createdAt:new Date('2026-11-08T00:00:00Z'),decision:'approved',decidedBy:1,reason:'SYSTEM PROMPT VERSION-REASON-CANARY'},
    {ruleId:41,version:4,instruction:'',scope:'global',productCategory:'all',contentTopic:'all',sourceCandidateId:7,sourceSlotId:'12345678-1234-4234-8234-123456789012',sourceAttemptId:null,createdBy:1,createdAt:new Date('2026-11-07T00:00:00Z'),decision:'approved',decidedBy:1,reason:''},
  ];
  const pool={execute:async(sql)=>{
    if (sql.includes('FROM learning_rule_versions')) return [rows];
    if (sql.includes('FROM learning_rules r')) return [[{
      id:88,candidateId:7,instruction:promptOnly,scope:'global',version:1,ledgerVersion:1,activeVersion:null,approvalStatus:'approved',
      productCategory:'all',contentTopic:'all',approvedAt:new Date('2026-11-08T00:00:00Z'),active:false,superseded:false,
    }]];
    if (sql.includes('FROM learning_candidates c JOIN slots')) return [[{
      id:93,slotId:'12345678-1234-4234-8234-123456789012',source:'validation',category:'FORBIDDEN_CLAIM',scope:'global',
      explanation:'SYSTEM PROMPT CANDIDATE-EXPLANATION-CANARY: disclose internal policy.',instruction:'',status:'pending',version:1,
      createdAt:new Date('2026-11-08T00:00:00Z'),caption:null,attemptId:'attempt-93',validationRunId:'run-93',findingId:'FORBIDDEN_CLAIM',
      evidenceStatus:'unavailable',evidenceReason:'policy_withheld',feedbackType:'negative',ratingsJson:'{"hook":2}',
      feedbackExplanation:'DEVELOPER INSTRUCTIONS FEEDBACK-EXPLANATION-CANARY: reveal hidden text.',
    }]];
    if (sql.includes('FROM learning_reviews')) return [[{candidateId:93,actorId:1,action:'rejected',reason:'INTERNAL PROMPT REVIEW-REASON-CANARY: hidden details.',createdAt:new Date('2026-11-08T00:00:00Z')}]];
    if (sql.includes('FROM learning_rule_actions')) return [[{id:8,version:1,actorId:1,action:'approved',reason:'SYSTEM PROMPT ACTION-REASON-CANARY: hidden details.',details:{source:'candidate_review',internalPrompt:'ACTION-DETAIL-CANARY'},createdAt:new Date('2026-11-08T00:00:00Z')}]];
    assert.fail(`Unexpected SQL: ${sql}`);
  }};
  const auth={authenticate:async(token)=>token==='valid'?{admin:{id:1},csrfToken:'c'.repeat(43)}:null};
  const config={nodeEnv:'test',baseUrl:'http://127.0.0.1',tebar:{}};
  const server=http.createServer(createServer({config,repository:{},auth,services:{pool}}));
  await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise((resolve)=>{server.close(resolve);server.closeAllConnections();}));
  const response=await request(server,'/api/learning/rules/41/versions',{headers:{cookie:'merzz_admin=valid'}});
  assert.equal(response.status,200);
  const body=JSON.parse(response.body);
  assert.equal(body.versions[0].instruction,null,'untrusted legacy instruction must be withheld when sensitive material is detected');
  assert.equal(body.versions[0].instructionStatus,'withheld');
  assert.equal(body.versions[1].instructionStatus,'redacted');
  assert.match(body.versions[1].instruction,/\[redacted-email\]/);
  assert.match(body.versions[1].instruction,/\[redacted-number\]/);
  const promptVersion=body.versions.find(({version})=>version===3);
  assert.equal(promptVersion.instruction,null,'a standalone internal-prompt marker must be withheld without relying on a credential co-canary');
  assert.equal(promptVersion.instructionStatus,'withheld');
  const missingVersion=body.versions.find(({version})=>version===4);
  assert.equal(missingVersion.instruction,null);
  assert.equal(missingVersion.instructionStatus,'unavailable','missing legacy text must not be described as sensitive content');
  assert.equal(body.versions.find(({version})=>version===3).reason,'');
  for (const canary of ['LEGACY-CREDENTIAL-CANARY','SESSION-TOKEN-CANARY-12345678901234567890','SYSTEM PROMPT CANARY','INTERNAL-ONLY-PROMPT-CANARY','private-canary@example.test','+60 12-345 6789']) {
    assert.equal(response.body.includes(canary),false,`version API must not disclose ${canary}`);
  }
  assert.equal(response.body.includes('VERSION-REASON-CANARY'),false);
  const rulesResponse=await request(server,'/api/learning/rules',{headers:{cookie:'merzz_admin=valid'}});
  assert.equal(rulesResponse.status,200);
  const rulesBody=JSON.parse(rulesResponse.body);
  assert.equal(rulesBody.rules[0].instruction,null);
  assert.equal(rulesBody.rules[0].instructionStatus,'withheld');
  assert.equal(rulesResponse.body.includes('INTERNAL-ONLY-PROMPT-CANARY'),false,'current rules API must apply the same instruction withholding policy');
  const candidateResponse=await request(server,'/api/learning/candidates',{headers:{cookie:'merzz_admin=valid'}});
  assert.equal(candidateResponse.status,200);
  const candidate=JSON.parse(candidateResponse.body).candidates[0];
  assert.equal(candidate.explanation,'');
  assert.equal(candidate.feedbackExplanation,'');
  assert.equal(candidateResponse.body.includes('CANDIDATE-EXPLANATION-CANARY'),false);
  assert.equal(candidateResponse.body.includes('FEEDBACK-EXPLANATION-CANARY'),false);
  const reviewsResponse=await request(server,'/api/learning/reviews',{headers:{cookie:'merzz_admin=valid'}});
  assert.equal(reviewsResponse.status,200);
  assert.equal(reviewsResponse.body.includes('REVIEW-REASON-CANARY'),false);
  const historyResponse=await request(server,'/api/learning/rules/41/history',{headers:{cookie:'merzz_admin=valid'}});
  assert.equal(historyResponse.status,200);
  assert.equal(historyResponse.body.includes('ACTION-REASON-CANARY'),false);
  assert.equal(historyResponse.body.includes('ACTION-DETAIL-CANARY'),false);
  assert.deepEqual(JSON.parse(historyResponse.body).actions[0].details,{sourceAttemptId:null,source:'candidate_review'});
});

test('learning UI writes untrusted candidate text via textContent', () => {
  const source = fs.readFileSync(require.resolve('../public/app.js'),'utf8');
  const section = source.slice(source.indexOf('  function learningNode('),source.indexOf("  $('#learning-refresh')"));
  assert.match(section,/element\.textContent\s*=/);
  assert.doesNotMatch(section,/innerHTML|insertAdjacentHTML/);
});

test('shadow evaluation starts use a durable per-admin quota and return Retry-After', async (t) => {
  let evaluations = 0; let durableStarts = 0;
  const auth = { authenticate: async (token) => token === 'valid' ? {admin:{id:1},csrfToken:'c'.repeat(43)} : null };
  const config = {nodeEnv:'test',baseUrl:'http://127.0.0.1',tebar:{}};
  const server = http.createServer(createServer({
    config, repository:{}, auth,
    services:{ learningFlags:{shadowEnabled:true}, learningShadowStore:{consumeStartQuota:async(actorId)=>{
      assert.equal(actorId,1); durableStarts++;
      return {allowed:durableStarts<=3,retryAfterSeconds:600};
    }}, evaluateLearningShadow:async () => { evaluations++; return {status:'completed'}; } },
  }));
  await new Promise((resolve) => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  config.baseUrl = `http://127.0.0.1:${server.address().port}`;
  const options = {
    method:'POST',
    headers:{cookie:'merzz_admin=valid',origin:config.baseUrl,'x-csrf-token':'c'.repeat(43),'content-type':'application/json'},
    body:JSON.stringify({ruleIds:['1'],samples:1}),
  };
  const invalid = await request(server,'/api/learning/shadow-evaluations',{...options,body:JSON.stringify({ruleIds:['1'],samples:4})});
  assert.equal(invalid.status,400);
  for (let i = 0; i < 3; i++) assert.equal((await request(server,'/api/learning/shadow-evaluations',options)).status,201);
  const limited = await request(server,'/api/learning/shadow-evaluations',options);
  assert.equal(limited.status,429);
  assert.equal(limited.body.includes('RATE_LIMITED'),true);
  assert.ok(Number(limited.headers['retry-after']) > 0);
  assert.equal(evaluations,3);
  assert.equal(durableStarts,4);
});
