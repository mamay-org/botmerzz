const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {createServer}=require('../src/server');

function request(server,path,{method='GET',headers={},body}={}){return new Promise((resolve,reject)=>{const address=server.address();const req=http.request({host:'127.0.0.1',port:address.port,path,method,headers:{...(body?{'content-type':'application/json'}:{}),...headers}},res=>{let data='';res.on('data',c=>data+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:data}));});req.setTimeout(3000,()=>req.destroy(new Error(`HTTP timeout ${method} ${path}`)));req.on('error',reject);if(body)req.write(body);req.end();});}
function closeServer(server){return new Promise(resolve=>{server.close(resolve);server.closeAllConnections?.();});}

test('proxy trust is scoped to the configured ingress IP',()=>{
  const app=createServer({config:{nodeEnv:'production',baseUrl:'https://botmerzz.example',trustProxy:'192.168.0.80'},repository:{},auth:{}});
  const trusted=app.get('trust proxy fn');
  assert.equal(trusted('192.168.0.80'),true);
  assert.equal(trusted('192.168.0.81'),false);
});

test('health, dashboard auth, static UI, same-origin login, CSRF and logout are enforced',async t=>{
  let token='';let logoutCalls=0;const config={nodeEnv:'test',baseUrl:'http://localhost',tebar:{}};
  const repository={healthCheck:async()=>{},getRuntimeState:async()=>({settings:{schedule:{},brand:{},guardrails:{}},facts:[],history:[],automationEnabled:false}),listFacts:async()=>({}),listSlots:async()=>[],listActivity:async()=>[],listAudit:async()=>[],saveSettings:async x=>x,saveKnowledge:async x=>x,saveFact:async()=>({}),setAutomationEnabled:async()=>{},};
  const auth={login:async()=>({token:'a'.repeat(43),csrfToken:'b'.repeat(43),expiresAt:new Date(Date.now()+3600000),admin:{id:1,email:'x@example.test'}}),authenticate:async value=>value===token?{admin:{id:1,email:'x@example.test'},csrfToken:'b'.repeat(43)}:null,logout:async value=>{assert.equal(value,'a'.repeat(43));logoutCalls++;token='';}};
  const app=createServer({config,repository,auth,services:{getProviderStatus:async()=>({connected:false}),getClickMetric:async()=>({available:true,value:12,reason:null}),schedulerStatus:()=>({enabled:true,lastErrorCode:'INTERNAL_DETAIL'})}});
  const server=require('node:http').createServer(app);const listening=new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});server.listen(0,'127.0.0.1');await listening;t.after(()=>closeServer(server));
  config.baseUrl=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await request(server,'/health/live')).status,200);const ready=await request(server,'/health/ready');assert.equal(ready.status,200);assert.deepEqual(JSON.parse(ready.body),{status:'ready'});
  const malformedCookie=await request(server,'/api/session',{headers:{cookie:'merzz_admin=%E0%A4%A'}});assert.equal(malformedCookie.status,200);assert.deepEqual(JSON.parse(malformedCookie.body),{authenticated:false});
  assert.equal((await request(server,'/api/dashboard')).status,401);
  const staticPage=await request(server,'/');assert.equal(staticPage.status,200);assert.match(staticPage.body,/Panel Threads/);assert.equal(staticPage.headers['x-frame-options'],'DENY');assert.match(staticPage.body,/name="hours"[^>]*min="0"/);assert.match(staticPage.body,/name="minutes"[^>]*min="0"[^>]*max="59"/);assert.match(staticPage.body,/Minimal 1 menit/);assert.match(staticPage.body,/name="hashtags"/);assert.match(staticPage.body,/name="contentDirection"/);assert.match(staticPage.body,/name="hookVocabulary"/);assert.match(staticPage.body,/Kosakata hook yang disarankan/);assert.doesNotMatch(staticPage.body,/Hook yang dibuat tetap harus memakai kosakata yang disetujui|Arahan yang memerlukan kata lain dapat ditolak/i);assert.doesNotMatch(staticPage.body,/id="active-days"|name="activeStart"|name="activeEnd"/);assert.match(staticPage.body,/22:00.*Malaysia/);
  assert.equal((await request(server,'/api/session/login',{method:'POST',headers:{origin:'https://evil.test'},body:'{}'})).status,403);
  const login=await request(server,'/api/session/login',{method:'POST',headers:{origin:config.baseUrl},body:JSON.stringify({email:'x',password:'y'})});assert.equal(login.status,200);token='a'.repeat(43);
  const cookie=login.headers['set-cookie'][0].split(';')[0];
  const dashboard=await request(server,'/api/dashboard',{headers:{cookie}});assert.equal(dashboard.status,200);assert.deepEqual(JSON.parse(dashboard.body).metrics.clicks,{available:true,value:12,reason:null});
  const onboarding=JSON.parse(dashboard.body).onboarding;
  assert.deepEqual(onboarding.filter(item=>item.required).map(item=>item.key),['brand','links','hashtags','thread','ai']);
  assert.ok(onboarding.filter(item=>!item.required).every(item=>item.required===false&&['games','guardrails','facts'].includes(item.key)));
  const vocabulary=['  Cerita pengalaman  ','cerita PENGALAMAN','Sembang santai'];
  const knowledge=await request(server,'/api/knowledge',{method:'PUT',headers:{origin:config.baseUrl,cookie,'x-csrf-token':'b'.repeat(43)},body:JSON.stringify({guardrails:{approved:true,hookVocabulary:vocabulary}})});
  assert.equal(knowledge.status,200,knowledge.body);assert.deepEqual(JSON.parse(knowledge.body).guardrails.hookVocabulary,['Cerita pengalaman','Sembang santai']);
  const badCsrf=await request(server,'/api/automation/pause',{method:'POST',headers:{origin:config.baseUrl,cookie,'x-csrf-token':'wrong'},body:'{}'});assert.equal(badCsrf.status,403);
  const nonAsciiCsrf=await request(server,'/api/automation/pause',{method:'POST',headers:{origin:config.baseUrl,cookie,'x-csrf-token':'é'+'b'.repeat(42)},body:'{}'});assert.equal(nonAsciiCsrf.status,403);assert.deepEqual(JSON.parse(nonAsciiCsrf.body),{error:'CSRF_REJECTED'});
  const goodCsrf=await request(server,'/api/automation/pause',{method:'POST',headers:{origin:config.baseUrl,cookie,'x-csrf-token':'b'.repeat(43)},body:'{}'});assert.equal(goodCsrf.status,200);
  const logoutWithoutCsrf=await request(server,'/api/session/logout',{method:'POST',headers:{origin:config.baseUrl,cookie}});assert.equal(logoutWithoutCsrf.status,403);assert.equal(logoutCalls,0);
  const logout=await request(server,'/api/session/logout',{method:'POST',headers:{origin:config.baseUrl,cookie,'x-csrf-token':'b'.repeat(43)}});assert.equal(logout.status,200);assert.deepEqual(JSON.parse(logout.body),{ok:true});assert.equal(logoutCalls,1);
  assert.match(logout.headers['set-cookie'][0],/merzz_admin=; Path=\/; HttpOnly; SameSite=Strict; Max-Age=0/);
  assert.deepEqual(JSON.parse((await request(server,'/api/session',{headers:{cookie}})).body),{authenticated:false});
  assert.equal((await request(server,'/api/learning/candidates',{headers:{cookie}})).status,401);
});

