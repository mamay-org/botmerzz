'use strict';

const { createHash, randomUUID } = require('node:crypto');

function createOutboxNotifier({ repository, transport } = {}) {
  if (!repository || !transport || typeof transport.send !== 'function') {
    throw new TypeError('repository and Telegram transport are required');
  }

  let activeFlush;
  async function flush(limit = 25) {
    if (activeFlush) return activeFlush;
    activeFlush = (async () => {
      const batch = await repository.claimNotifications(limit);
      let sent = 0;
      for (const notice of batch) {
        try {
          await transport.send(notice.message);
          await repository.markNotificationSent(notice.id);
          sent++;
        } catch (error) {
          const safeCode = /^[a-z][a-z0-9_]{1,63}$/.test(error?.code || '') ? error.code : 'delivery_failed';
          await repository.retryNotification(notice.id, safeCode);
        }
      }
      return { claimed: batch.length, sent };
    })();
    try { return await activeFlush; } finally { activeFlush = null; }
  }

  async function enqueue(message, dedupeId = randomUUID()) {
    if (typeof message !== 'string' || !message.trim() || message.length > 4096) {
      throw Object.assign(new Error('invalid_notification'), { code: 'invalid_notification' });
    }
    const dedupeKey = createHash('sha256').update(String(dedupeId)).digest('hex');
    await repository.enqueueNotification({ dedupeKey, message });
    return dedupeKey;
  }

  async function send(message, dedupeId) {
    const dedupeKey = await enqueue(message, dedupeId);
    await flush();
    if (await repository.getNotificationStatus(dedupeKey) !== 'sent') {
      throw Object.assign(new Error('notification_delivery_pending'), { code: 'notification_delivery_pending' });
    }
    return true;
  }

  return { send, enqueue, flush };
}

module.exports = { createOutboxNotifier };
