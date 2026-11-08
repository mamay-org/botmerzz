const test = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword, hashToken, createAuth } = require('../src/auth');

function addThrottleStore(repository, store = new Map()) {
  const keysFor = ({ email, ip }) => ({
    pair: `pair:${String(ip || 'unknown').slice(0, 64)}:${String(email || '').trim().toLowerCase()}`,
    account: `account:${String(email || '').trim().toLowerCase()}`,
    ip: `ip:${String(ip || 'unknown').slice(0, 64)}`,
  });
  repository.getLoginAttemptCounts = async ({ email, ip, now }) => {
    const counts = {};
    for (const [scope, key] of Object.entries(keysFor({ email, ip }))) {
      const item = store.get(key);
      counts[scope] = item?.expiresAt > now.getTime() ? item.count : 0;
    }
    return counts;
  };
  repository.reserveLoginAttempt = async ({ email, ip, now, windowMs, limits }) => {
    const keys = keysFor({ email, ip });
    const counts = {};
    for (const [scope, key] of Object.entries(keys)) {
      const item = store.get(key);
      counts[scope] = (item?.expiresAt > now.getTime() ? item.count : 0) + 1;
    }
    if (Object.entries(limits).some(([scope, limit]) => counts[scope] > limit)) return { allowed: false, counts };
    for (const [scope, key] of Object.entries(keys)) store.set(key, { scope, count: counts[scope], expiresAt: now.getTime() + windowMs });
    return { allowed: true, counts, reservation: { keys } };
  };
  repository.releaseLoginReservation = async ({ keys }) => {
    for (const key of Object.values(keys)) {
      const item = store.get(key);
      if (!item) continue;
      if (item.count <= 1) store.delete(key);
      else store.set(key, { ...item, count: item.count - 1 });
    }
  };
  return repository;
}

test('scrypt hashes passwords with random salts and verifies safely', async () => {
  const a = await hashPassword('correct horse battery staple');
  const b = await hashPassword('correct horse battery staple');
  assert.notEqual(a,b); assert.equal(await verifyPassword('correct horse battery staple',a),true); assert.equal(await verifyPassword('wrong password',a),false); assert.equal(await verifyPassword('x','bad'),false);
  await assert.rejects(hashPassword('short'),/INVALID_PASSWORD/);
});

test('sessions store only token hashes and authentication returns admin plus CSRF token', async () => {
  const db = new Map(); let session;
  const repo={createAdmin:async ({email,passwordHash})=>({id:1,email,passwordHash,active:true}),getAdminByEmail:async()=>({id:1,email:'admin@example.test',passwordHash:db.get('hash'),active:true}),createSession:async(s)=>{session=s;},getSession:async(hash)=>hash===session.tokenHash?{admin:{id:1,email:'admin@example.test'},csrfToken:session.csrfToken}:null,deleteSession:async()=>{},deleteAdminSessions:async()=>{}};
  db.set('hash',await hashPassword('correct horse battery staple'));
  addThrottleStore(repo);
  const auth=createAuth({repository:repo,clock:()=>new Date('2026-01-01T00:00:00Z')});
  const logged=await auth.login({email:'admin@example.test',password:'correct horse battery staple',ip:'127.0.0.1'});
  assert.notEqual(logged.token,session.tokenHash);assert.equal(session.tokenHash,hashToken(logged.token));
  assert.deepEqual(await auth.authenticate(logged.token),{admin:{id:1,email:'admin@example.test'},csrfToken:session.csrfToken});
  assert.equal(await auth.authenticate('short'),null);
});

test('login failures are generic and throttled per IP and email', async () => {
  let time=0; const repo=Object.assign({getAdminByEmail:async()=>null},{}); addThrottleStore(repo); const auth=createAuth({repository:repo,clock:()=>new Date(time),maxFailures:2,windowMs:1000});
  for(let i=0;i<2;i++) await assert.rejects(auth.login({email:'nobody@example.test',password:'not the password',ip:'1.2.3.4'}),e=>e.code==='INVALID_CREDENTIALS');
  await assert.rejects(auth.login({email:'nobody@example.test',password:'not the password',ip:'1.2.3.4'}),e=>e.code==='LOGIN_RATE_LIMITED');
  time=2000; await assert.rejects(auth.login({email:'nobody@example.test',password:'not the password',ip:'1.2.3.4'}),e=>e.code==='INVALID_CREDENTIALS');
});

test('changing email addresses does not bypass the IP login limit', async () => {
  const repo={getAdminByEmail:async()=>null}; addThrottleStore(repo); const auth=createAuth({repository:repo,maxFailures:20,maxFailuresPerAccount:20,maxFailuresPerIp:2});
  for (const email of ['one@example.test','two@example.test']) {
    await assert.rejects(auth.login({email,password:'not the password',ip:'203.0.113.7'}),e=>e.code==='INVALID_CREDENTIALS');
  }
  await assert.rejects(auth.login({email:'three@example.test',password:'not the password',ip:'203.0.113.7'}),e=>e.code==='LOGIN_RATE_LIMITED');
});