test('unexpected server error codes are hidden while integration availability errors remain actionable',async t=>{
  const config={nodeEnv:'test',baseUrl:'http://localhost',tebar:{}};
  let failure=Object.assign(new Error('database details'),{code:'ER_ACCESS_DENIED_ERROR'});
  const services={configuration:{getActive:async()=>{throw failure;},history:async()=>[]},configurationValidators:{}};
  const auth={authenticate:async()=>({admin:{id:1},csrfToken:'c'.repeat(43)})};
  const server=http.createServer(createServer({config,repository:{},auth,services}));
  server.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});t.after(()=>closeServer(server));
  const headers={cookie:'merzz_admin=token'};
  let response=await request(server,'/api/integrations',{headers});
  assert.equal(response.status,500);assert.deepEqual(JSON.parse(response.body),{error:'INTERNAL_ERROR'});
  failure=Object.assign(new Error('unavailable'),{code:'CONFIG_UNAVAILABLE',status:503});
  response=await request(server,'/api/integrations',{headers});
  assert.equal(response.status,503);assert.deepEqual(JSON.parse(response.body),{error:'CONFIG_UNAVAILABLE'});
});

test('login rate limiting returns the shared throttle Retry-After delay',async t=>{
  const config={nodeEnv:'test',baseUrl:'http://127.0.0.1',tebar:{}};
  const repository={};
  const auth={
    login:async()=>{throw Object.assign(new Error('LOGIN_RATE_LIMITED'),{code:'LOGIN_RATE_LIMITED',status:429,retryAfterSeconds:43});},
    authenticate:async()=>null,
  };
  const server=http.createServer(createServer({config,repository,auth}));
  server.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});t.after(()=>closeServer(server));
  config.baseUrl=`http://127.0.0.1:${server.address().port}`;
  const response=await request(server,'/api/session/login',{method:'POST',headers:{origin:config.baseUrl},body:JSON.stringify({email:'admin@example.test',password:'wrong'})});
  assert.equal(response.status,429);
  assert.equal(response.headers['retry-after'],'43');
  assert.deepEqual(JSON.parse(response.body),{error:'LOGIN_RATE_LIMITED'});
});

