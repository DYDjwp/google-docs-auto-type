// Flare Redact 1.6.1 is bundled locally under docs/vendor/ (MIT licensed).
// This file runs in the user's browser. It never calls an external PII API.
import {redact} from './vendor/flare-redact-1.6.1.mjs';

const MAX_COMMENT_LENGTH = 1500;
const REDACTION_OPTIONS = Object.freeze({
  mode: 'label',
  // Phone, network identifiers, and conservative context-aware names and
  // street addresses are opt-in; basic secrets/email/cards are default.
  enable: ['phone', 'network', 'contextual']
});

/**
 * Returns a detached sanitized value, never mutating the feedback textarea.
 * Throws on redaction errors, so callers can reject the POST (fail closed).
 *
 * Pattern-based PII detection is best effort, not a guarantee of anonymity.
 */
export function redactComment(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_COMMENT_LENGTH)
    throw new TypeError('Invalid feedback comment length');
  const original = raw.trim();
  const result = redact(original, REDACTION_OPTIONS);
  if (typeof result !== 'string') throw new Error('Redactor returned an invalid result');
  // Masking can expand text (e.g. replacement labels); cap for Apps Script.
  const clean = result.trim().slice(0, MAX_COMMENT_LENGTH);
  return {comment: clean, masked: result !== original};
}
