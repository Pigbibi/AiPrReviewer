// Pure routing, diff trimming, and receipt detection for review-core.

export const RECEIPT_MARKERS = [
  'ai-review-receipt:v1',
  'codex-review-receipt:v1',
  'codex-review-state:v1',
];

export const QUOTA_PATTERN = /\b(?:usage\s+limit|rate\s*limit|quota\s+(?:exceeded|reached|exhausted)|out\s+of\s+credits?|limit\s+reached|try\s+again\s+later)\b|额度已用完|达到上限/i;

const SKIP_DIFF_PATH = /(?:^|\/)(?:package-lock\.json|uv\.lock|poetry\.lock|yarn\.lock|pnpm-lock\.yaml|cargo\.lock|gemfile\.lock)$|(?:^|\/)fixtures(?:\/|$)/i;
const ROUTINE_BRANCH_RE = /^(?:chore\/bump-|docs\/)/i;
const DOC_ONLY_PATH_RE = /\.(?:md|txt|rst)$/i;

function extractMarkerPayload(body, marker) {
  const idx = body.indexOf(marker);
  if (idx < 0) return null;
  const start = idx + marker.length;
  const end = body.indexOf('-->', start);
  if (end < 0) return null;
  const raw = body.slice(start, end).trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function isReviewInProgressForHead(
  comments,
  headSha,
  { reviewerProviders = {} } = {}
) {
  if (isCodexRunningForHead(comments, headSha)) return true;
  const trusted = normalizedReviewerProviders(reviewerProviders);
  return comments.some(comment => {
    if (typeof comment.body !== 'string' || !comment.body.includes(headSha)) return false;
    const receipt = extractMarkerPayload(comment.body, 'ai-review-receipt:v1');
    const subscription = trustedSubscriptionProvider(comment?.user);
    const login = String(comment?.user?.login || '').trim().toLowerCase();
    const claimed = String(receipt?.review?.provider || subscription || '').trim().toLowerCase();
    const trustedProvider = subscription === claimed || trusted.get(login)?.has(claimed);
    return Boolean(
      trustedProvider
      && receipt
      && receipt.review
      && receipt.review.commit_sha === headSha
      && receipt.review.status
      && receipt.review.status !== 'completed'
    );
  });
}

export function isCodexRunningForHead(comments, headSha) {
  return comments.some(c => {
    if (trustedSubscriptionProvider(c?.user) !== 'codex') return false;
    if (typeof c.body !== 'string' || !c.body.includes(headSha)) return false;
    const state = extractMarkerPayload(c.body, 'codex-review-state:v1');
    return Boolean(
      state
      && state.code_review
      && state.code_review.commit_sha === headSha
      && state.code_review.status !== 'completed'
    );
  });
}

export function isCodexQuotaComment(body, userLogin = '') {
  return /codex/i.test(userLogin) && typeof body === 'string' && QUOTA_PATTERN.test(body);
}

const TRUSTED_CODEX_LOGINS = new Set(['chatgpt-codex-connector[bot]', 'chatgpt-codex-connector']);
const TRUSTED_CLAUDE_LOGINS = new Set(['claude[bot]']);

function trustedSubscriptionProvider(user) {
  const login = String(user?.login || '').trim().toLowerCase();
  if (TRUSTED_CODEX_LOGINS.has(login)) return 'codex';
  if (TRUSTED_CLAUDE_LOGINS.has(login)) return 'claude';
  return null;
}

function normalizedReviewerProviders(reviewerProviders = {}) {
  const normalized = new Map();
  for (const [login, providers] of Object.entries(reviewerProviders || {})) {
    const key = String(login || '').trim().toLowerCase();
    const values = Array.isArray(providers) ? providers : [providers];
    const valid = values.map(value => String(value || '').trim().toLowerCase()).filter(Boolean);
    if (key && valid.length) normalized.set(key, new Set(valid));
  }
  return normalized;
}

function completedReceiptProvider(comment, headSha, reviewerProviders) {
  const login = String(comment?.user?.login || '').trim().toLowerCase();
  const body = typeof comment?.body === 'string' ? comment.body : '';
  if (!headSha || !body.includes(headSha)) return null;

  const subscription = trustedSubscriptionProvider(comment?.user);
  if (subscription === 'codex' && body.includes('codex-review-state:v1')) {
    const state = extractMarkerPayload(body, 'codex-review-state:v1');
    return state?.code_review?.commit_sha === headSha && state.code_review.status === 'completed'
      ? 'codex' : null;
  }

  const marker = body.includes('ai-review-receipt:v1')
    ? 'ai-review-receipt:v1'
    : body.includes('codex-review-receipt:v1') ? 'codex-review-receipt:v1' : null;
  if (!marker) return null;
  const receipt = extractMarkerPayload(body, marker);
  const review = receipt?.review;
  if (!review || review.commit_sha !== headSha
    || (review.status && review.status !== 'completed')) return null;

  if (subscription) {
    const claimed = String(review.provider || subscription).trim().toLowerCase();
    return claimed === subscription ? subscription : null;
  }

  const allowed = reviewerProviders.get(login);
  const claimed = String(review.provider || '').trim().toLowerCase();
  return allowed?.has(claimed) ? claimed : null;
}

export function collectTrustedReviewProviders(
  comments = [],
  headSha = '',
  { reviewerProviders = {} } = {}
) {
  const trusted = normalizedReviewerProviders(reviewerProviders);
  const providers = new Set();
  for (const comment of comments) {
    const provider = completedReceiptProvider(comment, headSha, trusted);
    if (provider) providers.add(provider);
  }
  return [...providers].sort();
}

export function reviewerProvidersFromEnv(env = {}) {
  const mapping = {};
  const raw = String(env.TRUSTED_REVIEWERS_JSON || '').trim();
  if (raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Invalid TRUSTED_REVIEWERS_JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Invalid TRUSTED_REVIEWERS_JSON');
    }
    for (const [login, providers] of Object.entries(parsed)) {
      const values = Array.isArray(providers) ? providers : [providers];
      if (!String(login || '').trim() || !values.length || values.some(value => !String(value || '').trim())) {
        throw new Error('Invalid TRUSTED_REVIEWERS_JSON');
      }
      mapping[String(login).trim().toLowerCase()] = values.map(value => String(value).trim().toLowerCase());
    }
  }
  const selfLogin = String(env.REVIEWER_LOGIN || '').trim().toLowerCase();
  const selfProvider = String(env.AI_REVIEW_PROVIDER || 'deepseek').trim().toLowerCase();
  if (selfLogin) {
    mapping[selfLogin] = [...new Set([...(mapping[selfLogin] || []), selfProvider])];
  }
  return mapping;
}

