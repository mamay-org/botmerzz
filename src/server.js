const express = require('express');
const path = require('node:path');
const { validateSettings, isFactFresh, isSafeApprovedAttribute, MAX_APPROVED_ATTRIBUTE_COUNT } = require('./policy');
const { createIpRateLimiter } = require('./rate-limit');

const COOKIE = 'merzz_admin';
const PUBLIC_DIR = path.resolve(__dirname, '../public');
const templateCategories = new Set(['brand','topup','account']);

function templateText(value, max, { required = false } = {}) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) return null;
  return value.trim();
}

function templateList(value, { maxItems = 50, maxLength = 200 } = {}) {
  if (!Array.isArray(value) || value.length > maxItems || !value.every((entry) => typeof entry === 'string' && entry.length <= maxLength)) return null;
  return value.map((entry) => entry.trim()).filter(Boolean);
}

function normalizeTemplateData(category, data, whitelist) {
  if (!templateCategories.has(category) || !data || typeof data !== 'object' || Array.isArray(data)) return null;
  const schemas = {
    brand: ['brandName','voice','audienceNotes','contentDirection','gameWhitelist','trackedTopup','trackedAccount','forbiddenClaims','approvedClaims'],
    topup: ['game','denomination'],
    account: ['attributes'],
  };
  if (Object.keys(data).some((key) => !schemas[category].includes(key))) return null;
  const result = {};
  const addText = (key, max, required = false) => {
    if (data[key] === undefined) return true;
    const value = templateText(data[key], max, { required });
    if (value === null) return false;
    result[key] = value;
    return true;
  };
  if (category === 'brand') {
    for (const [key,max] of [['brandName',120],['voice',500],['audienceNotes',2000],['contentDirection',2000],['trackedTopup',300],['trackedAccount',300]]) if (!addText(key,max)) return null;
    for (const key of ['trackedTopup','trackedAccount']) if (result[key]) {
      try { const url = new URL(result[key]); if (!['http:','https:'].includes(url.protocol) || url.username || url.password) return null; } catch { return null; }
    }
    for (const [key,options] of [['gameWhitelist',{maxItems:50,maxLength:80}],['forbiddenClaims',{maxItems:40,maxLength:200}],['approvedClaims',{maxItems:40,maxLength:200}]]) {
      if (data[key] === undefined) continue;
      result[key] = templateList(data[key], options);
      if (!result[key]) return null;
    }
    if (result.gameWhitelist?.some((game) => !whitelist.includes(game))) return { error:'GAME_NOT_WHITELISTED' };
  } else if (category === 'topup') {
    if (!addText('game',80,true) || !addText('denomination',120)) return null;
    if (!whitelist.includes(result.game)) return { error:'GAME_NOT_WHITELISTED' };
  } else {
    if (data.attributes !== undefined) {
      result.attributes = templateList(data.attributes, { maxItems:20,maxLength:100 });
      if (!result.attributes) return null;
    }
  }
  return result;
}

function normalizeTemplateName(value) { return templateText(value,80,{required:true}); }

