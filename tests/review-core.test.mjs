import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyWebhookSignature, createAppJwt, getGcpAccessToken } from '../packages/review-core/crypto.mjs';
import {
  hasReceiptForHead,
  isCodexRunningForHead,
  isCodexQuotaComment,
  detectQuotaProviders,
  detectActiveSubscriptionProviders,
  isLowRiskRoutinePr,
  extractReferencedPaths,
  buildReviewDiff,
  buildReviewBatches,
  shouldTriggerNow,
  shouldSkipPrState,
  planPullRequestWebhook,
} from '../packages/review-core/policy.mjs';
import {
  parseVerdict,
  runDeepSeekReview,
  runAiServiceReview,
  buildReviewMessages,
  executeReviewWithFallback,
  mergeBatchVerdicts,
} from '../packages/review-core/provider.mjs';
import { formatReceiptComment } from '../packages/review-core/receipt.mjs';
import {
  flagsFromEnv,
  selectAdaptiveRoute,
  updateCircuitState,
} from '../packages/review-core/route.mjs';

test('verifyWebhookSignature validates real HMAC-SHA256 and rejects tampered payloads', async () => {
  const secret = 'synthetic-webhook-secret';
  const body = JSON.stringify({ action: 'opened' });
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  const header = 'sha256=' + Array.from(sig, b => b.toString(16).padStart(2, '0')).join('');
  assert.equal(await verifyWebhookSignature(body, header, secret), true);
  assert.equal(await verifyWebhookSignature(body + ' ', header, secret), false);
  assert.equal(await verifyWebhookSignature(body, 'sha256=' + '0'.repeat(64), secret), false);
});

