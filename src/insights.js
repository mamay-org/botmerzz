'use strict';

const { DateTime } = require('luxon');

function extractClickMetric(response) {
  const metric = response?.data?.metrics?.clicks ?? response?.metrics?.clicks;
  const value = typeof metric === 'number' ? metric : metric && typeof metric === 'object'
    ? metric.total ?? metric.value : null;
  if (!Number.isSafeInteger(value) || value < 0) {
    return { available: false, value: null, reason: response?.missing_permission ? 'permission_missing' : 'no_data' };
  }
  return { available: true, value, reason: null };
}

async function getClickMetric({ publisher, accountId, timezone = 'Asia/Kuala_Lumpur', now = new Date() } = {}) {
  if (!publisher || typeof accountId !== 'string' || !accountId) return extractClickMetric(null);
  const current = DateTime.fromJSDate(now instanceof Date ? now : new Date(now), { zone: 'utc' }).setZone(timezone);
  if (!current.isValid) return extractClickMetric(null);
  const response = await publisher.getInsights(accountId, {
    metrics: ['clicks'],
    from: current.minus({ days: 29 }).toISODate(),
    to: current.toISODate(),
    tz: timezone,
  });
  return extractClickMetric(response);
}

module.exports = { extractClickMetric, getClickMetric };