test('settings and facts routes reject invalid data before persistence',async t=>{
  let writes=0;const config={nodeEnv:'test',baseUrl:'http://127.0.0.1',tebar:{}};const repo={saveSettings:async settings=>{writes++;return settings;},saveFact:async()=>{writes++;}};const auth={authenticate:async()=>({admin:{id:1},csrfToken:'c'.repeat(43)})};
  const app=createServer({config,repository:repo,auth});const server=require('node:http').createServer(app);const listening=new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});server.listen(0,'127.0.0.1');await listening;t.after(()=>closeServer(server));config.baseUrl=`http://127.0.0.1:${server.address().port}`;
  const headers={origin:config.baseUrl,cookie:'merzz_admin='+encodeURIComponent('x'.repeat(43)),'x-csrf-token':'c'.repeat(43)};
  const invalid=await request(server,'/api/settings',{method:'PUT',headers,body:JSON.stringify({schedule:{hours:0,minutes:0}})});assert.equal(invalid.status,400);
  const minute=await request(server,'/api/settings',{method:'PUT',headers,body:JSON.stringify({schedule:{hours:0,minutes:1}})});assert.equal(minute.status,200);assert.equal(JSON.parse(minute.body).schedule.intervalMinutes,1);
  const hourly=await request(server,'/api/settings',{method:'PUT',headers,body:JSON.stringify({schedule:{intervalHours:1}})});assert.equal(hourly.status,200);assert.equal(JSON.parse(hourly.body).schedule.intervalMinutes,60);
  const invalidHashtag=await request(server,'/api/settings',{method:'PUT',headers,body:JSON.stringify({hashtags:['#bad/tag']})});assert.equal(invalidHashtag.status,400);
  const hashtags=await request(server,'/api/settings',{method:'PUT',headers,body:JSON.stringify({hashtags:[' #Kedai Merzz ','##kedaimerzz']})});assert.equal(hashtags.status,200);assert.deepEqual(JSON.parse(hashtags.body).hashtags,['#KedaiMerzz']);
  const direction='  Utamakan soalan santai tentang pengalaman bermain bersama kawan.  ';
  const savedDirection=await request(server,'/api/settings',{method:'PUT',headers,body:JSON.stringify({brand:{contentDirection:direction}})});assert.equal(savedDirection.status,200);assert.equal(JSON.parse(savedDirection.body).brand.contentDirection,direction.trim());
  const invalidDirection=await request(server,'/api/settings',{method:'PUT',headers,body:JSON.stringify({brand:{contentDirection:'x'.repeat(7001)}})});assert.equal(invalidDirection.status,400);
  const price=await request(server,'/api/facts/topup',{method:'PUT',headers,body:JSON.stringify({active:true,summary:{game:'Mobile Legends',price:'30 juta'}})});assert.equal(price.status,400);assert.equal(writes,4);
  const invalidAttribute=await request(server,'/api/facts/account',{method:'PUT',headers,body:JSON.stringify({active:true,summary:{game:'Mobile Legends',attributes:['Mythic ✨']}})});assert.equal(invalidAttribute.status,400);assert.equal(writes,4);
  const invalidAttributeLength=await request(server,'/api/facts/account',{method:'PUT',headers,body:JSON.stringify({active:true,summary:{game:'Mobile Legends',attributes:['A'.repeat(101)]}})});assert.equal(invalidAttributeLength.status,400);assert.equal(writes,4);
  const tooManyAttributes=await request(server,'/api/facts/account',{method:'PUT',headers,body:JSON.stringify({active:true,summary:{game:'Mobile Legends',attributes:Array(21).fill('Rank Mythic')}})});assert.equal(tooManyAttributes.status,400);assert.equal(writes,4);
  const validAttribute=await request(server,'/api/facts/account',{method:'PUT',headers,body:JSON.stringify({active:true,summary:{game:'Mobile Legends',attributes:['Rank Mythic']}})});assert.equal(validAttribute.status,200);assert.equal(writes,5);
  const appSource=require('node:fs').readFileSync(require.resolve('../public/app.js'),'utf8');assert.match(appSource,/hashtags:\s*\(settings\.hashtags\s*\|\|\s*\[\]\)/);assert.match(appSource,/settings\.hashtags\s*=\s*lines\(value\(form,\s*'hashtags'\)\)/);assert.match(appSource,/contentDirection:\s*brand\.contentDirection/);assert.match(appSource,/contentDirection:\s*value\(form,\s*'contentDirection'\)/);assert.match(appSource,/hookVocabulary:\s*\(guardrails\.hookVocabulary\s*\|\|\s*\[\]\)/);assert.match(appSource,/hookVocabulary:\s*lines\(value\(form,\s*'hookVocabulary'\)\)/);assert.match(appSource,/hookVocabulary:\s*\(data\.hookVocabulary\s*\|\|\s*\[\]\)\.join/);assert.match(appSource,/hookVocabulary:\s*lines\(val\('hookVocabulary'\)\)/);assert.match(appSource,/const currentSchedule\s*=\s*\{\s*\.\.\.\(settings\.schedule\s*\|\|\s*\{\}\)\s*\}/);assert.match(appSource,/delete currentSchedule\.intervalMinutes/);assert.match(appSource,/settings\.schedule\s*=\s*\{\s*\.\.\.currentSchedule, hours:/);assert.match(appSource,/intervalMinutes\) && schedule\.intervalMinutes > 0/);assert.match(appSource,/const required = items\.filter\(\(item\)\s*=>\s*item\.required\)/);assert.match(appSource,/const completeRequired = required\.filter\(\(item\)\s*=>\s*item\.complete\)/);assert.match(appSource,/item\.required === false/);
});

