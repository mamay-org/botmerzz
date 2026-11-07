'use strict';

function createScheduler({ run, intervalMs = 60_000, logger, clock = () => new Date() } = {}) {
  if (typeof run !== 'function') throw new TypeError('run is required');
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000) throw new TypeError('intervalMs must be at least one second');

  let timer = null;
  let activeRun = null;
  let lastStartedAt = null;
  let lastCompletedAt = null;
  let lastResult = null;
  let lastErrorCode = null;

  function status() {
    return {
      enabled: timer !== null,
      running: activeRun !== null,
      intervalSeconds: Math.floor(intervalMs / 1000),
      lastStartedAt,
      lastCompletedAt,
      lastResult,
      lastErrorCode,
    };
  }

  async function tick() {
    if (timer === null || activeRun) return null;
    lastStartedAt = clock().toISOString();
    activeRun = (async () => {
      try {
        lastResult = await run();
        lastErrorCode = null;
        return lastResult;
      } catch (error) {
        const code = typeof error?.code === 'string' && /^[a-z][a-z0-9_]{1,63}$/.test(error.code)
          ? error.code
          : 'scheduler_run_failed';
        lastErrorCode = code;
        lastResult = null;
        logger?.error?.('scheduler.run_failed', { code });
        return null;
      } finally {
        lastCompletedAt = clock().toISOString();
        activeRun = null;
      }
    })();
    return activeRun;
  }

  function start({ runImmediately = true } = {}) {
    if (timer !== null) return status();
    timer = setInterval(() => { void tick(); }, intervalMs);
    timer.unref?.();
    if (runImmediately) void tick();
    return status();
  }

  async function runNow() {
    if (timer === null) return null;
    if (activeRun) await activeRun;
    return tick();
  }

  async function stop() {
    if (timer !== null) clearInterval(timer);
    timer = null;
    if (activeRun) await activeRun;
    return status();
  }

  return { start, stop, tick, runNow, status };
}

module.exports = { createScheduler };
