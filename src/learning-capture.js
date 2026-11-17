'use strict';

// Capture is best effort: one isolated operation, no queue and no publishing wait.
// A timeout means the database outcome is unknown, not that the insert failed.
function createCapture({ store, logger, timeoutMs = 250 }) {
  let busy = false;
  let accepting = true;
  const report = (outcome) => {
    try { logger?.info('learning.capture', { outcome }); } catch { /* Logging is optional. */ }
  };
  const capture = (event) => {
    if (!accepting) { report('shutdown_dropped'); return; }
    report('attempted');
    if (busy) { report('dropped'); return; }
    busy = true;
    const timer = setTimeout(() => { report('unknown'); }, timeoutMs);
    timer.unref?.();
    Promise.resolve().then(() => store(event)).then((result) => {
      report(result?.deduplicated ? 'deduplicated' : 'captured');
    }, () => { report('failed'); }).finally(() => {
      clearTimeout(timer);
      busy = false;
    });
  };
  capture.stop = () => { accepting = false; return { pending: busy }; };
  return capture;
}
module.exports = { createCapture };
