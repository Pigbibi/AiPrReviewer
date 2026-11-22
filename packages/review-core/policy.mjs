// Pure routing, diff trimming, and receipt detection for review-core.

export const RECEIPT_MARKERS = [
  'ai-review-receipt:v1',
  'codex-review-receipt:v1',
  'codex-review-state:v1',
];

export const QUOTA_PATTERN = /\b(?:usage\s+limit|rate\s*limit|quota\s+(?:exceeded|reached|exhausted)|out\s+of\s+credits?|limit\s+reached|try\s+again\s+later)\b|额度已用完|达到上限/i;

const SKIP_DIFF_PATH = /(?:^|\/)(?:package-lock\.json|uv\.lock|poetry\.lock|yarn\.lock|pnpm-lock\.yaml|cargo\.lock|gemfile\.lock)$|(?:^|\/)fixtures(?:\/|$)/i;

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