export function hasReceiptForHead(comments, headSha, options = {}) {
  return collectTrustedReviewProviders(comments, headSha, options).length > 0;
}

export function detectQuotaProviders(comments = [], { maxAgeMs = 30 * 60 * 1000, now = Date.now() } = {}) {
  const providers = new Set();
  for (const c of comments) {
    const provider = trustedSubscriptionProvider(c?.user);
    if (!provider) continue;
    const body = typeof c?.body === 'string' ? c.body : '';
    if (RECEIPT_MARKERS.some(m => body.includes(m))) continue;
    if (!QUOTA_PATTERN.test(body)) continue;
    const ts = Date.parse(c?.created_at || '');
    if (Number.isFinite(ts) && Number.isFinite(maxAgeMs) && now - ts > maxAgeMs) continue;
    providers.add(provider);
  }
  return [...providers];
}

export function detectActiveSubscriptionProviders(comments = [], headSha = '', { minTimestampByProvider = {} } = {}) {
  const providers = new Set();
  for (const c of comments) {
    const provider = trustedSubscriptionProvider(c?.user);
    if (!provider) continue;
    const body = typeof c?.body === 'string' ? c.body : '';
    if (!headSha || !body.includes(headSha)) continue;
    const minTs = minTimestampByProvider[provider] || 0;
    const ts = Date.parse(c?.updated_at || c?.created_at || '');
    if (minTs > 0 && (!Number.isFinite(ts) || ts <= minTs)) continue;
    if (provider === 'codex' && (body.includes('codex-review-state:v1') || body.includes('ai-review-receipt:v1'))) {
      providers.add('codex');
    }
    if (provider === 'claude' && body.includes('ai-review-receipt:v1')) {
      providers.add('claude');
    }
  }
  return [...providers];
}

