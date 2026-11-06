'use strict';

function createIpRateLimiter({ limit = 120, windowMs = 60_000, clock = () => Date.now(), maxEntries = 10_000 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1) {
    throw new TypeError('limit and windowMs must be positive integers');
  }
  const buckets = new Map();

  return function ipRateLimit(req, res, next) {
    const now = clock();
    const key = String(req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 128);
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    if (bucket.count >= limit) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      return res.status(429).json({ error: 'RATE_LIMITED' });
    }
    bucket.count++;
    if (buckets.size > maxEntries) {
      for (const [entryKey, entry] of buckets) if (entry.resetAt <= now) buckets.delete(entryKey);
      while (buckets.size > maxEntries) buckets.delete(buckets.keys().next().value);
    }
    return next();
  };
}

module.exports = { createIpRateLimiter };
