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

export function hasReceiptForHead(comments, headSha) {
  return comments.some(c =>
    typeof c.body === 'string'
    && c.body.includes(headSha)
    && RECEIPT_MARKERS.some(m => c.body.includes(m))
  );
}

export function isCodexQuotaComment(body, userLogin = '') {
  return /codex/i.test(userLogin) && typeof body === 'string' && QUOTA_PATTERN.test(body);
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

export function buildReviewDiff(files, maxChars = 60000) {
  let diffText = '';
  let truncated = false;
  const includedFiles = [];
  for (const file of files) {
    if (!file.patch || SKIP_DIFF_PATH.test(file.filename || '')) continue;
    const section = `\n### ${file.filename} (${file.status}, +${file.additions}/-${file.deletions})\n\`\`\`diff\n${file.patch}\n\`\`\`\n`;
    if (diffText.length + section.length > maxChars) {
      truncated = true;
      break;
    }
    diffText += section;
    includedFiles.push(file.filename);
  }
  return { diffText, truncated, includedFiles };
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