export function isLowRiskRoutinePr({ headRef = '', title = '', files = [] } = {}) {
  if (ROUTINE_BRANCH_RE.test(headRef)) return true;
  if (/^chore\(governance\):\s*bump/i.test(title)) return true;
  if (files.length > 0 && files.every(f => DOC_ONLY_PATH_RE.test(f.filename || ''))) return true;
  return false;
}

export function extractReferencedPaths(files, maxPaths = 3) {
  const changed = new Set(files.map(f => f.filename).filter(Boolean));
  const candidates = [];
  const seen = new Set();
  const addCandidate = (p) => {
    const clean = p.replace(/^\.\//, '').replace(/\/+/g, '/');
    if (!clean || changed.has(clean) || seen.has(clean)) return;
    seen.add(clean);
    candidates.push(clean);
  };

  for (const file of files) {
    const patch = file.patch || '';
    const dir = (file.filename || '').includes('/') ? file.filename.slice(0, file.filename.lastIndexOf('/')) : '';
    const pyMatches = patch.matchAll(/^[+-]\s*(?:from\s+([A-Za-z0-9_.]+)\s+import|import\s+([A-Za-z0-9_.]+))/gm);
    for (const m of pyMatches) {
      const mod = (m[1] || m[2] || '').trim();
      if (!mod || mod.startsWith('.')) continue;
      const rel = `${mod.replace(/\./g, '/')}.py`;
      addCandidate(rel);
      addCandidate(`src/${rel}`);
    }
    const jsMatches = patch.matchAll(/^[+-].*?(?:from|require\()\s*['"](\.[^'"]+)['"]/gm);
    for (const m of jsMatches) {
      const target = m[1];
      if (!target) continue;
      const joined = dir ? `${dir}/${target}` : target;
      const normalized = joined.split('/').reduce((acc, part) => {
        if (part === '.' || part === '') return acc;
        if (part === '..') { acc.pop(); return acc; }
        acc.push(part);
        return acc;
      }, []).join('/');
      if (/\.(?:mjs|js|ts|tsx|jsx)$/.test(normalized)) {
        addCandidate(normalized);
      } else {
        addCandidate(`${normalized}.mjs`);
        addCandidate(`${normalized}.ts`);
        addCandidate(`${normalized}.js`);
      }
    }
    if (candidates.length >= maxPaths) break;
  }
  return candidates.slice(0, maxPaths);
}

function formatDiffSection(file) {
  return `\n### ${file.filename} (${file.status}, +${file.additions}/-${file.deletions})\n\`\`\`diff\n${file.patch}\n\`\`\`\n`;
}

export function buildReviewBatches(files, { maxChars = 80000, maxBatches = 6 } = {}) {
  const batches = [];
  const allReviewableFiles = [];
  let currentText = '';
  let currentFiles = [];
  let truncated = false;

  for (const file of files) {
    if (!file.patch || SKIP_DIFF_PATH.test(file.filename || '')) continue;
    allReviewableFiles.push(file.filename);
    const section = formatDiffSection(file);

    if (section.length > maxChars) {
      truncated = true;
      if (currentText) {
        if (batches.length >= maxBatches) break;
        batches.push({ diffText: currentText, files: currentFiles });
        currentText = '';
        currentFiles = [];
      }
      if (batches.length >= maxBatches) break;
      batches.push({ diffText: section.slice(0, maxChars), files: [file.filename] });
      if (batches.length >= maxBatches) break;
      continue;
    }

    if (currentText && currentText.length + section.length > maxChars) {
      batches.push({ diffText: currentText, files: currentFiles });
      currentText = '';
      currentFiles = [];
      if (batches.length >= maxBatches) {
        truncated = true;
        break;
      }
    }

    currentText += section;
    currentFiles.push(file.filename);
  }

  if (currentText && batches.length < maxBatches) {
    batches.push({ diffText: currentText, files: currentFiles });
  } else if (currentText) {
    truncated = true;
  }

  return { batches, allReviewableFiles, truncated };
}

export function buildReviewDiff(files, maxChars = 60000) {
  const { batches, truncated } = buildReviewBatches(files, { maxChars, maxBatches: 1 });
  const first = batches[0];
  return {
    diffText: first ? first.diffText : '',
    truncated,
    includedFiles: first ? first.files : [],
  };
}

export function shouldSkipPrState(pr, { allowDraft = false } = {}) {
  if (!pr || pr.state !== 'open') return true;
  if (pr.draft && !allowDraft) return true;
  return false;
}

export function shouldTriggerNow({ eventName, action, commentBody, mentionHandle }) {
  if (eventName === 'pull_request') {
    return ['opened', 'synchronize', 'reopened', 'ready_for_review'].includes(action);
  }
  if (eventName === 'issue_comment' && action === 'created') {
    if (mentionHandle && typeof commentBody === 'string' && commentBody.includes(mentionHandle)) return true;
    return false;
  }
  return false;
}

export function planPullRequestWebhook({ eventName, payload, mentionHandle, fallbackWaitMinutes = 12 }) {
  const installationId = payload?.installation?.id;
  const owner = payload?.repository?.owner?.login;
  const repo = payload?.repository?.name;
  if (!installationId || !owner || !repo) {
    return { action: 'ignore', reason: 'Ignored' };
  }

  const defaultImmediate = Number(fallbackWaitMinutes ?? 12) === 0;

  if (eventName === 'pull_request' && shouldTriggerNow({ eventName, action: payload?.action })) {
    if (payload?.pull_request?.draft) {
      return { action: 'ignore', reason: 'Draft skipped' };
    }
    const prNumber = payload?.pull_request?.number;
    const headSha = payload?.pull_request?.head?.sha;
    if (!prNumber || !headSha) {
      return { action: 'ignore', reason: 'Missing PR head' };
    }
    const immediate = defaultImmediate || isLowRiskRoutinePr({
      headRef: payload?.pull_request?.head?.ref || '',
      title: payload?.pull_request?.title || '',
    });
    return {
      action: 'dispatch',
      source: 'pull_request',
      owner,
      repo,
      installationId,
      prNumber,
      headSha,
      immediate,
      allowDraft: false,
    };
  }

  if (eventName === 'issue_comment' && payload?.action === 'created' && payload?.issue?.pull_request) {
    const body = payload?.comment?.body || '';
    const login = payload?.comment?.user?.login || '';
    const mentioned = shouldTriggerNow({
      eventName,
      action: payload.action,
      commentBody: body,
      mentionHandle: mentionHandle || '@ai-reviewer review',
    });
    if (!mentioned && !isCodexQuotaComment(body, login)) {
      return { action: 'ignore', reason: 'Comment ignored' };
    }
    return {
      action: 'fetch_and_dispatch',
      source: 'issue_comment',
      owner,
      repo,
      installationId,
      prNumber: payload.issue.number,
      commentId: payload?.comment?.id,
      immediate: true,
      forceProvider: Boolean(mentioned),
      allowDraft: Boolean(mentioned),
    };
  }

  return { action: 'ignore', reason: 'Event ignored' };
}

