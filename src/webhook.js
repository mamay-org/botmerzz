'use strict';

const { createHmac, timingSafeEqual, createHash } = require('node:crypto');

const MAX_BODY_BYTES = 256 * 1024;
const MAX_AGE_SECONDS = 300;

function verifyTebarSignature(rawBody, header, secret, now = Date.now()) {
  if (!Buffer.isBuffer(rawBody) || rawBody.length > MAX_BODY_BYTES || typeof header !== 'string' || !secret) return false;
  const match = /^t=(\d{1,12}),v1=([a-f0-9]{64})$/i.exec(header.trim());
  if (!match) return false;
  const timestamp = Number(match[1]);
  const currentSeconds = Math.floor((now instanceof Date ? now.getTime() : Number(now)) / 1000);
  if (!Number.isSafeInteger(timestamp) || Math.abs(currentSeconds - timestamp) >= MAX_AGE_SECONDS) return false;
  const expected = createHmac('sha256', secret).update(String(timestamp)).update('.').update(rawBody).digest();
  const received = Buffer.from(match[2], 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function normalizeWebhookPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const eventId = typeof payload.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(payload.id) ? payload.id : null;
  const type = typeof payload.type === 'string' && /^[a-z][a-z0-9_.-]{1,63}$/i.test(payload.type) ? payload.type : null;
  const profileId = typeof payload.profile_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(payload.profile_id) ? payload.profile_id : null;
  const data = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data) ? payload.data : null;
  if (!eventId || !type || !profileId || !data) return null;
  return { eventId, type, profileId, data };
}

async function handleTebarWebhook({ rawBody, signature, secret, repository, clock = () => new Date(), accountId } = {}) {
  if (!Buffer.isBuffer(rawBody) || rawBody.length > MAX_BODY_BYTES) return { status: 413, body: { error: 'payload_too_large' } };
  const now = clock();
  if (!verifyTebarSignature(rawBody, signature, secret, now)) return { status: 401, body: { error: 'invalid_signature' } };
  let parsed;
  try { parsed = JSON.parse(rawBody.toString('utf8')); } catch { return { status: 400, body: { error: 'invalid_payload' } }; }
  const event = normalizeWebhookPayload(parsed);
  if (!event) return { status: 400, body: { error: 'invalid_payload' } };
  if (!repository || typeof repository.applyWebhookEvent !== 'function') return { status: 503, body: { error: 'temporarily_unavailable' } };
  const payloadHash = createHash('sha256').update(rawBody).digest('hex');
  const type=event.type.toLowerCase();
  const state=String(event.data.status||'').toLowerCase();
  const notificationCode=type.includes('account')&&(type.includes('expired')||type.includes('disconnected'))?'account_disconnected'
    :type.includes('post')&&(type.includes('failed')||type.includes('partial')||type.includes('canceled')||state==='failed'||state==='partial'||state==='canceled')?'provider_error'
      :type==='post.published'||(type.includes('post')&&state==='published')?'post_published':null;
  try {
    const applied = await repository.applyWebhookEvent({
      eventId: event.eventId,
      payloadHash,
      type: event.type,
      profileId: event.profileId,
      data: event.data,
      accountId,
      notificationCode,
    });
    return { status: 200, body: { received: true, duplicate: applied === false }, ...(applied!==false&&notificationCode ? { notificationCode } : {}) };
  } catch {
    return { status: 503, body: { error: 'temporarily_unavailable' } };
  }
}

module.exports = { verifyTebarSignature, normalizeWebhookPayload, handleTebarWebhook, MAX_BODY_BYTES, MAX_AGE_SECONDS };
