#!/usr/bin/env node
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { loadEnv } = require('./config');
const { createPool } = require('./db');
const { runMigrations } = require('./migrate');
const { createRepository } = require('./repository');
const { createAuth } = require('./auth');
const { createServer } = require('./server');
const { runDispatcher, pauseAutomation } = require('./dispatcher');
const { generatePost } = require('./content-service');
const { createLogger } = require('./logger');
const { createOutboxNotifier } = require('./notifications');
const { getClickMetric } = require('./insights');
const { createScheduler } = require('./scheduler');

async function askHidden(prompt) {
  stdout.write(prompt);
  stdin.setRawMode?.(true); stdin.resume();
  let value = '';
  return new Promise((resolve, reject) => {
    const onData = (chunk) => {
      const char = chunk.toString('utf8');
      if (char === '\u0003') { cleanup(); reject(new Error('CANCELLED')); }
      else if (char === '\r' || char === '\n') { stdout.write('\n'); cleanup(); resolve(value); }
      else if (char === '\u007f') value = value.slice(0, -1);
      else if (char >= ' ') value += char;
    };
    const cleanup = () => { stdin.off('data', onData); stdin.setRawMode?.(false); };
    stdin.on('data', onData);
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
    const auth = createAuth({ repository });
    await repository.setProviderTarget({ accountId: config.tebar.accountId, profileId: config.tebar.profileId });
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
      const publisher = config.tebar.apiKey && config.tebar.profileId ? require('./providers/tebar').createTebarClient({ apiKey: config.tebar.apiKey, profileId: config.tebar.profileId }) : null;
      if (!publisher) { stdout.write('{"skipped":"tebar_not_configured"}\n'); await pool.end(); return; }
      const generator = config.openRouter.apiKey ? require('./providers/openrouter').createOpenRouterClient(config.openRouter) : null;
      const telegram = config.telegram.botToken && config.telegram.chatId ? require('./providers/telegram').createTelegramClient(config.telegram) : null;
      const notifier = telegram ? createOutboxNotifier({ repository, transport: telegram }) : null;
      const state = await repository.getRuntimeState();
      try {
        const result = await runDispatcher({ repository, publisher, notifier, content: generatePost, contentGenerator: generator ? generator.generate : async () => { throw Object.assign(new Error('AI_NOT_CONFIGURED'), { code: 'not_configured' }); }, timezone: state.settings?.schedule?.timezone || config.timezone, minimumIntervalHours: state.settings?.schedule?.intervalHours || config.intervalHours });
        stdout.write(`${JSON.stringify(result)}\n`);
      } catch (error) {
        try { await notifier?.send('Kedai Merzz automation: system_error. Semak status sistem dan log dashboard.'); } catch { /* Keep the original dispatcher error for process monitoring. */ }
        throw error;
      } finally { await pool.end(); }
      return;
    }
    if (command !== 'server') throw new Error('UNKNOWN_COMMAND');
    let tebar = null;
    if (config.tebar.apiKey && config.tebar.profileId) tebar = require('./providers/tebar').createTebarClient({ apiKey: config.tebar.apiKey, profileId: config.tebar.profileId });
    const services = {
      pool,
      logger,
      getProviderStatus: async () => {
        if (!tebar) return { connected: false, status: 'not_configured' };
        try {
          const accounts = await tebar.listAccounts();
          const target = accounts.find((account) => account.id === config.tebar.accountId);
          return { connected: Boolean(target && target.platform === 'threads' && target.status === 'active'), status: target?.status || 'not_connected', username: target?.username || null };
        } catch (error) { return { connected: false, status: error.code || 'provider_error' }; }
      },
    };
    services.aiConfigured = Boolean(config.openRouter.apiKey);
    const telegram = config.telegram.botToken && config.telegram.chatId ? require('./providers/telegram').createTelegramClient(config.telegram) : null;
    const notifier = telegram ? createOutboxNotifier({ repository, transport: telegram }) : null;
    let scheduler = null;
    services.getClickMetric = async (state) => {
      if (!tebar || !config.tebar.accountId) return { available: false, value: null, reason: 'not_configured' };
      try { return await getClickMetric({ publisher: tebar, accountId: config.tebar.accountId, timezone: state.settings?.schedule?.timezone || config.timezone }); }
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
      if (!tebar) { await repository.setAutomationEnabled(false, adminId); return { enabled: false, outcomes: [{ status: 'provider_unavailable' }] }; }
      return pauseAutomation({ repository, publisher: tebar, notifier, accountId: config.tebar.accountId, adminId });
    };
    if (config.schedulerEnabled) {
      const generator = config.openRouter.apiKey ? require('./providers/openrouter').createOpenRouterClient(config.openRouter) : null;
      scheduler = createScheduler({
        intervalMs: config.schedulerIntervalSeconds * 1000,
        logger,
        run: async () => {
          if (!tebar) return { skipped: 'tebar_not_configured' };
          const state = await repository.getRuntimeState();
          return runDispatcher({
            repository,
            publisher: tebar,
            notifier,
            content: generatePost,
            contentGenerator: generator ? generator.generate : async () => { throw Object.assign(new Error('AI_NOT_CONFIGURED'), { code: 'not_configured' }); },
            timezone: state.settings?.schedule?.timezone || config.timezone,
            minimumIntervalHours: state.settings?.schedule?.intervalHours || config.intervalHours,
          });
        },
      });
    }
    services.schedulerStatus = () => scheduler?.status() || {
      enabled: false, running: false, intervalSeconds: config.schedulerIntervalSeconds,
      lastStartedAt: null, lastCompletedAt: null, lastResult: null, lastErrorCode: null,
    };
    const app = createServer({ config, repository, auth, services });
    const server = app.listen(config.port, () => {
      logger.info('server.started', { port: config.port, environment: config.nodeEnv, schedulerEnabled: config.schedulerEnabled });
      if (scheduler) scheduler.start();
    });
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      const hardStop = setTimeout(() => process.exit(1), 200000).unref();
      void scheduler?.stop();
      server.close(async () => {
        try {
          await scheduler?.stop();
          await pool.end();
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

module.exports = { main };
