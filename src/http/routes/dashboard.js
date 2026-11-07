'use strict';

const { validateSettings, isFactFresh, isSafeApprovedAttribute, MAX_APPROVED_ATTRIBUTE_COUNT } = require('../../policy');

function registerDashboardRoutes(app, { repository, services, authenticated, mutation }) {
  app.get('/api/dashboard', authenticated, async (_req, res, next) => {
    try {
      const [state, facts, posts, activity, audit] = await Promise.all([
        repository.getRuntimeState(),
        repository.listFacts(),
        repository.listSlots(100),
        repository.listActivity(100),
        repository.listAudit(100),
      ]);
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
        { key: 'brand', label: 'Nama dan gaya komunikasi brand', required: true, complete: Boolean(state.settings?.brand?.name && state.settings?.brand?.voice) },
        { key: 'games', label: 'Whitelist game top-up', required: false, complete: Array.isArray(state.settings?.gameWhitelist) && state.settings.gameWhitelist.length > 0 },
        { key: 'guardrails', label: 'Guardrail diluluskan klien', required: false, complete: state.settings?.guardrails?.approved === true },
        { key: 'links', label: 'Tautan homepage tracked', required: false, complete: Boolean(state.settings?.trackedLinks?.topup && state.settings?.trackedLinks?.account) },
        { key: 'facts', label: 'Ringkasan top-up dan akaun disemak', required: false, complete: ['topup', 'account'].every((key) => facts[key] && isFactFresh(facts[key], now)) },
        { key: 'thread', label: 'Akaun Threads testing aktif di Tebar', required: true, complete: provider.connected === true },
        { key: 'ai', label: 'Penyedia AI dikonfigurasi', required: true, complete: services.aiConfigured === true },
      ];
      const freshFacts = ['topup', 'account'].filter((key) => facts[key] && isFactFresh(facts[key], now)).length;
      const metrics = {
        success30d: posts.filter((post) => post.status === 'published'
          && new Date(post.completedAt || post.createdAt) > new Date(Date.now() - 30 * 86400000)).length,
        attention: posts.filter((post) => ['failed', 'unknown'].includes(post.status)).length,
        freshFacts,
        clicks,
      };
      const recentActivity = [...activity, ...audit]
        .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))
        .slice(0, 100);
      return res.json({
        settings: state.settings || {},
        facts,
        posts,
        activity: recentActivity,
        provider,
        automation: { enabled: state.automationEnabled === true },
        onboarding: items,
        metrics,
      });
    } catch (error) {
      return next(error);
    }
  });

  app.put('/api/settings', authenticated, mutation, async (req, res, next) => {
    const checked = validateSettings(req.body);
    if (!checked.valid) return res.status(400).json({ error: 'INVALID_SETTINGS', fields: checked.errors });
    try {
      const saved = await repository.saveSettings(checked.settings, req.admin.id);
      return res.json(saved);
    } catch (error) {
      return next(error);
    }
  });

  app.put('/api/knowledge', authenticated, mutation, async (req, res, next) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || JSON.stringify(req.body).length > 10000) {
      return res.status(400).json({ error: 'INVALID_KNOWLEDGE' });
    }
    const checked = validateSettings({ brand: req.body.brand, guardrails: req.body.guardrails });
    if (!checked.valid) return res.status(400).json({ error: 'INVALID_KNOWLEDGE', fields: checked.errors });
    const knowledge = { brand: checked.settings.brand, guardrails: checked.settings.guardrails };
    try {
      return res.json(await repository.saveKnowledge(knowledge, req.admin.id));
    } catch (error) {
      return next(error);
    }
  });

  app.put('/api/facts/:service', authenticated, mutation, async (req, res, next) => {
    const { service } = req.params;
    const { summary, active } = req.body || {};
    if (!['topup', 'account'].includes(service) || !summary || typeof summary !== 'object' || Array.isArray(summary)
      || typeof active !== 'boolean' || JSON.stringify(summary).length > 4000) {
      return res.status(400).json({ error: 'INVALID_FACT' });
    }
    if (summary.price !== undefined && summary.price !== '' && !/^\d{1,8}(?:\.\d{1,2})?$/.test(String(summary.price))) {
      return res.status(400).json({ error: 'INVALID_FACT_PRICE' });
    }
    const allowed = service === 'topup'
      ? ['game', 'denomination', 'price', 'availability']
      : ['game', 'price', 'availability', 'attributes'];
    if (Object.keys(summary).some((key) => !allowed.includes(key))
      || (service === 'account' && summary.game && summary.game !== 'Mobile Legends')) {
      return res.status(400).json({ error: 'INVALID_FACT_FIELDS' });
    }
    if (service === 'topup') {
      const settings = await repository.getSettings();
      if (typeof summary.game !== 'string' || !settings.gameWhitelist?.includes(summary.game)) {
        return res.status(400).json({ error: 'GAME_NOT_WHITELISTED' });
      }
    }
    for (const [key, value] of Object.entries(summary)) {
      const valid = key === 'attributes'
        ? Array.isArray(value) && value.length <= MAX_APPROVED_ATTRIBUTE_COUNT && value.every(isSafeApprovedAttribute)
        : typeof value === 'string' && value.length <= 200;
      if (!valid) return res.status(400).json({ error: 'INVALID_FACT_FIELDS' });
    }
    try {
      return res.json(await repository.saveFact(service, { summary, active }, req.admin.id));
    } catch (error) {
      return next(error);
    }
  });
}

module.exports = { registerDashboardRoutes };