test('automation enable requires scheduler and triggers an immediate durable dispatch',async t=>{
  const now=new Date();let enabledCalls=0;let dispatchCalls=0;
  const settings={brand:{name:'Kedai Merzz',voice:'Santai'}, hashtags:['#KedaiMerzz'], trackedLinks:{topup:'https://kedaimerzz.com/topup',account:'https://kedaimerzz.com/account'}};
  const repository={
    getRuntimeState:async()=>({settings,automationEnabled:false}),
    listFacts:async()=>({}),
    setAutomationEnabled:async(enabled)=>{enabledCalls++;assert.equal(enabled,true);return{changed:true,firstPostAt:now.toISOString(),immediate:true};},
  };
  const auth={authenticate:async()=>({admin:{id:8},csrfToken:'c'.repeat(43)})};
  const services={aiConfigured:true,getProviderStatus:async()=>({connected:true}),schedulerStatus:()=>({enabled:true}),triggerScheduler:async()=>{dispatchCalls++;return{claimed:1,published:1};}};
  const config={nodeEnv:'test',baseUrl:'http://127.0.0.1',tebar:{}};
  const app=createServer({config,repository,auth,services});const server=http.createServer(app);server.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});t.after(()=>closeServer(server));config.baseUrl=`http://127.0.0.1:${server.address().port}`;
  const headers={origin:config.baseUrl,cookie:`${require('../src/server').COOKIE}=${'x'.repeat(43)}`,'x-csrf-token':'c'.repeat(43)};
  const response=await request(server,'/api/automation/enable',{method:'POST',headers,body:'{}'});
  assert.equal(response.status,200,response.body);assert.equal(enabledCalls,1);assert.equal(dispatchCalls,1);
  assert.deepEqual(JSON.parse(response.body),{enabled:true,firstPostAt:now.toISOString(),immediate:true});
});

