// Subscription reviewers are Codex and Claude. Each is on only when its flag
// says so. An empty flag keeps the historical default: Codex on, Claude off.
// When neither is on, the review is the DeepSeek API. This module does not
// call Gemini, Vertex, OpenCode, or Cursor.

const ON = new Set(['1', 'true', 'yes', 'on']);
const OFF = new Set(['0', 'false', 'no', 'off']);

export function flagEnabled(value, fallback) {
  if (value == null) return fallback;
  const text = String(value).trim().toLowerCase();
  if (!text) return fallback;
  if (ON.has(text)) return true;
  if (OFF.has(text)) return false;
  throw new Error(`Invalid review subscription flag: ${value}`);
}

export function flagsFromEnv(env) {
  return {
    codexEnabled: flagEnabled(env.CODEX_REVIEW_ENABLED, true),
    claudeEnabled: flagEnabled(env.CLAUDE_REVIEW_ENABLED, false),
  };
}

export function selectReviewRoute({ codexEnabled, claudeEnabled, quotaProviders = [] }) {
  const blocked = new Set(quotaProviders);
  const providers = [];
  if (codexEnabled && !blocked.has('codex')) providers.push('codex');
  if (claudeEnabled && !blocked.has('claude')) providers.push('claude');
  if (!providers.length) return { kind: 'deepseek', providers: ['deepseek'] };
  return { kind: 'subscription', providers };
}
