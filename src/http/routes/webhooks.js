'use strict';

const express = require('express');

function registerWebhookRoutes(app, { config, repository, services, webhookRateLimit }) {
  app.post('/webhooks/tebar', webhookRateLimit, express.raw({ type: 'application/json', limit: '256kb' }), async (req, res) => {
    if (!config.tebar?.webhookSecret) return res.status(404).json({ error: 'NOT_CONFIGURED' });
    try {
      const { handleTebarWebhook } = require('../../webhook');
      const result = await handleTebarWebhook({
        rawBody: req.body,
        signature: req.get('Tebar-Signature'),
        secret: config.tebar.webhookSecret,
        repository,
        accountId: config.tebar.accountId,
      });
      if (result.status < 300 && result.notificationCode && services.flushNotifications) {
        void services.flushNotifications().catch(() => {});
      }
      return res.status(result.status).json(result.body);
    } catch {
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
  });
}

module.exports = { registerWebhookRoutes };