test('automation enable requires brand, hashtags, both links, Threads account, and AI',async t=>{
  const now=new Date();let settings={brand:{name:'Kedai Merzz',voice:'Santai'},hashtags:['#KedaiMerzz'],trackedLinks:{topup:'https://kedaimerzz.com/topup',account:'https://kedaimerzz.com/account'}};let connected=true;let aiConfigured=true;let writes=0;
  const repository={getRuntimeState:async()=>({settings,automationEnabled:false}),listFacts:async()=>({}),setAutomationEnabled:async()=>{writes++;return{changed:true,firstPostAt:now.toISOString(),immediate:true};}};
  const auth={authenticate:async()=>({admin:{id:8},csrfToken:'c'.repeat(43)})};
  const services={aiConfigured:true,getProviderStatus:async()=>({connected}),schedulerStatus:()=>({enabled:true}),triggerScheduler:async()=>{}};
  const config={nodeEnv:'test',baseUrl:'http://127.0.0.1',tebar:{}};
  const app=createServer({config,repository,auth,services});const server=http.createServer(app);server.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});t.after(()=>closeServer(server));config.baseUrl=`http://127.0.0.1:${server.address().port}`;
  const headers={origin:config.baseUrl,cookie:`${require('../src/server').COOKIE}=${'x'.repeat(43)}`,'x-csrf-token':'c'.repeat(43)};
  const activate=()=>request(server,'/api/automation/enable',{method:'POST',headers,body:'{}'});
  assert.equal((await activate()).status,200,'missing optional fields must not block activation');assert.equal(writes,1);
  const completeSettings=settings;
  settings={...completeSettings,hashtags:[]};assert.equal((await activate()).status,409,'hashtag is required');
  settings={...completeSettings,trackedLinks:{...completeSettings.trackedLinks,topup:''}};assert.equal((await activate()).status,409,'top-up link is required');
  settings={...completeSettings,trackedLinks:{...completeSettings.trackedLinks,account:''}};assert.equal((await activate()).status,409,'account link is required');
  settings={...completeSettings,brand:{name:'',voice:'Santai'}};assert.equal((await activate()).status,409,'brand name is required');
  settings={...completeSettings,brand:{name:'Kedai Merzz',voice:''}};assert.equal((await activate()).status,409,'brand communication style is required');
  settings=completeSettings;connected=false;assert.equal((await activate()).status,409,'Threads account must be connected');
  connected=true;services.aiConfigured=false;assert.equal((await activate()).status,409,'AI provider must be configured');
  assert.equal(writes,1,'failed required gates must not enable automation');
});

test('automation enable starts immediately even if the previous session posted under one hour ago',async t=>{
  const firstPostAt=new Date().toISOString();let dispatchCalls=0;
  const settings={schedule:{intervalHours:1},brand:{name:'Kedai Merzz',voice:'Santai'},gameWhitelist:['Mobile Legends'],hashtags:['#KedaiMerzz'],guardrails:{approved:true},trackedLinks:{topup:'https://kedaimerzz.com/topup',account:'https://kedaimerzz.com/account'}};
  const repository={getRuntimeState:async()=>({settings,automationEnabled:false}),listFacts:async()=>Object.fromEntries(['topup','account'].map(service=>[service,{active:true,updatedAt:new Date()}])),setAutomationEnabled:async()=>({changed:true,firstPostAt,immediate:true})};
  const auth={authenticate:async()=>({admin:{id:8},csrfToken:'c'.repeat(43)})};
  const config={nodeEnv:'test',baseUrl:'http://127.0.0.1',tebar:{}};
  const app=createServer({config,repository,auth,services:{aiConfigured:true,getProviderStatus:async()=>({connected:true}),schedulerStatus:()=>({enabled:true}),triggerScheduler:async()=>{dispatchCalls++;}}});const server=http.createServer(app);server.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});t.after(()=>closeServer(server));config.baseUrl=`http://127.0.0.1:${server.address().port}`;
  const headers={origin:config.baseUrl,cookie:`${require('../src/server').COOKIE}=${'x'.repeat(43)}`,'x-csrf-token':'c'.repeat(43)};
  const response=await request(server,'/api/automation/enable',{method:'POST',headers,body:'{}'});
  assert.equal(response.status,200,response.body);assert.equal(dispatchCalls,1);
  assert.deepEqual(JSON.parse(response.body),{enabled:true,firstPostAt,immediate:true});
});

test('automation enable is rejected when recurring scheduler is disabled',async t=>{
  let writes=0;
  const repository={getRuntimeState:async()=>({settings:{},automationEnabled:false}),setAutomationEnabled:async()=>{writes++;}};
  const auth={authenticate:async()=>({admin:{id:8},csrfToken:'c'.repeat(43)})};
  const config={nodeEnv:'test',baseUrl:'http://127.0.0.1',tebar:{}};
  const app=createServer({config,repository,auth,services:{schedulerStatus:()=>({enabled:false})}});const server=http.createServer(app);server.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});t.after(()=>closeServer(server));config.baseUrl=`http://127.0.0.1:${server.address().port}`;
  const headers={origin:config.baseUrl,cookie:`${require('../src/server').COOKIE}=${'x'.repeat(43)}`,'x-csrf-token':'c'.repeat(43)};
  const response=await request(server,'/api/automation/enable',{method:'POST',headers,body:'{}'});
  assert.equal(response.status,503);assert.equal(JSON.parse(response.body).error,'SCHEDULER_DISABLED');assert.equal(writes,0);
});

