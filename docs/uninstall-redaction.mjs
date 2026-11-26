// Flare Redact 1.6.1 is bundled locally under docs/vendor/ (MIT licensed).
// This file runs in the user's browser. It never calls an external PII API.
import {redact} from './vendor/flare-redact-1.6.1.mjs';

const MAX_COMMENT_LENGTH = 1500;

// Supplemental contextual phone recognition for formats missing from the
// library (e.g. 415-555-0123, 4155550123, and Chinese 13800138000).
// Only mask a number when a nearby phrase indicates a phone/contact detail.
// This avoids treating arbitrary 10-digit timings, IDs or counts as phones.
const PHONE_CONTEXT = /(?:\b(?:phone|mobile|cell(?:phone)?|telephone|tel|call(?:\s+me)?|text(?:\s+me)?|contact(?:\s+me)?)(?:\s+(?:number|no|at|is|me))?\b|手机号(?:码)?|手机(?:号码)?|联系电话|电话(?:号码)?|联系(?:我)?(?:方式|电话)?)/iu;
const PHONE_CANDIDATES = /(?<![\p{L}\p{N}])(?:\+?1[\s.-]?)?(?:\([2-9]\d{2}\)|[2-9]\d{2})[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)|(?<!\d)(?:\+?86[\s.-]?)?1[3-9]\d{9}(?!\d)/gu;
function maskContextualPhones(text) {
  return text.replace(PHONE_CANDIDATES, (match, offset, full) => {
    const nearby = full.slice(Math.max(0, offset - 70), offset).split(/[\n\r.!?。！？]/u).at(-1);
    return PHONE_CONTEXT.test(nearby) ? '[REDACTED:phone]' : match;
  });
}
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
  const cleaned = maskContextualPhones(result).trim();
  const clean = cleaned.slice(0, MAX_COMMENT_LENGTH);
  return {comment: clean, masked: cleaned !== original};
}
