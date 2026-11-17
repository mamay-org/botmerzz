'use strict';

const { createHash } = require('node:crypto');

const INTERNAL_PROMPT_LABEL = /\b(?:(?:system|developer|internal|hidden)[\s_.:-]+(?:system[\s_.:-]+)?(?:prompt|instructions?|message)|(?:prompt|instructions?)[\s_.:-]+(?:de[\s_.:-]+sistema|intern(?:al|o|a)s?|ocult(?:o|a)s?))\b/iu;

// This is a conservative filter, not a guarantee that all personal data can be
// recognized. Unknown opaque values fail closed instead of being persisted.
function sanitizeEvidence(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { status: 'unavailable', reason: 'missing', excerpt: null, fingerprint: null };
  const fingerprint = createHash('sha256').update(raw).digest('hex');
  try {
    if (raw.length > 10000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(raw)) {
      return { status: 'unavailable', reason: 'unsafe_format', excerpt: null, fingerprint };
    }
    if (/\b(?:authorization|bearer|api[_ -]?key|password|secret|token|credential|kata\s+sandi|sandi|pin)\b|\bsk-[A-Za-z0-9_-]{12,}/iu.test(raw.normalize('NFKC'))) {
      return { status: 'unavailable', reason: 'sensitive_label', excerpt: null, fingerprint };
    }
    let excerpt = raw.normalize('NFKC')
      .replace(/(?:https?:\/\/|www\.)[^\s<>]+/giu, '[redacted-url]')
      .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/giu, '[redacted-email]')
      .replace(/(?:\+?\d[\d ()-]{7,}\d)/gu, '[redacted-number]');
    // Long opaque strings can be credentials even when no key label is present.
    if (/(?:\b[A-Za-z0-9_\-+/=]{32,}\b)/u.test(excerpt)) {
      return { status: 'unavailable', reason: 'opaque_value', excerpt: null, fingerprint };
    }
    excerpt = [...excerpt].slice(0, 300).join('');
    return { status: 'available', reason: null, excerpt, fingerprint };
  } catch {
    return { status: 'unavailable', reason: 'sanitization_failed', excerpt: null, fingerprint };
  }
}

// Public Learning diagnostics and lesson eligibility checks may encounter
// legacy or administrator-authored free text. This bounded filter withholds
// explicitly labelled internal prompt material, then applies the existing
// credential/contact redaction. It is not a general PII detector.
function sanitizePublicText(raw) {
  if (typeof raw === 'string' && INTERNAL_PROMPT_LABEL.test(raw.normalize('NFKC'))) {
    return { status: 'unavailable', reason: 'internal_prompt', excerpt: null, fingerprint: null };
  }
  return sanitizeEvidence(raw);
}

// Model captions can contain arbitrary unlabeled secrets or personal data.
// No text or reversible/guessable digest crosses the capture boundary by default.
function sanitizeCaptionEvidence(raw) {
  return { status: 'unavailable', reason: typeof raw === 'string' && raw.trim() ? 'policy_withheld' : 'missing', excerpt: null, fingerprint: null };
}

module.exports = { sanitizeEvidence, sanitizePublicText, sanitizeCaptionEvidence };