test('admin management requires authentication and CSRF, supports create/update, and blocks self-deactivation',async t=>{
  const admins=[{id:1,email:'one@example.test',active:true},{id:2,email:'two@example.test',active:true}];const calls=[];
  const config={nodeEnv:'test',baseUrl:'http://127.0.0.1',tebar:{}};
  const repository={listAdmins:async()=>admins,createAdmin:async input=>{calls.push(['create',input]);return{id:3,email:input.email,active:true};},updateAdmin:async(id,changes,actor)=>{calls.push(['update',id,changes,actor]);return{...admins.find(a=>a.id===id),...changes};}};
  const auth={authenticate:async()=>({admin:{id:1,email:'one@example.test'},csrfToken:'c'.repeat(43)}),createAdmin:async input=>{calls.push(['auth-create',input]);return{id:3,email:input.email,active:true};},updateAdmin:async(id,changes,actor)=>{calls.push(['auth-update',id,changes,actor]);return{ id,email:changes.email||'two@example.test',active:changes.active??true,credentialsChanged:changes.email!==undefined||changes.password!==undefined};}};
  const app=createServer({config,repository,auth});const server=http.createServer(app);server.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});t.after(()=>closeServer(server));config.baseUrl=`http://127.0.0.1:${server.address().port}`;
  const cookie=`${require('../src/server').COOKIE}=${'x'.repeat(43)}`;const base={cookie};
  assert.equal((await request(server,'/api/admins')).status,401);
  const list=await request(server,'/api/admins',{headers:base});assert.equal(list.status,200);assert.equal(JSON.parse(list.body).admins.length,2);
  const invalid=await request(server,'/api/admins',{method:'POST',headers:{...base,origin:config.baseUrl,'x-csrf-token':'c'.repeat(43)},body:JSON.stringify({email:'bad@example.test',password:'long enough password',active:false})});assert.equal(invalid.status,400);
  const noCsrf=await request(server,'/api/admins',{method:'POST',headers:{...base,origin:config.baseUrl},body:JSON.stringify({email:'new@example.test',password:'long enough password'})});assert.equal(noCsrf.status,403);
  const created=await request(server,'/api/admins',{method:'POST',headers:{...base,origin:config.baseUrl,'x-csrf-token':'c'.repeat(43)},body:JSON.stringify({email:'new@example.test',password:'long enough password'})});assert.equal(created.status,201);assert.equal(JSON.parse(created.body).admin.email,'new@example.test');
  const selfOff=await request(server,'/api/admins/1',{method:'PATCH',headers:{...base,origin:config.baseUrl,'x-csrf-token':'c'.repeat(43)},body:JSON.stringify({active:false})});assert.equal(selfOff.status,409);assert.equal(calls.length,1);
  const changed=await request(server,'/api/admins/2',{method:'PATCH',headers:{...base,origin:config.baseUrl,'x-csrf-token':'c'.repeat(43)},body:JSON.stringify({email:'changed@example.test',password:'long enough password'})});assert.equal(changed.status,200);assert.equal(JSON.parse(changed.body).sessionRevoked,false);
  const selfChanged=await request(server,'/api/admins/1',{method:'PATCH',headers:{...base,origin:config.baseUrl,'x-csrf-token':'c'.repeat(43)},body:JSON.stringify({email:'one-updated@example.test'})});assert.equal(selfChanged.status,200);assert.equal(JSON.parse(selfChanged.body).sessionRevoked,true);assert.match(selfChanged.headers['set-cookie'][0],/Max-Age=0/);
});

