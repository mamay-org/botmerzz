'use strict';

const { createHash } = require('node:crypto');
const { validateSettings } = require('./policy');

// Snapshot the normalized policy and creative inputs that can influence a caption.
function contentSafetyHash(settings) {
  const checked = validateSettings(settings);
  if (!checked.valid) return null;
  return createHash('sha256').update(JSON.stringify(checked.settings)).digest('hex');
}

module.exports = { contentSafetyHash };
