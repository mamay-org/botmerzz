'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { verifyTebarSignature, handleTebarWebhook } = require('../src/webhook');

const secret = 'staging-webhook-secret';
const now = new Date('2026-11-05T04:00:00Z');
function signed(body, date = now) {
  const timestamp = Math.floor(date.getTime() / 1000);
  const signature = createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}
const body = Buffer.from(JSON.stringify({ id: 'evt-1', type: 'post.published', profile_id: 'profile-1', data: { post_id: 'post-1', status: 'published' } }));

test('signature validates exact timestamp-dot-raw-body HMAC', () => {
  assert.equal(verifyTebarSignature(body, signed(body), secret, now), true);
  assert.equal(verifyTebarSignature(Buffer.from(`${body} `), signed(body), secret, now), false);
});

test('signature rejects wrong secret, malformed header, stale, and future timestamps', () => {
  assert.equal(verifyTebarSignature(body, signed(body), 'wrong-secret', now), false);
  assert.equal(verifyTebarSignature(body, 'v1=abc,t=1', secret, now), false);
  const old = new Date(now.getTime() - 301000);
  assert.equal(verifyTebarSignature(body, signed(body, old), secret, now), false);
  const future = new Date(now.getTime() + 301000);
  assert.equal(verifyTebarSignature(body, signed(body, future), secret, now), false);
});

test('valid webhook is deduplicated via repository and only returns safe acknowledgment', async () => {
  const calls = [];
  const response = await handleTebarWebhook({ rawBody: body, signature: signed(body), secret, clock: () => now, accountId: 'acct-1', repository: { applyWebhookEvent: async (event) => { calls.push(event); return true; } } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { received: true, duplicate: false });
  assert.equal(calls[0].eventId, 'evt-1');
  assert.equal(calls[0].accountId, 'acct-1');
  assert.match(calls[0].payloadHash, /^[a-f0-9]{64}$/);
});

test('duplicate webhook returns acknowledgment without duplicate processing', async () => {
  const response = await handleTebarWebhook({ rawBody: body, signature: signed(body), secret, clock: () => now, repository: { applyWebhookEvent: async () => false } });
  assert.deepEqual(response, { status: 200, body: { received: true, duplicate: true } });
});

test('failed post webhook queues a safe notification code transactionally', async () => {
  const failedBody=Buffer.from(JSON.stringify({id:'evt-failed',type:'post.failed',profile_id:'profile-1',data:{post_id:'post-1',status:'failed'}}));
  let event;
  const response=await handleTebarWebhook({rawBody:failedBody,signature:signed(failedBody),secret,clock:()=>now,repository:{applyWebhookEvent:async(input)=>{event=input;return true;}}});
  assert.equal(response.notificationCode,'provider_error');
  assert.equal(event.notificationCode,'provider_error');
});

test('account expiry and disconnection events use the documented nested account object', async () => {
  for (const type of ['account.expired','account.disconnected']) {
    const eventBody=Buffer.from(JSON.stringify({id:`evt-${type.replace('.','-')}`,type,profile_id:'profile-1',data:{account:{id:'acct-1',platform:'threads',status:'expired'}}}));
    let event;
    const response=await handleTebarWebhook({rawBody:eventBody,signature:signed(eventBody),secret,clock:()=>now,accountId:'acct-1',repository:{applyWebhookEvent:async(input)=>{event=input;return true;}}});
    assert.equal(response.status,200);
    assert.equal(response.notificationCode,'account_disconnected');
    assert.equal(event.notificationCode,'account_disconnected');
  }
});

test('invalid signatures and malformed payloads never reach repository', async () => {
  let called = false;
  const repository = { applyWebhookEvent: async () => { called = true; } };
  assert.equal((await handleTebarWebhook({ rawBody: body, signature: 'bad', secret, clock: () => now, repository })).status, 401);
  const invalid = Buffer.from('{');
  assert.equal((await handleTebarWebhook({ rawBody: invalid, signature: signed(invalid), secret, clock: () => now, repository })).status, 400);
  assert.equal(called, false);
});

test('oversized body rejected before signature parsing', async () => {
  const huge = Buffer.alloc(256 * 1024 + 1);
  const response = await handleTebarWebhook({ rawBody: huge, signature: 'bad', secret, repository: {} });
  assert.equal(response.status, 413);
});
