// Subscription reviewers are Codex and Claude. Each flag may be true, false,
// or auto (default when unset). In auto mode, a per-owner circuit breaker
// probes for a subscription response and caches inactive/quota cooldowns in KV
// so unsubscribed orgs route straight to DeepSeek with zero manual switches.

const ON = new Set(['1', 'true', 'yes', 'on']);
const OFF = new Set(['0', 'false', 'no', 'off']);
const AUTO = new Set(['auto']);

export const INACTIVE_COOLDOWN_MS = 6 * 60 * 60 * 1000;
export const QUOTA_COOLDOWN_MS = 2 * 60 * 60 * 1000;

export function flagMode(value, fallback = 'auto') {
  if (value == null) return fallback;
  const text = String(value).trim().toLowerCase();
  if (!text) return fallback;
  if (ON.has(text)) return true;
  if (OFF.has(text)) return false;
  if (AUTO.has(text)) return 'auto';
  throw new Error(`Invalid review subscription flag: ${value}`);
}

export function flagEnabled(value, fallback) {
  const mode = flagMode(value, fallback);
  return mode === 'auto' ? true : mode;
}

export function flagsFromEnv(env) {
  return {
    codexMode: flagMode(env.CODEX_REVIEW_ENABLED, 'auto'),
    claudeMode: flagMode(env.CLAUDE_REVIEW_ENABLED, 'auto'),
    codexEnabled: flagEnabled(env.CODEX_REVIEW_ENABLED, true),
    claudeEnabled: flagEnabled(env.CLAUDE_REVIEW_ENABLED, false),
  };
}

function isProviderInCooldown(entry, now) {
  return Boolean(entry && typeof entry.cooldownUntil === 'number' && now < entry.cooldownUntil);
}

export function selectAdaptiveRoute({
  codexMode = 'auto',
  claudeMode = 'auto',
  circuitState = {},
  quotaProviders = [],
  now = Date.now(),
} = {}) {
  const blocked = new Set(quotaProviders);
  const providers = [];
  const autoProbed = [];

  for (const [name, mode] of [['codex', codexMode], ['claude', claudeMode]]) {
    if (mode === false || blocked.has(name)) continue;
    if (mode === 'auto') {
      if (isProviderInCooldown(circuitState?.[name], now)) continue;
      autoProbed.push(name);
    }
    providers.push(name);
  }

  if (!providers.length) {
    return { kind: 'deepseek', providers: ['deepseek'], autoProbed: [] };
  }
  return { kind: 'subscription', providers, autoProbed };
}

export function selectReviewRoute({ codexEnabled, claudeEnabled, quotaProviders = [] }) {
  return selectAdaptiveRoute({
    codexMode: codexEnabled === false ? false : true,
    claudeMode: claudeEnabled === false ? false : true,
    quotaProviders,
  });
}

export function updateCircuitState(
  prevState = {},
  { activeProviders = [], quotaProviders = [], inactiveProviders = [], now = Date.now() } = {}
) {
  const next = { ...(prevState && typeof prevState === 'object' ? prevState : {}) };
  for (const p of inactiveProviders) {
    next[p] = { status: 'inactive', updatedAt: now, cooldownUntil: now + INACTIVE_COOLDOWN_MS };
  }
  for (const p of quotaProviders) {
    next[p] = { status: 'quota_exhausted', updatedAt: now, cooldownUntil: now + QUOTA_COOLDOWN_MS };
  }
  for (const p of activeProviders) {
    next[p] = { status: 'active', updatedAt: now, cooldownUntil: 0 };
  }
  return next;
}