test('createAppJwt produces 3-part RS256 JWT with iss and exp', async () => {
  const kp = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  let b64 = '';
  for (let i = 0; i < pkcs8.length; i++) b64 += String.fromCharCode(pkcs8[i]);
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(b64)}\n-----END PRIVATE KEY-----`;
  const jwt = await createAppJwt('12345', pem, 1700000000);
  const parts = jwt.split('.');
  assert.equal(parts.length, 3);
  const claims = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
  assert.equal(claims.iss, '12345');
  assert.equal(claims.exp, 1700000540);
});

test('policy helpers detect receipts, codex quota, trigger events, and skip lockfiles/fixtures', () => {
  const head = 'a'.repeat(40);
  assert.equal(hasReceiptForHead([{ body: `<!-- ai-review-receipt:v1 {"review":{"commit_sha":"${head}"}} -->` }], head), true);
  assert.equal(hasReceiptForHead([{ body: 'unrelated' }], head), false);
  assert.equal(isCodexQuotaComment('Usage limit reached. Try again later.', 'chatgpt-codex-connector[bot]'), true);
  assert.equal(isCodexQuotaComment('Usage limit reached.', 'random-user'), false);
  assert.equal(shouldTriggerNow({ eventName: 'pull_request', action: 'opened' }), true);
  assert.equal(shouldTriggerNow({ eventName: 'issue_comment', action: 'created', commentBody: '@qsl-ai-reviewer review', mentionHandle: '@qsl-ai-reviewer review' }), true);

  const { diffText, includedFiles } = buildReviewDiff([
    { filename: 'uv.lock', status: 'modified', additions: 500, deletions: 0, patch: '+lock' },
    { filename: 'tests/fixtures/a.json', status: 'modified', additions: 50, deletions: 0, patch: '+fix' },
    { filename: 'src/app.py', status: 'modified', additions: 3, deletions: 1, patch: '+x = 1' },
  ]);
  assert.deepEqual(includedFiles, ['src/app.py']);
  assert.match(diffText, /src\/app\.py/);
});

test('provider and receipt formatter produce valid ai-review-receipt:v1', async () => {
  const verdict = parseVerdict('```json\n{"summary":"Clean","unresolved_findings":false,"findings":[]}\n```');
  assert.equal(verdict.unresolved_findings, false);
  const head = 'b'.repeat(40);
  const comment = formatReceiptComment({ headSha: head, provider: 'deepseek', model: 'deepseek-chat', verdict });
  assert.match(comment, /<!-- ai-review-receipt:v1 /);
  assert.match(comment, /"provider":"deepseek"/);
  assert.match(comment, new RegExp(head));

  const messages = buildReviewMessages({ pr: { number: 1, title: 'fix', body: '' }, diffText: '+a', truncated: false, agentsMd: '' });
  const apiVerdict = await runDeepSeekReview(
    { apiKey: 'sk-synthetic', messages },
    async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"summary":"OK","unresolved_findings":false,"findings":[]}' } }] }) })
  );
  assert.equal(apiVerdict.summary, 'OK');
});

test('routine PR routing, referenced-file extraction, and AIService bridge work as expected', async () => {
  assert.equal(isLowRiskRoutinePr({ headRef: 'chore/bump-pr-governance' }), true);
  assert.equal(isLowRiskRoutinePr({ headRef: 'feat/risk-engine', files: [{ filename: 'README.md' }] }), true);
  assert.equal(isLowRiskRoutinePr({ headRef: 'feat/risk-engine', files: [{ filename: 'src/risk.py' }] }), false);

  const refs = extractReferencedPaths([
    { filename: 'src/app/service.py', patch: '+from app.repo import Store\n+from .helper import run\n' },
    { filename: 'src/web/index.mjs', patch: "+import { helper } from './utils.mjs'\n" },
  ]);
  assert.ok(refs.includes('app/repo.py'));
  assert.ok(refs.includes('src/web/utils.mjs'));

  const msgs = buildReviewMessages({
    pr: { number: 7, title: 'feat: risk', body: '' },
    diffText: '+x',
    truncated: false,
    agentsMd: '',
    relatedFiles: [{ path: 'src/web/utils.mjs', content: 'export const x = 1;' }],
  });
  assert.match(msgs.user, /Related Referenced Files/);
  assert.match(msgs.user, /src\/web\/utils\.mjs/);
  assert.doesNotMatch(msgs.user, /High-Risk Security Checklist/);

  const secMsgs = buildReviewMessages({
    pr: { number: 8, title: 'ci: tighten workflow', body: '' },
    diffText: 'diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml\n+permissions: read-all',
    truncated: false,
    agentsMd: '',
    allFiles: ['.github/workflows/ci.yml'],
  });
  assert.match(secMsgs.user, /High-Risk Security Checklist/);
  assert.match(secMsgs.user, /\.github\/workflows\/ci\.yml/);

  const bridgeVerdict = await runAiServiceReview(
    { serviceUrl: 'https://ai.example.test', serviceToken: 'tok', project: 'Org/Repo', pr: { number: 7, title: 'feat: risk' }, messages: msgs },
    async () => ({ ok: true, json: async () => ({ result: { output: '{"summary":"Bridge OK","unresolved_findings":false,"findings":[]}' } }) })
  );
  assert.equal(bridgeVerdict.summary, 'Bridge OK');
});

test('getGcpAccessToken exchanges signed RS256 assertion for OAuth2 token', async () => {
  const kp = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  let b64 = '';
  for (let i = 0; i < pkcs8.length; i++) b64 += String.fromCharCode(pkcs8[i]);
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(b64)}\n-----END PRIVATE KEY-----`;
  const sa = {
    project_id: 'synthetic-proj',
    client_email: 'reviewer@synthetic-proj.iam.gserviceaccount.com',
    private_key: pem,
  };
  let capturedBody = '';
  const out = await getGcpAccessToken(sa, async (_url, opts) => {
    capturedBody = opts.body;
    return { ok: true, json: async () => ({ access_token: 'ya29.synthetic' }) };
  }, 1700000000);
  assert.equal(out.accessToken, 'ya29.synthetic');
  assert.equal(out.projectId, 'synthetic-proj');
  assert.match(capturedBody, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer/);
});

test('hasReceiptForHead distinguishes running vs completed codex-review-state markers', () => {
  const head = 'c'.repeat(40);
  const runningComment = {
    body: `<!-- codex-review-state:v1 {"code_review":{"commit_sha":"${head}","has_any_findings":null,"has_unresolved_findings":null,"status":"running"}} -->`,
  };
  const completedComment = {
    body: `<!-- codex-review-state:v1 {"code_review":{"commit_sha":"${head}","has_any_findings":false,"has_unresolved_findings":false,"status":"completed"}} -->`,
  };
  assert.equal(isCodexRunningForHead([runningComment], head), true);
  assert.equal(hasReceiptForHead([runningComment], head), false);
  assert.equal(isCodexRunningForHead([completedComment], head), false);
  assert.equal(hasReceiptForHead([completedComment], head), true);
});

