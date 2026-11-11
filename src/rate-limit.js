'use strict';

function createIpRateLimiter({ limit = 120, windowMs = 60_000, clock = () => Date.now(), maxEntries = 10_000 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1
    || !Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new TypeError('limit, windowMs, and maxEntries must be positive integers');
  }
  const buckets = new Map();
  let nextResetAt = Infinity;

  function pruneExpiredBuckets(now) {
    if (now < nextResetAt) return;
    nextResetAt = Infinity;
    for (const [entryKey, entry] of buckets) {
      if (entry.resetAt <= now) buckets.delete(entryKey);
      else if (entry.resetAt < nextResetAt) nextResetAt = entry.resetAt;
    }
  }

  return function ipRateLimit(req, res, next) {
    const now = clock();
    const key = String(req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 128);
    let bucket = buckets.get(key);
    if (!bucket) {
      if (buckets.size >= maxEntries) pruneExpiredBuckets(now);
      if (buckets.size >= maxEntries) {
        res.set('Retry-After', String(Math.max(1, Math.ceil((nextResetAt - now) / 1000))));
        return res.status(503).json({ error: 'RATE_LIMIT_CAPACITY' });
      }
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
      if (bucket.resetAt < nextResetAt) nextResetAt = bucket.resetAt;
    } else if (bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
      if (bucket.resetAt < nextResetAt) nextResetAt = bucket.resetAt;
    }
    if (bucket.count >= limit) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      return res.status(429).json({ error: 'RATE_LIMITED' });
    }
    bucket.count++;
    return next();
  };
}

module.exports = { createIpRateLimiter };