test('template API is authenticated, CSRF-protected, structured and rejects dynamic product facts',async t=>{
  const templates=[];const calls=[];const config={nodeEnv:'test',baseUrl:'http://127.0.0.1',tebar:{}};
  const repository={getSettings:async()=>({gameWhitelist:['Mobile Legends']}),listTemplates:async()=>templates,getTemplate:async id=>templates.find(item=>item.id===id)||null,createTemplate:async input=>{calls.push(['create',input]);const item={id:'37f739cf-ff95-4d64-8d5e-51086cda56a9',...input};templates.push(item);return item;},updateTemplate:async(id,patch)=>{calls.push(['update',id,patch]);const item=templates.find(entry=>entry.id===id);Object.assign(item,patch);return item;},deleteTemplate:async(id,actorId)=>{calls.push(['delete',id,actorId]);return templates.some(item=>item.id===id);}};
  const auth={authenticate:async()=>({admin:{id:7},csrfToken:'c'.repeat(43)})};
  const app=createServer({config,repository,auth});const server=http.createServer(app);server.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});t.after(()=>closeServer(server));config.baseUrl=`http://127.0.0.1:${server.address().port}`;
  const cookie=`${require('../src/server').COOKIE}=${'x'.repeat(43)}`;const headers={cookie,origin:config.baseUrl,'x-csrf-token':'c'.repeat(43)};
  assert.equal((await request(server,'/api/templates')).status,401);assert.equal((await request(server,'/api/templates',{headers:{cookie}})).status,200);
  const noCsrf=await request(server,'/api/templates',{method:'POST',headers:{cookie,origin:config.baseUrl},body:JSON.stringify({name:'ML Top-up',category:'topup',data:{game:'Mobile Legends'}})});assert.equal(noCsrf.status,403);
  const unknownGame=await request(server,'/api/templates',{method:'POST',headers,body:JSON.stringify({name:'Game Lain',category:'topup',data:{game:'PUBG Mobile',denomination:'400 diamonds'}})});assert.equal(unknownGame.status,400);assert.equal(JSON.parse(unknownGame.body).error,'GAME_NOT_WHITELISTED');
  const dynamicFact=await request(server,'/api/templates',{method:'POST',headers,body:JSON.stringify({name:'ML Top-up',category:'topup',data:{game:'Mobile Legends',denomination:'400 diamonds',price:'MYR 30'}})});assert.equal(dynamicFact.status,400);
  const created=await request(server,'/api/templates',{method:'POST',headers,body:JSON.stringify({name:'Gaya santai',category:'brand',data:{voice:'Ramah dan santai',guardrailsApproved:true}})});assert.equal(created.status,400);
  const valid=await request(server,'/api/templates',{method:'POST',headers,body:JSON.stringify({name:'Top-up ML',category:'topup',data:{game:'Mobile Legends',denomination:'400 diamonds'}})});assert.equal(valid.status,201);assert.deepEqual(calls[0][1].data,{game:'Mobile Legends',denomination:'400 diamonds'});
  const id=JSON.parse(valid.body).template.id;
  const changed=await request(server,`/api/templates/${id}`,{method:'PATCH',headers,body:JSON.stringify({name:'Top-up ML 400'})});assert.equal(changed.status,200);assert.equal(JSON.parse(changed.body).template.name,'Top-up ML 400');
  const deleted=await request(server,`/api/templates/${id}`,{method:'DELETE',headers});assert.equal(deleted.status,200,deleted.body);assert.equal(JSON.parse(deleted.body).deleted,true);
});

test('brand templates accept and preserve the bounded AI content direction',async t=>{
  const templates=[];const calls=[];const config={nodeEnv:'test',baseUrl:'http://127.0.0.1',tebar:{}};
  const repository={getSettings:async()=>({gameWhitelist:['Mobile Legends']}),createTemplate:async input=>{calls.push(input);const item={id:'37f739cf-ff95-4d64-8d5e-51086cda56a9',...input};templates.push(item);return item;}};
  const auth={authenticate:async()=>({admin:{id:7},csrfToken:'c'.repeat(43)})};
  const app=createServer({config,repository,auth});const server=http.createServer(app);server.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});t.after(()=>closeServer(server));config.baseUrl=`http://127.0.0.1:${server.address().port}`;
  const headers={cookie:`${require('../src/server').COOKIE}=${'x'.repeat(43)}`,origin:config.baseUrl,'x-csrf-token':'c'.repeat(43)};
  const direction='Ajukan soalan ringkas tentang pengalaman bermain.';
  const hookVocabulary=['Cerita pengalaman','Sembang santai'];
  const created=await request(server,'/api/templates',{method:'POST',headers,body:JSON.stringify({name:'Brief santai',category:'brand',data:{contentDirection:direction,hookVocabulary}})});
  assert.equal(created.status,201,created.body);assert.equal(calls[0].data.contentDirection,direction);assert.equal(JSON.parse(created.body).template.data.contentDirection,direction);assert.deepEqual(calls[0].data.hookVocabulary,hookVocabulary);
  const maxLength=await request(server,'/api/templates',{method:'POST',headers,body:JSON.stringify({name:'Brief maksimum',category:'brand',data:{contentDirection:'x'.repeat(7000)}})});
  assert.equal(maxLength.status,201,maxLength.body);
  const tooLong=await request(server,'/api/templates',{method:'POST',headers,body:JSON.stringify({name:'Brief panjang',category:'brand',data:{contentDirection:'x'.repeat(7001)}})});
  assert.equal(tooLong.status,400);
});