test('buildReviewBatches chunks large diffs cleanly and never skips executable generated files', () => {
  const mkFile = (filename, size) => ({
    filename,
    status: 'modified',
    additions: 10,
    deletions: 2,
    patch: '+' + 'x'.repeat(size),
  });
  const res = buildReviewBatches(
    [
      mkFile('src/a.py', 90),
      mkFile('uv.lock', 5000),
      mkFile('frontend/src/catalog/small.generated.js', 60),
      mkFile('src/b.py', 90),
      mkFile('src/c.py', 90),
    ],
    { maxChars: 170, maxBatches: 6 }
  );
  assert.equal(res.truncated, false);
  assert.deepEqual(res.allReviewableFiles, [
    'src/a.py',
    'frontend/src/catalog/small.generated.js',
    'src/b.py',
    'src/c.py',
  ]);
  assert.equal(res.batches.length, 4);

  const capped = buildReviewBatches(
    [mkFile('src/a.py', 90), mkFile('src/b.py', 90), mkFile('src/c.py', 90)],
    { maxChars: 170, maxBatches: 2 }
  );
  assert.equal(capped.truncated, true);
  assert.equal(capped.batches.length, 2);

  const oversized = buildReviewBatches([mkFile('src/giant.py', 250)], { maxChars: 170, maxBatches: 2 });
  assert.equal(oversized.truncated, true);
  assert.equal(oversized.batches.length, 1);

  const oversizedAtCap = buildReviewBatches(
    [mkFile('src/giant1.py', 250), mkFile('src/giant2.py', 250), mkFile('src/small1.py', 50), mkFile('src/small2.py', 50)],
    { maxChars: 170, maxBatches: 2 }
  );
  assert.equal(oversizedAtCap.truncated, true);
  assert.equal(oversizedAtCap.batches.length, 2);
});

test('executeReviewWithFallback calls DeepSeek and ignores Gemini credentials', async () => {
  const messages = buildReviewMessages({
    pr: { number: 9, title: 'refactor: split', body: '' },
    diffText: '+a',
    truncated: false,
    agentsMd: '',
    batchIndex: 0,
    totalBatches: 2,
    allFiles: ['a.py', 'b.py'],
  });
  assert.match(messages.user, /Review Batch 1\/2/);

  const baseEnv = {
    AI_REVIEW_PROVIDER: 'opencode',
    AI_REVIEW_MODEL: 'google/gemini-4-hydrogen',
    GEMINI_API_KEY: 'gemini-unused',
    GCP_SERVICE_ACCOUNT_JSON: '{"project_id":"synthetic"}',
    DEEPSEEK_API_KEY: 'sk-ds-fallback',
  };
  const calls = [];
  const primaryOk = await executeReviewWithFallback(
    {
      env: baseEnv,
      project: 'Org/Repo',
      pr: { number: 9, title: 'refactor: split' },
      messages,
      getGcpToken: async () => ({ accessToken: 'gcp-tok', projectId: 'synthetic-proj' }),
    },
    async (url, opts) => {
      calls.push({ url, model: JSON.parse(opts.body).model });
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"summary":"DeepSeek OK","unresolved_findings":false,"findings":[]}' } }] }),
      };
    }
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(calls[0].model, 'deepseek-chat');
  assert.equal(primaryOk.provider, 'deepseek');
  assert.equal(primaryOk.model, 'deepseek-chat');

  const fallbackOk = await executeReviewWithFallback(
    {
      env: baseEnv,
      project: 'Org/Repo',
      pr: { number: 9, title: 'refactor: split' },
      messages,
    },
    async (url, opts) => {
      assert.equal(url, 'https://api.deepseek.com/chat/completions');
      assert.equal(JSON.parse(opts.body).model, 'deepseek-chat');
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"summary":"DeepSeek findings","unresolved_findings":true,"findings":[{"severity":"medium","file":"a.py","message":"bug"}]}' } }] }),
      };
    }
  );
  assert.equal(fallbackOk.provider, 'deepseek');
  assert.equal(fallbackOk.model, 'deepseek-chat');

  const merged = mergeBatchVerdicts([primaryOk, fallbackOk]);
  assert.equal(merged.verdict.unresolved_findings, true);
  assert.equal(merged.verdict.findings.length, 1);
  assert.equal(merged.provider, 'deepseek');
});

