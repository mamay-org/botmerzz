#!/usr/bin/env node
const readline = require('node:readline/promises');
const { StringDecoder } = require('node:string_decoder');
const { stdin, stdout } = require('node:process');
const { loadEnv } = require('./config');
const { createPool, endOptionalPoolBounded } = require('./db');
const { runMigrations } = require('./migrate');
const { createRepository } = require('./repository');
const { createAuth } = require('./auth');
const { createServer } = require('./server');
const { runDispatcher, pauseAutomation, reconcileUnsettled } = require('./dispatcher');
const { generatePost } = require('./content-service');
const { createLogger } = require('./logger');
const { createOutboxNotifier } = require('./notifications');
const { getClickMetric } = require('./insights');
const { createScheduler } = require('./scheduler');

function providerConnectionStatus(accounts, effective) {
  const target = accounts.find((account) => account.id === effective.accountId && account.profileId === effective.profileId);
  return { connected: Boolean(target && target.platform === 'threads' && target.status === 'active' && target.planSuspended === false), status: target?.planSuspended === true ? 'plan_suspended' : target?.planSuspended == null ? 'status_unknown' : target?.status || 'not_connected', username: target?.username || null };
}

async function askHidden(prompt, { input = stdin, output = stdout } = {}) {
  output.write(prompt);
  input.setRawMode?.(true); input.resume();
  let value = '';
  const decoder = new StringDecoder('utf8');
  return new Promise((resolve, reject) => {
    const onData = (chunk) => {
      const text = decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      for (const char of text) {
        if (char === '\u0003') { cleanup(); reject(new Error('CANCELLED')); return; }
        if (char === '\r' || char === '\n') { output.write('\n'); cleanup(); resolve(value); return; }
        if (char === '\u007f') value = [...value].slice(0, -1).join('');
        else if (char >= ' ') value += char;
      }
    };
    const cleanup = () => { input.off('data', onData); input.setRawMode?.(false); input.pause?.(); };
    input.on('data', onData);
  });
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0] || 'server';
  const config = loadEnv();
  const pool = createPool(config);
  const logger = createLogger('app');
  try {
    if (command === 'migrate') {
      try { const applied = await runMigrations(pool); stdout.write(`Applied ${applied.length} migration(s).\n`); }
      finally { await pool.end(); }
      return;
    }
    await runMigrations(pool);
    const repository = createRepository(pool);
    const attemptLifecycle = require('./generation-attempts').createGenerationAttemptStore(pool);
    const learning = require('./learning').createLearningStore(pool);
    const learningFlags = {
      captureEnabled: config.learningCaptureEnabled,
      activationEnabled: config.learningActivationEnabled,
      retrievalEnabled: config.learningRetrievalEnabled,
      promptIntegrationEnabled: config.learningPromptIntegrationEnabled,
      shadowEnabled: config.learningShadowEnabled,
    };
    let learningExecutionPool; let learningExecutionStore; let attributionStore;
    const contentWithLearning = (context, deps) => {
      const learningEnabled = config.learningRetrievalEnabled || config.learningPromptIntegrationEnabled;
      if (learningEnabled && !learningExecutionPool) {
        learningExecutionPool = createPool({ ...config, db: { ...config.db, connectionLimit: 1 } });
        learningExecutionStore = require('./learning').createLearningStore(learningExecutionPool);
        attributionStore = require('./learning-attribution').createLearningAttributionStore(learningExecutionPool);
      }
      return generatePost(context, { ...deps, attemptLifecycle, captureFailure, recordOutcome,
        generatorSampling: config.openRouter.generatorSampling,
        ...(learningEnabled ? { learningStore: learningExecutionStore, attributionStore } : {}),
        learningFlags,
        onLearningError: (code) => logger.info('learning.execution_degraded', { code }),
      });
    };
    let capturePool;
    const captureFailure = config.learningCaptureEnabled ? require('./learning-capture').createCapture({ logger, store: async (finding) => {
        capturePool ||= createPool({ ...config, db: { ...config.db, connectionLimit: 1 } });
        return require('./learning').createLearningStore(capturePool).captureFailure(finding);
    } }) : undefined;
    let outcomePool;
    const recordOutcome = config.learningCaptureEnabled ? require('./learning-capture').createCapture({ logger, store: async (outcome) => {
      outcomePool ||= createPool({ ...config, db: { ...config.db, connectionLimit: 1 } });
      const result = await require('./validation-outcomes').createOutcomeStore(outcomePool).record(outcome);
      return { deduplicated: result.status === 'duplicate' };
    } }) : undefined;
    const auth = createAuth({ repository });
    const { createConfigurationService } = require('./configuration');
    const configuration = createConfigurationService({ pool, config });
    await configuration.bootstrap();
    let learningAnalyticsPool; let learningAnalyticsStore;
    const getLearningAnalytics = () => {
      learningAnalyticsPool ||= createPool({ ...config, db: { ...config.db, connectionLimit: 1 } });
      learningAnalyticsStore ||= require('./learning-analytics').createLearningAnalytics(learningAnalyticsPool);
      return learningAnalyticsStore;
    };
    let learningShadowPool; let learningShadowStore; let learningShadowExecution;
    const getLearningShadowServices = () => {
      if (!learningShadowPool) {
        learningShadowPool = createPool({ ...config, db: { ...config.db, connectionLimit: 2 } });
        learningShadowStore = require('./learning-shadow').createLearningShadowStore(learningShadowPool);
        const shadowRepository = createRepository(learningShadowPool);
        const shadowConfiguration = createConfigurationService({ pool: learningShadowPool, config });
        const shadowLearningStore = require('./learning').createLearningStore(learningShadowPool);
        learningShadowExecution = require('./learning-shadow-execution').createLearningShadowExecutionService({
          store: learningShadowStore, repository: shadowRepository, configuration: shadowConfiguration,
          learningStore: shadowLearningStore,
          providerForModel: async (model) => {
            if (!config.openRouter.apiKey) throw Object.assign(new Error('OPENROUTER_NOT_CONFIGURED'), { code: 'OPENROUTER_NOT_CONFIGURED', status: 503 });
            return require('./providers/openrouter').createOpenRouterClient({ apiKey: config.openRouter.apiKey, model }).generate;
          },
          generatorSampling: config.openRouter.generatorSampling,
        });
      }
      return { store: learningShadowStore, execution: learningShadowExecution };
    };
    const lazyShadowStore = Object.fromEntries(['start','finish','get','list','recordReview','listReviews','consumeStartQuota','acquireAdmission'].map((method) => [method,(...args) => getLearningShadowServices().store[method](...args)]));
    const publisherForProfile = async (profileId) => {
      if (!config.tebar.apiKey || typeof profileId !== 'string' || !profileId) throw Object.assign(new Error('TEBAR_NOT_CONFIGURED'), { code: 'not_configured' });
      return require('./providers/tebar').createTebarClient({ apiKey: config.tebar.apiKey, profileId });
    };
    const generatorForModel = async (model) => {
      if (!config.openRouter.apiKey) throw Object.assign(new Error('AI_NOT_CONFIGURED'), { code: 'not_configured' });
      return require('./providers/openrouter').createOpenRouterClient({ apiKey: config.openRouter.apiKey, model }).generate;
    };
    if (command === 'admin:create') {
      const rl = readline.createInterface({ input: stdin, output: stdout });
      try {
        const email = await rl.question('Admin email: ');
        rl.close();
        const password = await askHidden('Admin password (12+ characters): ');
        const confirm = await askHidden('Confirm password: ');
        if (password !== confirm) throw new Error('PASSWORDS_DO_NOT_MATCH');
        await auth.createAdmin({ email, password });
        stdout.write('Administrator created.\n');
      } finally { rl.close(); await pool.end(); }
      return;
    }
    if (command === 'dispatch') {
      const effective = await configuration.getActive();
      const publisher = config.tebar.apiKey && effective.profileId ? await publisherForProfile(effective.profileId) : null;
      if (!publisher) { stdout.write('{"skipped":"tebar_not_configured"}\n'); await pool.end(); return; }
      const telegram = config.telegram.botToken && config.telegram.chatId ? require('./providers/telegram').createTelegramClient(config.telegram) : null;
      const notifier = telegram ? createOutboxNotifier({ repository, transport: telegram }) : null;
      const state = await repository.getRuntimeState();
      try {
        const result = await runDispatcher({ repository, publisher, publisherForProfile, generatorForModel, notifier, logger, content: contentWithLearning, timezone: state.settings?.schedule?.timezone || config.timezone });
        stdout.write(`${JSON.stringify(result)}\n`);
      } catch (error) {
        try { await notifier?.send('Kedai Merzz automation: system_error. Semak status sistem dan log dashboard.'); } catch { /* Keep the original dispatcher error for process monitoring. */ }
        throw error;
      } finally {
        captureFailure?.stop?.(); recordOutcome?.stop?.();
        await pool.end();
        if (capturePool) await endOptionalPoolBounded(capturePool);
        if (outcomePool) await endOptionalPoolBounded(outcomePool);
        if (learningExecutionPool) await endOptionalPoolBounded(learningExecutionPool);
      }
      return;
    }
    if (command !== 'server') throw new Error('UNKNOWN_COMMAND');
    const services = {
      pool,
      learning,
      learningFlags,
      learningAnalytics: {
        compliance: (...args) => getLearningAnalytics().compliance(...args),
        quality: (...args) => getLearningAnalytics().quality(...args),
        effectiveness: (...args) => getLearningAnalytics().effectiveness(...args),
      },
      learningShadowStore: lazyShadowStore,
      evaluateLearningShadow: async (request) => getLearningShadowServices().execution.evaluate(request),
      logger,
      configuration,
      getProviderStatus: async () => {
        try {
          const effective = await configuration.getActive();
          if (!config.tebar.apiKey || effective.status !== 'ACTIVE') return { connected: false, status: 'not_configured' };
          const tebar = await publisherForProfile(effective.profileId);
          const accounts = await tebar.listAccounts();
          return providerConnectionStatus(accounts, effective);
        } catch (error) { return { connected: false, status: error.code || 'provider_error' }; }
      },
    };
    services.configurationValidators = require('./configuration-providers').createConfigurationValidators({ config });
    services.aiConfigured = Boolean(config.openRouter.apiKey);
    const telegram = config.telegram.botToken && config.telegram.chatId ? require('./providers/telegram').createTelegramClient(config.telegram) : null;
    const notifier = telegram ? createOutboxNotifier({ repository, transport: telegram }) : null;
    services.reconcileSwitch = async () => {
      const slots = await repository.listUnsettledSlots();
      for (const slot of slots) {
        if (!slot.profileId || !slot.accountId || !slot.providerPostId
          || slot.requestPayload?.targets?.[0]?.account_id !== slot.accountId
          || !['scheduled', 'draft'].includes(slot.providerStatus)) continue;
        try {
          const publisher = await publisherForProfile(slot.profileId);
          const post = await publisher.getPost(slot.providerPostId);
          if (!['scheduled', 'draft'].includes(post.status)
            || !post.targets?.some((target) => target.accountId === slot.accountId && target.platform === 'threads')) continue;
          const canceled = await publisher.cancelPost(slot.providerPostId);
          if (canceled.status === 'canceled') {
            await repository.recordCancellation(slot.providerPostId, { status: 'canceled' });
            await repository.updateSlot(slot.id, { status: 'canceled', providerStatus: 'canceled', completedAt: new Date().toISOString() });
          }
        } catch { /* Preserve uncertain state; operator can retry reconciliation. */ }
      }
      await reconcileUnsettled({ repository, publisherForProfile, notifier, logger });
    };
    let scheduler = null;
    let retentionPool;
    let retentionConsecutiveFailures = 0;
    const retentionScheduler = config.learningRetentionEnabled ? createScheduler({ intervalMs: 3600000, logger, run: async () => {
      try {
        retentionPool ||= createPool({ ...config, db: { ...config.db, connectionLimit: 1 } });
        const result = await require('./learning-retention').purgeExpiredEvidence({ pool: retentionPool, retentionDays: config.learningRetentionDays });
        retentionConsecutiveFailures = 0;
        logger.info('learning.retention', result);
        return result;
      } catch (error) {
        retentionConsecutiveFailures++;
        logger.error('learning.retention_failed', { code: /^[A-Z0-9_]{1,64}$/.test(error?.code || '') ? error.code : 'retention_failed', consecutiveFailures: retentionConsecutiveFailures });
        throw error;
      }
    } }) : null;
    services.getClickMetric = async (state) => {
      try {
        const effective = await configuration.getActive();
        if (!config.tebar.apiKey || !effective.accountId || !effective.profileId) return { available: false, value: null, reason: 'not_configured' };
        return await getClickMetric({ publisher: await publisherForProfile(effective.profileId), accountId: effective.accountId, timezone: state.settings?.schedule?.timezone || config.timezone });
      }
      catch { return { available: false, value: null, reason: 'provider_unavailable' }; }
    };
    if (notifier) {
      services.notify = async (code) => {
        await notifier.enqueue(`Kedai Merzz automation: ${['account_disconnected','provider_error'].includes(code) ? code : 'system_error'}. Semak status akaun dan log dashboard.`);
        void notifier.flush().catch(() => {});
      };
      services.flushNotifications = () => notifier.flush();
    }
    services.pauseAutomation = async ({ adminId }) => {
      const effective = await configuration.getActive();
      if (!config.tebar.apiKey || !effective.profileId) { await repository.setAutomationEnabled(false, adminId); return { enabled: false, outcomes: [{ status: 'provider_unavailable' }] }; }
      return pauseAutomation({ repository, publisher: await publisherForProfile(effective.profileId), notifier, accountId: effective.accountId, adminId });
    };
    const dispatchOnce = async () => {
      const effective = await configuration.getActive();
      if (!config.tebar.apiKey || !effective.profileId) return { skipped: 'tebar_not_configured' };
      const state = await repository.getRuntimeState();
      return runDispatcher({
        repository,
        publisher: await publisherForProfile(effective.profileId),
        publisherForProfile,
        generatorForModel,
        notifier,
        logger,
        content: contentWithLearning,
        timezone: state.settings?.schedule?.timezone || config.timezone,
      });
    };
    if (config.schedulerEnabled) {
      scheduler = createScheduler({
        intervalMs: config.schedulerIntervalSeconds * 1000,
        logger,
        run: dispatchOnce,
      });
    }
    services.triggerScheduler = () => scheduler?.runNow();
    services.schedulerStatus = () => scheduler?.status() || {
      enabled: false, running: false, intervalSeconds: config.schedulerIntervalSeconds,
      lastStartedAt: null, lastCompletedAt: null, lastResult: null, lastErrorCode: null,
    };
    const app = createServer({ config, repository, auth, services });
    const server = app.listen(config.port, () => {
      logger.info('server.started', { port: config.port, environment: config.nodeEnv, schedulerEnabled: config.schedulerEnabled });
      if (scheduler) scheduler.start();
      retentionScheduler?.start();
    });
    let closing = false;
    let learningOptionalShutdown;
    const closeLearningOptionalPools = () => {
      if (!learningOptionalShutdown) {
        learningShadowExecution?.stop?.();
        learningOptionalShutdown = Promise.all([
          learningAnalyticsPool ? endOptionalPoolBounded(learningAnalyticsPool) : Promise.resolve(),
          learningShadowPool ? endOptionalPoolBounded(learningShadowPool) : Promise.resolve(),
        ]);
      }
      return learningOptionalShutdown;
    };
    const close = () => {
      if (closing) return;
      closing = true;
      const hardStop = setTimeout(() => process.exit(1), 200000).unref();
      captureFailure?.stop?.(); recordOutcome?.stop?.();
      retentionScheduler?.halt?.();
      void scheduler?.stop();
      const learningPoolsClosed = closeLearningOptionalPools();
      server.close(async () => {
        try {
          await scheduler?.stop();
          await pool.end();
          if (capturePool) await endOptionalPoolBounded(capturePool);
          if (outcomePool) await endOptionalPoolBounded(outcomePool);
          if (retentionPool) await endOptionalPoolBounded(retentionPool);
          if (learningExecutionPool) await endOptionalPoolBounded(learningExecutionPool);
          await learningPoolsClosed;
          clearTimeout(hardStop);
          process.exit(0);
        } catch {
          process.exit(1);
        }
      });
    };
    process.once('SIGTERM', close); process.once('SIGINT', close);
  } catch (error) { await pool.end(); throw error; }
}

if (require.main === module) main().catch((error) => {
  const code = /^[A-Z0-9_]+$/.test(error.code || error.message) ? (error.code || error.message) : 'STARTUP_FAILED';
  process.stderr.write(`${code}\n`); process.exitCode = 1;
});

module.exports = { askHidden, main, providerConnectionStatus };
