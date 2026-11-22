import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyWebhookSignature, createAppJwt } from '../packages/review-core/crypto.mjs';
import { hasReceiptForHead, isCodexQuotaComment, buildReviewDiff, shouldTriggerNow } from '../packages/review-core/policy.mjs';
import { parseVerdict, runDeepSeekReview, buildReviewMessages } from '../packages/review-core/provider.mjs';
import { formatReceiptComment } from '../packages/review-core/receipt.mjs';

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
