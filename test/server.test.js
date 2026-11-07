const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {createServer}=require('../src/server');

function request(server,path,{method='GET',headers={},body}={}){return new Promise((resolve,reject)=>{const address=server.address();const req=http.request({host:'127.0.0.1',port:address.port,path,method,headers:{...(body?{'content-type':'application/json'}:{}),...headers}},res=>{let data='';res.on('data',c=>data+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:data}));});req.setTimeout(3000,()=>req.destroy(new Error(`HTTP timeout ${method} ${path}`)));req.on('error',reject);if(body)req.write(body);req.end();});}
function closeServer(server){return new Promise(resolve=>{server.close(resolve);server.closeAllConnections?.();});}

test('health, dashboard auth, static UI, same-origin login and CSRF are enforced',async t=>{
  let token='';const config={nodeEnv:'test',baseUrl:'http://localhost',tebar:{}};
  const repository={healthCheck:async()=>{},getRuntimeState:async()=>({settings:{schedule:{},brand:{},guardrails:{}},facts:[],history:[],automationEnabled:false}),listFacts:async()=>({}),listSlots:async()=>[],listActivity:async()=>[],listAudit:async()=>[],saveSettings:async x=>x,saveKnowledge:async x=>x,saveFact:async()=>({}),setAutomationEnabled:async()=>{},};
  const auth={login:async()=>({token:'a'.repeat(43),csrfToken:'b'.repeat(43),expiresAt:new Date(Date.now()+3600000),admin:{id:1,email:'x@example.test'}}),authenticate:async value=>value===token?{admin:{id:1,email:'x@example.test'},csrfToken:'b'.repeat(43)}:null,logout:async()=>{token='';}};
  const app=createServer({config,repository,auth,services:{getProviderStatus:async()=>({connected:false}),getClickMetric:async()=>({available:true,value:12,reason:null})}});
  const server=require('node:http').createServer(app);const listening=new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});server.listen(0,'127.0.0.1');await listening;t.after(()=>closeServer(server));
  config.baseUrl=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await request(server,'/health/live')).status,200);assert.equal((await request(server,'/health/ready')).status,200);
  const malformedCookie=await request(server,'/api/session',{headers:{cookie:'merzz_admin=%E0%A4%A'}});assert.equal(malformedCookie.status,200);assert.deepEqual(JSON.parse(malformedCookie.body),{authenticated:false});
  assert.equal((await request(server,'/api/dashboard')).status,401);
  const staticPage=await request(server,'/');assert.equal(staticPage.status,200);assert.match(staticPage.body,/Panel Threads/);assert.equal(staticPage.headers['x-frame-options'],'DENY');assert.match(staticPage.body,/name="intervalHours"[^>]*min="1"/);assert.match(staticPage.body,/name="hashtags"/);assert.match(staticPage.body,/name="contentDirection"/);assert.match(staticPage.body,/Hook yang dibuat tetap harus memakai kosakata yang disetujui/);assert.match(staticPage.body,/Arahan yang memerlukan kata lain dapat ditolak/i);assert.doesNotMatch(staticPage.body,/id="active-days"|name="activeStart"|name="activeEnd"/);assert.match(staticPage.body,/22:00.*Malaysia/);
  assert.equal((await request(server,'/api/session/login',{method:'POST',headers:{origin:'https://evil.test'},body:'{}'})).status,403);
  const login=await request(server,'/api/session/login',{method:'POST',headers:{origin:config.baseUrl},body:JSON.stringify({email:'x',password:'y'})});assert.equal(login.status,200);token='a'.repeat(43);
  const cookie=login.headers['set-cookie'][0].split(';')[0];
  const dashboard=await request(server,'/api/dashboard',{headers:{cookie}});assert.equal(dashboard.status,200);assert.deepEqual(JSON.parse(dashboard.body).metrics.clicks,{available:true,value:12,reason:null});
  const badCsrf=await request(server,'/api/automation/pause',{method:'POST',headers:{origin:config.baseUrl,cookie,'x-csrf-token':'wrong'},body:'{}'});assert.equal(badCsrf.status,403);
  const goodCsrf=await request(server,'/api/automation/pause',{method:'POST',headers:{origin:config.baseUrl,cookie,'x-csrf-token':'b'.repeat(43)},body:'{}'});assert.equal(goodCsrf.status,200);
});

