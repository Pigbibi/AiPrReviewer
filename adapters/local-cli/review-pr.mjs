#!/usr/bin/env node
// Mac mini / local-cli adapter for private repositories.
// Posts a DeepSeek receipt with the private GitHub App. Codex and Claude are
// the subscription reviewers; this command does nothing while either flag is on.

import { readFileSync } from 'node:fs';
import { createPrivateKey } from 'node:crypto';
import { createAppJwt } from '../../packages/review-core/crypto.mjs';
import { getInstallationToken, fetchPrContext, fetchRepoFile, postPrComment } from '../../packages/review-core/github.mjs';
import { hasReceiptForHead, extractReferencedPaths, buildReviewDiff } from '../../packages/review-core/policy.mjs';
import { buildReviewMessages, runDeepSeekReview } from '../../packages/review-core/provider.mjs';
import { formatReceiptComment } from '../../packages/review-core/receipt.mjs';
import { flagsFromEnv, selectReviewRoute } from '../../packages/review-core/route.mjs';

function normalizePrivateKeyPem(pem) {
  const text = String(pem || '');
  if (text.includes('BEGIN PRIVATE KEY')) return text;
  return createPrivateKey(text).export({ type: 'pkcs8', format: 'pem' }).toString();
}

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') args.repo = argv[++i];
    else if (a === '--pr') args.pr = Number(argv[++i]);
    else if (a === '--dry-run') args.dryRun = true;
  }
  if (!args.repo || !args.repo.includes('/') || !args.pr) {
    throw new Error('Usage: review-pr.mjs --repo <owner/name> --pr <number> [--dry-run]');
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [owner, repo] = args.repo.split('/');
  const appId = process.env.LOCAL_REVIEWER_APP_ID;
  const installationId = process.env.LOCAL_REVIEWER_INSTALLATION_ID;
  const keyPath = process.env.LOCAL_REVIEWER_PRIVATE_KEY_PATH;
  const rawPem = process.env.LOCAL_REVIEWER_PRIVATE_KEY || (keyPath ? readFileSync(keyPath, 'utf8') : '');
  if (!appId || !installationId || !rawPem) {
    throw new Error('Set LOCAL_REVIEWER_APP_ID, LOCAL_REVIEWER_INSTALLATION_ID, and LOCAL_REVIEWER_PRIVATE_KEY(_PATH)');
  }

  const keyPem = normalizePrivateKeyPem(rawPem);
  const jwt = await createAppJwt(appId, keyPem);
  const token = await getInstallationToken(jwt, installationId);
  const ctx = await fetchPrContext(owner, repo, args.pr, token);
  const headSha = ctx.pr.head.sha;

  if (hasReceiptForHead(ctx.comments, headSha)) {
    console.log(`PR #${args.pr} (${headSha.slice(0, 7)}) already has an AI review receipt.`);
    return;
  }
  const route = selectReviewRoute(flagsFromEnv(process.env));
  if (route.kind !== 'deepseek') {
    console.log(`Subscription reviewer is enabled (${route.providers.join(', ')}); DeepSeek was not called.`);
    return;
  }

  const { diffText, truncated, includedFiles } = buildReviewDiff(ctx.files);
  const refPaths = extractReferencedPaths(ctx.files, 3);
  const relatedFiles = [];
  for (const relPath of refPaths) {
    const content = await fetchRepoFile(owner, repo, relPath, headSha, token);
    if (content) relatedFiles.push({ path: relPath, content });
  }
  const messages = buildReviewMessages({
    pr: ctx.pr,
    diffText,
    truncated,
    agentsMd: ctx.agentsMd,
    relatedFiles,
    allFiles: includedFiles,
  });

  const model = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('Missing DEEPSEEK_API_KEY');
  const verdict = await runDeepSeekReview({
    apiKey,
    baseUrl: process.env.DEEPSEEK_BASE_URL,
    model,
    messages,
  });
  const provider = 'deepseek';

  const body = formatReceiptComment({ headSha, provider, model, verdict, truncated });
  if (args.dryRun) {
    console.log(body);
    return;
  }
  await postPrComment(owner, repo, args.pr, body, token);
  console.log(`Posted ${provider} receipt for ${args.repo}#${args.pr} at ${headSha.slice(0, 7)}`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
