'use strict';

const express = require('express');
const path = require('node:path');
const { createIpRateLimiter } = require('./rate-limit');
const { createHttpMiddleware, COOKIE } = require('./http/middleware');
const { registerSessionAdminRoutes } = require('./http/routes/session-admin');
const { registerTemplateRoutes } = require('./http/routes/templates');
const { registerDashboardRoutes } = require('./http/routes/dashboard');
const { registerAutomationRoutes } = require('./http/routes/automation');
const { registerWebhookRoutes } = require('./http/routes/webhooks');

const PUBLIC_DIR = path.resolve(__dirname, '../public');

function createServer({ config, repository, auth, services = {} }) {
  if (!config || !repository || !auth) throw new TypeError('config, repository, and auth are required');
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy === true ? 1 : false);
  const webhookRateLimit = createIpRateLimiter({ limit: 120, windowMs: 60_000 });

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    });
    if (config.nodeEnv === 'production') res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });

  // Tebar signs the raw request body, so this route must be registered before JSON parsing.
  registerWebhookRoutes(app, { config, repository, services, webhookRateLimit });
  app.use(express.json({ limit: '256kb', strict: true }));

  const middleware = createHttpMiddleware({ config, auth });
  app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
  app.get('/health/ready', async (_req, res) => {
    try {
      if (services.pool) await services.pool.query('SELECT 1');
      else if (repository.healthCheck) await repository.healthCheck();
      else await repository.getSettings();
      const scheduler = typeof services.schedulerStatus === 'function' ? services.schedulerStatus() : undefined;
      return res.json({ status: 'ready', ...(scheduler ? { scheduler } : {}) });
    } catch {
      return res.status(503).json({ status: 'not_ready' });
    }
  });

  registerSessionAdminRoutes(app, { repository, auth, middleware });
  registerTemplateRoutes(app, {
    repository,
    authenticated: middleware.authenticated,
    mutation: middleware.mutation,
  });
  registerDashboardRoutes(app, {
    repository,
    services,
    authenticated: middleware.authenticated,
    mutation: middleware.mutation,
  });
  registerAutomationRoutes(app, {
    repository,
    services,
    authenticated: middleware.authenticated,
    mutation: middleware.mutation,
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
  app.use(express.static(PUBLIC_DIR, { index: 'index.html', etag: true, maxAge: config.nodeEnv === 'production' ? '1h' : 0 }));
  app.get('*path', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
  app.use(async (error, _req, res, _next) => {
    if (res.headersSent) return;
    const status = Number.isInteger(error.status) ? error.status : 500;
    const code = error.code && /^[A-Z0-9_]{2,64}$/.test(error.code) ? error.code : status >= 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST';
    if (status >= 500 && services.logger?.error) services.logger.error('request.failed', { code });
    if (status >= 500 && services.notify) {
      try { await services.notify('system_error'); } catch { /* The outbox preserves retryable notification failures. */ }
    }
    return res.status(status).json({ error: code });
  });
  return app;
}

module.exports = { createServer, COOKIE };