test('settings and facts routes reject invalid data before persistence',async t=>{
  let writes=0;const config={nodeEnv:'test',baseUrl:'http://127.0.0.1',tebar:{}};const repo={saveSettings:async settings=>{writes++;return settings;},saveFact:async()=>{writes++;}};const auth={authenticate:async()=>({admin:{id:1},csrfToken:'c'.repeat(43)})};
  const app=createServer({config,repository:repo,auth});const server=require('node:http').createServer(app);const listening=new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});server.listen(0,'127.0.0.1');await listening;t.after(()=>closeServer(server));config.baseUrl=`http://127.0.0.1:${server.address().port}`;
  const headers={origin:config.baseUrl,cookie:'merzz_admin='+encodeURIComponent('x'.repeat(43)),'x-csrf-token':'c'.repeat(43)};
  const invalid=await request(server,'/api/settings',{method:'PUT',headers,body:JSON.stringify({schedule:{intervalHours:0}})});assert.equal(invalid.status,400);
  const hourly=await request(server,'/api/settings',{method:'PUT',headers,body:JSON.stringify({schedule:{intervalHours:1}})});assert.equal(hourly.status,200);assert.equal(JSON.parse(hourly.body).schedule.intervalHours,1);
  const invalidHashtag=await request(server,'/api/settings',{method:'PUT',headers,body:JSON.stringify({hashtags:['#bad/tag']})});assert.equal(invalidHashtag.status,400);
  const hashtags=await request(server,'/api/settings',{method:'PUT',headers,body:JSON.stringify({hashtags:[' #Kedai Merzz ','##kedaimerzz']})});assert.equal(hashtags.status,200);assert.deepEqual(JSON.parse(hashtags.body).hashtags,['#KedaiMerzz']);
  const direction='  Utamakan soalan santai tentang pengalaman bermain bersama kawan.  ';
  const savedDirection=await request(server,'/api/settings',{method:'PUT',headers,body:JSON.stringify({brand:{contentDirection:direction}})});assert.equal(savedDirection.status,200);assert.equal(JSON.parse(savedDirection.body).brand.contentDirection,direction.trim());
  const invalidDirection=await request(server,'/api/settings',{method:'PUT',headers,body:JSON.stringify({brand:{contentDirection:'x'.repeat(2001)}})});assert.equal(invalidDirection.status,400);
  const price=await request(server,'/api/facts/topup',{method:'PUT',headers,body:JSON.stringify({active:true,summary:{game:'Mobile Legends',price:'30 juta'}})});assert.equal(price.status,400);assert.equal(writes,3);
  const invalidAttribute=await request(server,'/api/facts/account',{method:'PUT',headers,body:JSON.stringify({active:true,summary:{game:'Mobile Legends',attributes:['Mythic ✨']}})});assert.equal(invalidAttribute.status,400);assert.equal(writes,3);
  const invalidAttributeLength=await request(server,'/api/facts/account',{method:'PUT',headers,body:JSON.stringify({active:true,summary:{game:'Mobile Legends',attributes:['A'.repeat(101)]}})});assert.equal(invalidAttributeLength.status,400);assert.equal(writes,3);
  const tooManyAttributes=await request(server,'/api/facts/account',{method:'PUT',headers,body:JSON.stringify({active:true,summary:{game:'Mobile Legends',attributes:Array(21).fill('Rank Mythic')}})});assert.equal(tooManyAttributes.status,400);assert.equal(writes,3);
  const validAttribute=await request(server,'/api/facts/account',{method:'PUT',headers,body:JSON.stringify({active:true,summary:{game:'Mobile Legends',attributes:['Rank Mythic']}})});assert.equal(validAttribute.status,200);assert.equal(writes,4);
  const appSource=require('node:fs').readFileSync(require.resolve('../public/app.js'),'utf8');assert.match(appSource,/hashtags:\s*\(settings\.hashtags\s*\|\|\s*\[\]\)/);assert.match(appSource,/settings\.hashtags\s*=\s*lines\(value\(form,\s*'hashtags'\)\)/);assert.match(appSource,/contentDirection:\s*brand\.contentDirection/);assert.match(appSource,/contentDirection:\s*value\(form,\s*'contentDirection'\)/);
});

test('automation enable requires scheduler and triggers an immediate durable dispatch',async t=>{
  const now=new Date();let enabledCalls=0;let dispatchCalls=0;
  const settings={schedule:{intervalHours:1},brand:{name:'Kedai Merzz',voice:'Santai'},gameWhitelist:['Mobile Legends'],guardrails:{approved:true},trackedLinks:{topup:'https://example.test/topup',account:'https://example.test/account'}};
  const repository={
    getRuntimeState:async()=>({settings,automationEnabled:false}),
    listFacts:async()=>Object.fromEntries(['topup','account'].map(service=>[service,{active:true,updatedAt:now}])),
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

test('automation enable starts immediately even if the previous session posted under one hour ago',async t=>{
  const firstPostAt=new Date().toISOString();let dispatchCalls=0;
  const settings={schedule:{intervalHours:1},brand:{name:'Kedai Merzz',voice:'Santai'},gameWhitelist:['Mobile Legends'],guardrails:{approved:true},trackedLinks:{topup:'https://example.test/topup',account:'https://example.test/account'}};
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
  const created=await request(server,'/api/templates',{method:'POST',headers,body:JSON.stringify({name:'Brief santai',category:'brand',data:{contentDirection:direction}})});
  assert.equal(created.status,201,created.body);assert.equal(calls[0].data.contentDirection,direction);assert.equal(JSON.parse(created.body).template.data.contentDirection,direction);
  const tooLong=await request(server,'/api/templates',{method:'POST',headers,body:JSON.stringify({name:'Brief panjang',category:'brand',data:{contentDirection:'x'.repeat(2001)}})});
  assert.equal(tooLong.status,400);
});