test('brand templates reject offsite CTA URLs and accept official subdomains',async t=>{
  const calls=[];let savedTemplate=null;const config={nodeEnv:'test',baseUrl:'http://127.0.0.1',tebar:{}};
  const repository={
    getSettings:async()=>({gameWhitelist:[]}),
    createTemplate:async input=>{calls.push(input);savedTemplate={id:'37f739cf-ff95-4d64-8d5e-51086cda56a9',...input};return savedTemplate;},
    getTemplate:async id=>savedTemplate?.id===id?savedTemplate:null,
    updateTemplate:async(_id,changes)=>{savedTemplate={...savedTemplate,...changes};return savedTemplate;},
  };
  const auth={authenticate:async()=>({admin:{id:7},csrfToken:'c'.repeat(43)})};
  const app=createServer({config,repository,auth});const server=http.createServer(app);server.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});t.after(()=>closeServer(server));config.baseUrl=`http://127.0.0.1:${server.address().port}`;
  const headers={cookie:`${require('../src/server').COOKIE}=${'x'.repeat(43)}`,origin:config.baseUrl,'x-csrf-token':'c'.repeat(43)};
  const rejected=await request(server,'/api/templates',{method:'POST',headers,body:JSON.stringify({name:'CTA luar',category:'brand',data:{trackedTopup:'https://kedaimerzz.com.evil.test/topup'}})});
  assert.equal(rejected.status,400);assert.equal(calls.length,0);
  const accepted=await request(server,'/api/templates',{method:'POST',headers,body:JSON.stringify({name:'CTA resmi',category:'brand',data:{trackedTopup:'https://shop.kedaimerzz.com/topup'}})});
  assert.equal(accepted.status,201,accepted.body);assert.equal(calls.length,1);assert.equal(calls[0].data.trackedTopup,'https://shop.kedaimerzz.com/topup');
  const id=JSON.parse(accepted.body).template.id;
  const unsafeUpdate=await request(server,`/api/templates/${id}`,{method:'PATCH',headers,body:JSON.stringify({data:{trackedTopup:'https://unrelated.test/topup'}})});
  assert.equal(unsafeUpdate.status,400);
});

test('readiness failure response remains minimal when dependencies are unavailable',async t=>{
  const config={nodeEnv:'test',baseUrl:'http://127.0.0.1',tebar:{}};
  const repository={healthCheck:async()=>{throw new Error('database unavailable');}};
  const app=createServer({config,repository,auth:{},services:{schedulerStatus:()=>({lastErrorCode:'INTERNAL_DETAIL'})}});
  const server=http.createServer(app);server.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});t.after(()=>closeServer(server));config.baseUrl=`http://127.0.0.1:${server.address().port}`;
  const response=await request(server,'/health/ready');
  assert.equal(response.status,503);assert.deepEqual(JSON.parse(response.body),{status:'not_ready'});
});

test('readiness requires the scheduler when configured without exposing scheduler details',async t=>{
  const config={nodeEnv:'test',baseUrl:'http://127.0.0.1',tebar:{},schedulerEnabled:true};
  const repository={healthCheck:async()=>{}};
  const services={schedulerStatus:()=>({enabled:false,lastErrorCode:'sensitive-detail'})};
  const server=http.createServer(createServer({config,repository,auth:{},services}));
  server.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});t.after(()=>closeServer(server));
  let response=await request(server,'/health/ready');
  assert.equal(response.status,503);assert.deepEqual(JSON.parse(response.body),{status:'not_ready'});
  services.schedulerStatus=()=>({enabled:true,lastErrorCode:'sensitive-detail'});
  response=await request(server,'/health/ready');
  assert.equal(response.status,200);assert.deepEqual(JSON.parse(response.body),{status:'ready'});
  services.schedulerStatus=()=>{throw new Error('sensitive-detail');};
  response=await request(server,'/health/ready');
  assert.equal(response.status,503);assert.deepEqual(JSON.parse(response.body),{status:'not_ready'});
  delete services.schedulerStatus;
  response=await request(server,'/health/ready');
  assert.equal(response.status,503);assert.deepEqual(JSON.parse(response.body),{status:'not_ready'});
  config.schedulerEnabled=false;
  response=await request(server,'/health/ready');
  assert.equal(response.status,200);assert.deepEqual(JSON.parse(response.body),{status:'ready'});
});
