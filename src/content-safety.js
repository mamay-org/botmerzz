'use strict';

const { createHash } = require('node:crypto');
const { validateSettings } = require('./policy');

// Snapshot the normalized policy and creative inputs that can influence a caption.
function contentSafetyHash(settings) {
  const checked = validateSettings(settings);
  if (!checked.valid) return null;
  const contentSettings = { ...checked.settings };
  delete contentSettings.schedule;
  return createHash('sha256').update(JSON.stringify(contentSettings)).digest('hex');
}

function legacyContentSafetyHash(settings) {
  const checked = validateSettings(settings);
  if (!checked.valid) return null;
  const { timezone, activeDays, activeStart, activeEnd } = checked.settings.schedule;
  const legacySettings = {
    ...checked.settings,
    schedule: { intervalHours: 1, timezone, activeDays, activeStart, activeEnd },
  };
  return createHash('sha256').update(JSON.stringify(legacySettings)).digest('hex');
}

module.exports = { contentSafetyHash, legacyContentSafetyHash };