test('shouldSkipPrState and planPullRequestWebhook support mention-triggered drafts while skipping auto drafts', () => {
  assert.equal(shouldSkipPrState({ state: 'open', draft: false }), false);
  assert.equal(shouldSkipPrState({ state: 'open', draft: true }), true);
  assert.equal(shouldSkipPrState({ state: 'open', draft: true }, { allowDraft: true }), false);
  assert.equal(shouldSkipPrState({ state: 'closed', draft: true }, { allowDraft: true }), true);
  assert.equal(shouldSkipPrState({ state: 'closed', draft: false }, { allowDraft: true }), true);

  const autoDraft = planPullRequestWebhook({
    eventName: 'pull_request',
    payload: {
      action: 'opened',
      installation: { id: 1 },
      repository: { owner: { login: 'Org' }, name: 'Repo' },
      pull_request: { number: 3, draft: true, head: { sha: 'd'.repeat(40), ref: 'feat/x' }, title: 't' },
    },
    mentionHandle: '@qsl-ai-reviewer review',
  });
  assert.deepEqual(autoDraft, { action: 'ignore', reason: 'Draft skipped' });

  const mentionDraft = planPullRequestWebhook({
    eventName: 'issue_comment',
    payload: {
      action: 'created',
      installation: { id: 1 },
      repository: { owner: { login: 'Org' }, name: 'Repo' },
      issue: { number: 3, pull_request: {} },
      comment: { id: 99, body: '@qsl-ai-reviewer review', user: { login: 'maintainer' } },
    },
    mentionHandle: '@qsl-ai-reviewer review',
  });
  assert.equal(mentionDraft.action, 'fetch_and_dispatch');
  assert.equal(mentionDraft.immediate, true);
  assert.equal(mentionDraft.allowDraft, true);

  const codexQuota = planPullRequestWebhook({
    eventName: 'issue_comment',
    payload: {
      action: 'created',
      installation: { id: 1 },
      repository: { owner: { login: 'Org' }, name: 'Repo' },
      issue: { number: 4, pull_request: {} },
      comment: { id: 100, body: 'Usage limit reached.', user: { login: 'chatgpt-codex-connector[bot]' } },
    },
    mentionHandle: '@qsl-ai-reviewer review',
  });
  assert.equal(codexQuota.action, 'fetch_and_dispatch');
  assert.equal(codexQuota.allowDraft, false);
});

test('adaptive circuit breaker routes automatically without manual switches', () => {
  const now = 1_700_000_000_000;
  const autoFlags = flagsFromEnv({});
  assert.equal(autoFlags.codexMode, 'auto');
  assert.equal(autoFlags.claudeMode, 'auto');

  const initial = selectAdaptiveRoute({ ...autoFlags, circuitState: {}, now });
  assert.equal(initial.kind, 'subscription');
  assert.deepEqual(initial.providers, ['codex', 'claude']);
  assert.deepEqual(initial.autoProbed, ['codex', 'claude']);

  const cooled = updateCircuitState({}, { inactiveProviders: ['codex', 'claude'], now });
  const fastDeepSeek = selectAdaptiveRoute({ ...autoFlags, circuitState: cooled, now: now + 60_000 });
  assert.equal(fastDeepSeek.kind, 'deepseek');
  assert.deepEqual(fastDeepSeek.providers, ['deepseek']);

  const afterCooldown = selectAdaptiveRoute({
    ...autoFlags,
    circuitState: cooled,
    now: now + 7 * 60 * 60 * 1000,
  });
  assert.equal(afterCooldown.kind, 'subscription');

  const reactivated = updateCircuitState(cooled, { activeProviders: ['claude'], now });
  const claudeOnly = selectAdaptiveRoute({ ...autoFlags, circuitState: reactivated, now: now + 60_000 });
  assert.equal(claudeOnly.kind, 'subscription');
  assert.deepEqual(claudeOnly.providers, ['claude']);

  const head = 'a'.repeat(40);
  const comments = [
    { user: { login: 'claude[bot]' }, body: `<!-- ai-review-receipt:v1 {"review":{"commit_sha":"${head}","status":"completed"}} -->` },
    { user: { login: 'chatgpt-codex-connector[bot]' }, body: 'Usage limit reached. Try again later.' },
    { user: { login: 'fake-claude-user' }, body: 'Usage limit reached. Try again later.' },
  ];
  assert.deepEqual(detectActiveSubscriptionProviders(comments, head), ['claude']);
  assert.deepEqual(detectQuotaProviders(comments), ['codex']);
});