test('login throttling is shared across auth instances and normalized email/IP combinations', async () => {
  const sharedStore = new Map();
  const repository = addThrottleStore({getAdminByEmail:async()=>null}, sharedStore);
  const first = createAuth({repository,maxFailures:3,maxFailuresPerAccount:2,maxFailuresPerIp:20});
  const second = createAuth({repository,maxFailures:3,maxFailuresPerAccount:2,maxFailuresPerIp:20});
  await assert.rejects(first.login({email:'Admin@example.test',password:'not the password',ip:'203.0.113.1'}),e=>e.code==='INVALID_CREDENTIALS');
  await assert.rejects(second.login({email:'ADMIN@example.test',password:'not the password',ip:'203.0.113.2'}),e=>e.code==='INVALID_CREDENTIALS');
  await assert.rejects(first.login({email:'admin@example.test',password:'not the password',ip:'203.0.113.3'}),e=>e.code==='LOGIN_RATE_LIMITED');
});

test('overlong login email never resolves through a truncated valid account and keeps a distinct throttle identity', async () => {
  const password='correct horse battery staple';
  const passwordHash=await hashPassword(password);
  const validEmail=`${'a'.repeat(241)}@example.test`;
  const overlongEmail=`${validEmail}x`;
  assert.equal(validEmail.length,254);
  const lookups=[];
  const repository=addThrottleStore({
    getAdminByEmail:async email=>{lookups.push(email);return email===validEmail?{id:1,email:validEmail,passwordHash,active:true}:null;},
    createSession:async()=>{},
  });
  const auth=createAuth({repository});
  await assert.rejects(auth.login({email:overlongEmail,password,ip:'203.0.113.19'}),error=>error.code==='INVALID_CREDENTIALS');
  assert.deepEqual(lookups,[]);
  assert.deepEqual(await repository.getLoginAttemptCounts({email:overlongEmail,ip:'203.0.113.19',now:new Date()}),{pair:1,account:1,ip:1});
});

test('login throttle error carries the retry delay from the repository', async () => {
  const repository=addThrottleStore({getAdminByEmail:async()=>null});
  repository.reserveLoginAttempt=async()=>({allowed:false,retryAfterSeconds:43});
  const auth=createAuth({repository});
  await assert.rejects(auth.login({email:'admin@example.test',password:'not the password',ip:'203.0.113.1'}),error=>
    error.code==='LOGIN_RATE_LIMITED'&&error.status===429&&error.retryAfterSeconds===43);
});

test('atomic login reservations bound concurrent requests across auth instances', async () => {
  const repository=addThrottleStore({getAdminByEmail:async()=>null});
  const first=createAuth({repository,maxFailures:20,maxFailuresPerAccount:2,maxFailuresPerIp:20});
  const second=createAuth({repository,maxFailures:20,maxFailuresPerAccount:2,maxFailuresPerIp:20});
  const results=await Promise.allSettled([
    first.login({email:'admin@example.test',password:'guess one',ip:'203.0.113.1'}),
    second.login({email:'admin@example.test',password:'guess two',ip:'203.0.113.2'}),
    first.login({email:'admin@example.test',password:'guess three',ip:'203.0.113.3'}),
    second.login({email:'admin@example.test',password:'guess four',ip:'203.0.113.4'}),
  ]);
  assert.equal(results.filter(result=>result.reason?.code==='INVALID_CREDENTIALS').length,2);
  assert.equal(results.filter(result=>result.reason?.code==='LOGIN_RATE_LIMITED').length,2);
  assert.deepEqual(await repository.getLoginAttemptCounts({email:'admin@example.test',ip:'203.0.113.3',now:new Date()}),{pair:0,account:2,ip:0});
});

test('successful login releases only its reservation and preserves earlier failed counters', async () => {
  const passwordHash=await hashPassword('correct horse battery staple');
  const repository=addThrottleStore({getAdminByEmail:async()=>({id:1,email:'admin@example.test',passwordHash,active:true}),createSession:async()=>{}});
  const auth=createAuth({repository,maxFailures:5,maxFailuresPerAccount:5,maxFailuresPerIp:5});
  const ip='203.0.113.9';
  await assert.rejects(auth.login({email:'admin@example.test',password:'wrong password',ip}),error=>error.code==='INVALID_CREDENTIALS');
  assert.deepEqual(await repository.getLoginAttemptCounts({email:'admin@example.test',ip,now:new Date()}),{pair:1,account:1,ip:1});
  await auth.login({email:'admin@example.test',password:'correct horse battery staple',ip});
  assert.deepEqual(await repository.getLoginAttemptCounts({email:'admin@example.test',ip,now:new Date()}),{pair:1,account:1,ip:1});
});

test('login fails closed when shared throttle storage is unavailable', async () => {
  const repository=addThrottleStore({getAdminByEmail:async()=>null});
  repository.reserveLoginAttempt=async()=>{throw new Error('storage unavailable');};
  const auth=createAuth({repository});
  await assert.rejects(auth.login({email:'admin@example.test',password:'not the password',ip:'203.0.113.1'}),/storage unavailable/);
});

test('only duplicate administrator failures become a conflict', async () => {
  const auth=createAuth({repository:{createAdmin:async()=>{throw new Error('database unavailable');}}});
  await assert.rejects(auth.createAdmin({email:'admin@example.test',password:'correct horse battery staple'}),/database unavailable/);
});
