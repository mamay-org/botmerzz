'use strict';

const { validateSettings, isFactFresh } = require('../../policy');

function registerAutomationRoutes(app, { repository, services, authenticated, mutation }) {
  app.post('/api/automation/enable', authenticated, mutation, async (req, res, next) => {
    try {
      if (services.schedulerStatus?.().enabled !== true || typeof services.triggerScheduler !== 'function') {
        return res.status(503).json({ error: 'SCHEDULER_DISABLED' });
      }
      const state = await repository.getRuntimeState();
      const settings = validateSettings(state.settings || {});
      const facts = await repository.listFacts();
      const provider = services.getProviderStatus ? await services.getProviderStatus() : { connected: false };
      const complete = settings.valid && Boolean(settings.settings.brand.name && settings.settings.brand.voice)
        && settings.settings.guardrails.approved && settings.settings.gameWhitelist.length > 0
        && settings.settings.trackedLinks.topup && settings.settings.trackedLinks.account
        && ['topup', 'account'].every((key) => facts[key] && isFactFresh(facts[key], new Date()))
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
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/automation/pause', authenticated, mutation, async (req, res, next) => {
    try {
      const result = services.pauseAutomation
        ? await services.pauseAutomation({ adminId: req.admin.id })
        : (await repository.setAutomationEnabled(false, req.admin.id), { outcomes: [] });
      const outcomes = result?.outcomes || [];
      const canceled = outcomes.filter((entry) => entry.status === 'canceled').length;
      const attention = outcomes.filter((entry) => entry.status !== 'canceled').length;
      return res.json({
        enabled: false,
        outcomes,
        message: `Automasi dijeda. Pembatalan berjaya: ${canceled}; perlu semakan: ${attention}.`,
      });
    } catch (error) {
      return next(error);
    }
  });
}

module.exports = { registerAutomationRoutes };