function createServer({ config, repository, auth, services = {} }) {
  if (!config || !repository || !auth) throw new TypeError('config, repository, and auth are required');
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy === true ? 1 : false);
  const webhookRateLimit = createIpRateLimiter({ limit: 120, windowMs: 60_000 });
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" });
    if (config.nodeEnv === 'production') res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });
  app.post('/webhooks/tebar', webhookRateLimit, express.raw({ type: 'application/json', limit: '256kb' }), async (req, res) => {
    if (!config.tebar?.webhookSecret) return res.status(404).json({ error: 'NOT_CONFIGURED' });
    try {
      const { handleTebarWebhook } = require('./webhook');
      const result = await handleTebarWebhook({ rawBody: req.body, signature: req.get('Tebar-Signature'), secret: config.tebar.webhookSecret, repository, accountId: config.tebar.accountId });
      if (result.status < 300 && result.notificationCode && services.flushNotifications) void services.flushNotifications().catch(() => {});
      return res.status(result.status).json(result.body);
    } catch { return res.status(503).json({ error: 'temporarily_unavailable' }); }
  });
  app.use(express.json({ limit: '32kb', strict: true }));
  const cookies = (req) => {
    const result = {};
    for (const piece of (req.headers.cookie || '').split(';')) {
      const [key, value] = piece.trim().split(/=(.*)/s).slice(0, 2);
      if (!key || value === undefined) continue;
      try { result[key] = decodeURIComponent(value); } catch { /* Malformed cookies are treated as absent. */ }
    }
    return result;
  };
  const setCookie = (res, token, maxAge) => res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.nodeEnv === 'production' ? '; Secure' : ''}`);
  const clearCookie = (res) => res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${config.nodeEnv === 'production' ? '; Secure' : ''}`);
  const sameOrigin = (req) => {
    const origin = req.get('origin');
    if (!origin) return config.nodeEnv !== 'production' && ['localhost', '127.0.0.1'].includes(req.hostname);
    try { return new URL(origin).origin === config.baseUrl; } catch { return false; }
  };
  async function session(req) { const token = cookies(req)[COOKIE]; return token ? auth.authenticate(token) : null; }
  async function authenticated(req, res, next) {
    try { const found = await session(req); if (!found) return res.status(401).json({ error: 'AUTH_REQUIRED' }); req.admin = found.admin; req.session = found; return next(); }
    catch { return res.status(401).json({ error: 'AUTH_REQUIRED' }); }
  }
  function mutation(req, res, next) {
    if (!sameOrigin(req)) return res.status(403).json({ error: 'ORIGIN_REJECTED' });
    const token = req.get('x-csrf-token');
    if (!req.session || typeof token !== 'string' || token.length !== req.session.csrfToken.length || !require('node:crypto').timingSafeEqual(Buffer.from(token), Buffer.from(req.session.csrfToken))) return res.status(403).json({ error: 'CSRF_REJECTED' });
    return next();
  }
  app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
  app.get('/health/ready', async (_req, res) => {
    try {
      if (services.pool) await services.pool.query('SELECT 1');
      else if (repository.healthCheck) await repository.healthCheck();
      else await repository.getSettings();
      const scheduler = typeof services.schedulerStatus === 'function' ? services.schedulerStatus() : undefined;
      return res.json({ status: 'ready', ...(scheduler ? { scheduler } : {}) });
    }
    catch { return res.status(503).json({ status: 'not_ready' }); }
  });
  app.get('/api/session', async (req, res) => { const found = await session(req); return res.json(found ? { authenticated: true, csrfToken: found.csrfToken, admin: found.admin } : { authenticated: false }); });
  app.post('/api/session/login', async (req, res, next) => {
    if (!sameOrigin(req)) return res.status(403).json({ error: 'ORIGIN_REJECTED' });
    try {
      const result = await auth.login({ email: req.body?.email, password: req.body?.password, ip: req.ip });
      setCookie(res, result.token, Math.max(0, Math.floor((new Date(result.expiresAt) - Date.now()) / 1000)));
      return res.json({ authenticated: true, csrfToken: result.csrfToken, admin: result.admin });
    } catch (error) { return next(error); }
  });
  app.post('/api/session/logout', authenticated, mutation, async (req, res) => { await auth.logout(cookies(req)[COOKIE]); clearCookie(res); return res.json({ ok: true }); });
  app.get('/api/admins', authenticated, async (_req, res, next) => {
    try { return res.json({ admins: await repository.listAdmins() }); } catch (error) { return next(error); }
  });
  app.post('/api/admins', authenticated, mutation, async (req, res, next) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).some((key) => !['email','password'].includes(key))) return res.status(400).json({ error: 'INVALID_ADMIN' });
    try {
      const admin = await auth.createAdmin({ email: req.body?.email, password: req.body?.password, actorId: req.admin.id });
      return res.status(201).json({ admin: { id: Number(admin.id), email: admin.email, active: true, createdAt: admin.createdAt || null } });
    } catch (error) { return next(error); }
  });
  app.patch('/api/admins/:id', authenticated, mutation, async (req, res, next) => {
    const id = Number(req.params.id); const body = req.body || {};
    if (!Number.isSafeInteger(id) || id < 1 || !body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !['email','password','active'].includes(key))) return res.status(400).json({ error: 'INVALID_ADMIN' });
    try {
      if (id === Number(req.admin.id) && body.active === false) return res.status(409).json({ error: 'CANNOT_DEACTIVATE_SELF' });
      const admin = await auth.updateAdmin(id, body, req.admin.id);
      if (!admin) return res.status(404).json({ error: 'ADMIN_NOT_FOUND' });
      const sessionRevoked = id === Number(req.admin.id) && admin.credentialsChanged === true;
      const { credentialsChanged, ...safeAdmin } = admin;
      if (sessionRevoked) { clearCookie(res); return res.json({ admin: safeAdmin, sessionRevoked: true }); }
      return res.json({ admin: safeAdmin, sessionRevoked: false });
    } catch (error) { return next(error); }
  });
  app.get('/api/templates', authenticated, async (_req, res, next) => {
    try { return res.json({ templates: await repository.listTemplates() }); } catch (error) { return next(error); }
  });
  app.post('/api/templates', authenticated, mutation, async (req, res, next) => {
    const body = req.body || {};
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !['name','category','data'].includes(key))) return res.status(400).json({ error:'INVALID_TEMPLATE' });
    const name = normalizeTemplateName(body.name);
    const category = body.category;
    if (!name || !templateCategories.has(category)) return res.status(400).json({ error:'INVALID_TEMPLATE' });
    try {
      const settings = await repository.getSettings();
      const data = normalizeTemplateData(category, body.data, settings.gameWhitelist || []);
      if (!data || data.error) return res.status(400).json({ error:data?.error || 'INVALID_TEMPLATE_DATA' });
      const template = await repository.createTemplate({ name, category, data, actorId:req.admin.id });
      return res.status(201).json({ template });
    } catch (error) {
      if (error.code === 'TEMPLATE_EXISTS') return res.status(409).json({ error:'TEMPLATE_EXISTS' });
      return next(error);
    }
  });
  app.patch('/api/templates/:id', authenticated, mutation, async (req, res, next) => {
    const id = req.params.id; const body = req.body || {};
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) || !body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !['name','data'].includes(key)) || !Object.keys(body).length) return res.status(400).json({ error:'INVALID_TEMPLATE' });
    try {
      const existing = await repository.getTemplate(id);
      if (!existing) return res.status(404).json({ error:'TEMPLATE_NOT_FOUND' });
      const name = body.name === undefined ? existing.name : normalizeTemplateName(body.name);
      if (!name) return res.status(400).json({ error:'INVALID_TEMPLATE' });
      let data;
      if (body.data !== undefined) {
        const settings = await repository.getSettings();
        data = normalizeTemplateData(existing.category, body.data, settings.gameWhitelist || []);
        if (!data || data.error) return res.status(400).json({ error:data?.error || 'INVALID_TEMPLATE_DATA' });
      }
      const template = await repository.updateTemplate(id, { name, data, actorId:req.admin.id });
      if (!template) return res.status(404).json({ error:'TEMPLATE_NOT_FOUND' });
      return res.json({ template });
    } catch (error) {
      if (error.code === 'TEMPLATE_EXISTS') return res.status(409).json({ error:'TEMPLATE_EXISTS' });
      return next(error);
    }
  });
  app.delete('/api/templates/:id', authenticated, mutation, async (req, res, next) => {
    const id = req.params.id;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return res.status(400).json({ error:'INVALID_TEMPLATE' });
    try {
      if (!await repository.deleteTemplate(id, req.admin.id)) return res.status(404).json({ error:'TEMPLATE_NOT_FOUND' });
      return res.json({ deleted:true });
    } catch (error) { return next(error); }
  });
  app.get('/api/dashboard', authenticated, async (_req, res, next) => {
    try {
      const [state, facts, posts, activity, audit] = await Promise.all([repository.getRuntimeState(), repository.listFacts(), repository.listSlots(100), repository.listActivity(100), repository.listAudit(100)]);
      const [provider, clicks] = await Promise.all([
        services.getProviderStatus
          ? Promise.resolve().then(() => services.getProviderStatus()).catch(() => ({ connected: false, status: 'provider_unavailable' }))
          : { connected: false, status: 'not_configured' },
        services.getClickMetric
          ? Promise.resolve().then(() => services.getClickMetric(state)).catch(() => ({ available: false, value: null, reason: 'provider_unavailable' }))
          : { available: false, value: null, reason: 'not_configured' },
      ]);
      const now = new Date();
      const items = [
        { key: 'brand', label: 'Suara jenama dan panduan kandungan', complete: Boolean(state.settings?.brand?.name && state.settings?.brand?.voice) },
        { key: 'games', label: 'Whitelist game top-up', complete: Array.isArray(state.settings?.gameWhitelist) && state.settings.gameWhitelist.length > 0 },
        { key: 'guardrails', label: 'Guardrail diluluskan klien', complete: state.settings?.guardrails?.approved === true },
        { key: 'links', label: 'Tautan homepage tracked', complete: Boolean(state.settings?.trackedLinks?.topup && state.settings?.trackedLinks?.account) },
        { key: 'facts', label: 'Ringkasan top-up dan akaun disemak', complete: ['topup', 'account'].every((key) => facts[key] && isFactFresh(facts[key], now)) },
        { key: 'thread', label: 'Akaun Threads staging aktif di Tebar', complete: provider.connected === true },
        { key: 'ai', label: 'Penyedia AI dikonfigurasi', complete: services.aiConfigured === true },
      ];
      const freshFacts = ['topup', 'account'].filter((key) => facts[key] && isFactFresh(facts[key], now)).length;
      const metrics = { success30d: posts.filter((p) => p.status === 'published' && new Date(p.completedAt || p.createdAt) > new Date(Date.now() - 30 * 86400000)).length, attention: posts.filter((p) => ['failed', 'unknown'].includes(p.status)).length, freshFacts, clicks };
      return res.json({ settings: state.settings || {}, facts, posts, activity: [...activity, ...audit].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 100), provider, automation: { enabled: state.automationEnabled === true }, onboarding: items, metrics });
    } catch (error) { return next(error); }
  });
  app.put('/api/settings', authenticated, mutation, async (req, res, next) => {
    const checked = validateSettings(req.body);
    if (!checked.valid) return res.status(400).json({ error: 'INVALID_SETTINGS', fields: checked.errors });
    try { const saved = await repository.saveSettings(checked.settings, req.admin.id); return res.json(saved); } catch (error) { return next(error); }
  });
  app.put('/api/knowledge', authenticated, mutation, async (req, res, next) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || JSON.stringify(req.body).length > 10000) return res.status(400).json({ error: 'INVALID_KNOWLEDGE' });
    const checked = validateSettings({ brand: req.body.brand, guardrails: req.body.guardrails });
    if (!checked.valid) return res.status(400).json({ error: 'INVALID_KNOWLEDGE', fields: checked.errors });
    const knowledge = { brand: checked.settings.brand, guardrails: checked.settings.guardrails };
    try { return res.json(await repository.saveKnowledge(knowledge, req.admin.id)); } catch (error) { return next(error); }
  });
  app.put('/api/facts/:service', authenticated, mutation, async (req, res, next) => {
    const { service } = req.params; const { summary, active } = req.body || {};
    if (!['topup', 'account'].includes(service) || !summary || typeof summary !== 'object' || Array.isArray(summary) || typeof active !== 'boolean' || JSON.stringify(summary).length > 4000) return res.status(400).json({ error: 'INVALID_FACT' });
    if (summary.price !== undefined && summary.price !== '' && !/^\d{1,8}(?:\.\d{1,2})?$/.test(String(summary.price))) return res.status(400).json({ error: 'INVALID_FACT_PRICE' });
    const allowed = service === 'topup' ? ['game','denomination','price','availability'] : ['game','price','availability','attributes'];
    if (Object.keys(summary).some((key) => !allowed.includes(key)) || (service === 'account' && summary.game && summary.game !== 'Mobile Legends')) return res.status(400).json({ error: 'INVALID_FACT_FIELDS' });
    if (service === 'topup') {
      const settings = await repository.getSettings();
      if (typeof summary.game !== 'string' || !settings.gameWhitelist?.includes(summary.game)) return res.status(400).json({ error: 'GAME_NOT_WHITELISTED' });
    }
    for (const [key, value] of Object.entries(summary)) {
      const valid = key === 'attributes'
        ? Array.isArray(value) && value.length <= MAX_APPROVED_ATTRIBUTE_COUNT && value.every(isSafeApprovedAttribute)
        : typeof value === 'string' && value.length <= 200;
      if (!valid) return res.status(400).json({ error: 'INVALID_FACT_FIELDS' });
    }
    try { return res.json(await repository.saveFact(service, { summary, active }, req.admin.id)); } catch (error) { return next(error); }
  });
  app.post('/api/automation/enable', authenticated, mutation, async (req, res, next) => {
    try {
      if (services.schedulerStatus?.().enabled !== true || typeof services.triggerScheduler !== 'function') return res.status(503).json({ error: 'SCHEDULER_DISABLED' });
      const state = await repository.getRuntimeState();
      const settings = validateSettings(state.settings || {});
      const facts = await repository.listFacts();
      const provider = services.getProviderStatus ? await services.getProviderStatus() : { connected: false };
      const complete = settings.valid && Boolean(settings.settings.brand.name && settings.settings.brand.voice)
        && settings.settings.guardrails.approved && settings.settings.gameWhitelist.length > 0
        && settings.settings.trackedLinks.topup && settings.settings.trackedLinks.account
        && ['topup','account'].every((key) => facts[key] && isFactFresh(facts[key], new Date()))
        && provider.connected === true && services.aiConfigured === true;
      if (!complete) return res.status(409).json({ error: 'ONBOARDING_INCOMPLETE' });
      const activation = await repository.setAutomationEnabled(true, req.admin.id);
      if (activation.changed) {
        try {
          Promise.resolve(services.triggerScheduler()).catch((error) => {
            const code = typeof error?.code === 'string' && /^[a-z][a-z0-9_]{1,63}$/.test(error.code) ? error.code : 'scheduler_trigger_failed';
            services.logger?.error?.('scheduler.trigger_failed', { code });
          });
        } catch (error) {
          const code = typeof error?.code === 'string' && /^[a-z][a-z0-9_]{1,63}$/.test(error.code) ? error.code : 'scheduler_trigger_failed';
          services.logger?.error?.('scheduler.trigger_failed', { code });
        }
      }
      return res.json({ enabled: true, firstPostAt: activation.firstPostAt, immediate: activation.immediate });
    } catch (error) { return next(error); }
  });
  app.post('/api/automation/pause', authenticated, mutation, async (req, res, next) => {
    try {
      const result = services.pauseAutomation ? await services.pauseAutomation({ adminId: req.admin.id }) : (await repository.setAutomationEnabled(false, req.admin.id), { outcomes: [] });
      const outcomes = result?.outcomes || [];
      const canceled = outcomes.filter((entry) => entry.status === 'canceled').length;
      const attention = outcomes.filter((entry) => entry.status !== 'canceled').length;
      return res.json({ enabled: false, outcomes, message: `Automasi dijeda. Pembatalan berjaya: ${canceled}; perlu semakan: ${attention}.` });
    } catch (error) { return next(error); }
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
  app.use(express.static(PUBLIC_DIR, { index: 'index.html', etag: true, maxAge: config.nodeEnv === 'production' ? '1h' : 0 }));
  app.get('*path', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
  app.use(async (error, _req, res, _next) => {
    if (res.headersSent) return;
    const status = Number.isInteger(error.status) ? error.status : 500;
    const code = error.code && /^[A-Z0-9_]{2,64}$/.test(error.code) ? error.code : status >= 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST';
    if (status >= 500 && services.logger?.error) services.logger.error('request.failed', { code });
    if (status >= 500 && services.notify) { try { await services.notify('system_error'); } catch { /* The outbox preserves retryable notification failures. */ } }
    return res.status(status).json({ error: code });
  });
  return app;
}

module.exports = { createServer, COOKIE };
