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
  const staticPage=await request(server,'/');assert.equal(staticPage.status,200);assert.match(staticPage.body,/Panel Threads/);assert.equal(staticPage.headers['x-frame-options'],'DENY');
  assert.equal((await request(server,'/api/session/login',{method:'POST',headers:{origin:'https://evil.test'},body:'{}'})).status,403);
  const login=await request(server,'/api/session/login',{method:'POST',headers:{origin:config.baseUrl},body:JSON.stringify({email:'x',password:'y'})});assert.equal(login.status,200);token='a'.repeat(43);
  const cookie=login.headers['set-cookie'][0].split(';')[0];
  const dashboard=await request(server,'/api/dashboard',{headers:{cookie}});assert.equal(dashboard.status,200);assert.deepEqual(JSON.parse(dashboard.body).metrics.clicks,{available:true,value:12,reason:null});
  const badCsrf=await request(server,'/api/automation/pause',{method:'POST',headers:{origin:config.baseUrl,cookie,'x-csrf-token':'wrong'},body:'{}'});assert.equal(badCsrf.status,403);
  const goodCsrf=await request(server,'/api/automation/pause',{method:'POST',headers:{origin:config.baseUrl,cookie,'x-csrf-token':'b'.repeat(43)},body:'{}'});assert.equal(goodCsrf.status,200);
});

test('settings and facts routes reject invalid data before persistence',async t=>{
  let writes=0;const config={nodeEnv:'test',baseUrl:'http://127.0.0.1',tebar:{}};const repo={saveSettings:async()=>{writes++;},saveFact:async()=>{writes++;}};const auth={authenticate:async()=>({admin:{id:1},csrfToken:'c'.repeat(43)})};
  const app=createServer({config,repository:repo,auth});const server=require('node:http').createServer(app);const listening=new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});server.listen(0,'127.0.0.1');await listening;t.after(()=>closeServer(server));config.baseUrl=`http://127.0.0.1:${server.address().port}`;
  const headers={origin:config.baseUrl,cookie:'merzz_admin='+encodeURIComponent('x'.repeat(43)),'x-csrf-token':'c'.repeat(43)};
  const invalid=await request(server,'/api/settings',{method:'PUT',headers,body:JSON.stringify({schedule:{intervalHours:1}})});assert.equal(invalid.status,400);
  const price=await request(server,'/api/facts/topup',{method:'PUT',headers,body:JSON.stringify({active:true,summary:{game:'Mobile Legends',price:'30 juta'}})});assert.equal(price.status,400);assert.equal(writes,0);
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
