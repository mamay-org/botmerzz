const test = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword, hashToken, createAuth } = require('../src/auth');

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
  const auth=createAuth({repository:repo,clock:()=>new Date('2026-01-01T00:00:00Z')});
  const logged=await auth.login({email:'admin@example.test',password:'correct horse battery staple',ip:'127.0.0.1'});
  assert.notEqual(logged.token,session.tokenHash);assert.equal(session.tokenHash,hashToken(logged.token));
  assert.deepEqual(await auth.authenticate(logged.token),{admin:{id:1,email:'admin@example.test'},csrfToken:session.csrfToken});
  assert.equal(await auth.authenticate('short'),null);
});

test('login failures are generic and throttled per IP and email', async () => {
  let time=0; const repo={getAdminByEmail:async()=>null}; const auth=createAuth({repository:repo,clock:()=>new Date(time),maxFailures:2,windowMs:1000});
  for(let i=0;i<2;i++) await assert.rejects(auth.login({email:'nobody@example.test',password:'not the password',ip:'1.2.3.4'}),e=>e.code==='INVALID_CREDENTIALS');
  await assert.rejects(auth.login({email:'nobody@example.test',password:'not the password',ip:'1.2.3.4'}),e=>e.code==='LOGIN_RATE_LIMITED');
  time=2000; await assert.rejects(auth.login({email:'nobody@example.test',password:'not the password',ip:'1.2.3.4'}),e=>e.code==='INVALID_CREDENTIALS');
});

test('changing email addresses does not bypass the IP login limit', async () => {
  const auth=createAuth({repository:{getAdminByEmail:async()=>null},maxFailures:20,maxFailuresPerIp:2});
  for (const email of ['one@example.test','two@example.test']) {
    await assert.rejects(auth.login({email,password:'not the password',ip:'203.0.113.7'}),e=>e.code==='INVALID_CREDENTIALS');
  }
  await assert.rejects(auth.login({email:'three@example.test',password:'not the password',ip:'203.0.113.7'}),e=>e.code==='LOGIN_RATE_LIMITED');
});

test('only duplicate administrator failures become a conflict', async () => {
  const auth=createAuth({repository:{createAdmin:async()=>{throw new Error('database unavailable');}}});
  await assert.rejects(auth.createAdmin({email:'admin@example.test',password:'correct horse battery staple'}),/database unavailable/);
});
