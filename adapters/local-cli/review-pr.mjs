#!/usr/bin/env node
// Mac mini / local-cli adapter for private repositories.
// Uses the private dedicated GitHub App (local-ai-reviewer[bot]) and DeepSeek API
// (or opencode CLI when --opencode is passed) to post ai-review-receipt:v1.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createAppJwt } from '../../packages/review-core/crypto.mjs';
import { getInstallationToken, fetchPrContext, postPrComment } from '../../packages/review-core/github.mjs';
import { hasReceiptForHead, buildReviewDiff } from '../../packages/review-core/policy.mjs';
import { buildReviewMessages, parseVerdict, runDeepSeekReview } from '../../packages/review-core/provider.mjs';
import { formatReceiptComment } from '../../packages/review-core/receipt.mjs';

function parseArgs(argv) {
  const args = { opencode: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') args.repo = argv[++i];
    else if (a === '--pr') args.pr = Number(argv[++i]);
    else if (a === '--opencode') args.opencode = true;
    else if (a === '--dry-run') args.dryRun = true;
  }
  if (!args.repo || !args.repo.includes('/') || !args.pr) {
    throw new Error('Usage: review-pr.mjs --repo <owner/name> --pr <number> [--opencode] [--dry-run]');
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [owner, repo] = args.repo.split('/');
  const appId = process.env.LOCAL_REVIEWER_APP_ID;
  const installationId = process.env.LOCAL_REVIEWER_INSTALLATION_ID;
  const keyPath = process.env.LOCAL_REVIEWER_PRIVATE_KEY_PATH;
  const keyPem = process.env.LOCAL_REVIEWER_PRIVATE_KEY || (keyPath ? readFileSync(keyPath, 'utf8') : '');
  if (!appId || !installationId || !keyPem) {
    throw new Error('Set LOCAL_REVIEWER_APP_ID, LOCAL_REVIEWER_INSTALLATION_ID, and LOCAL_REVIEWER_PRIVATE_KEY(_PATH)');
  }

  const jwt = await createAppJwt(appId, keyPem);
  const token = await getInstallationToken(jwt, installationId);
  const ctx = await fetchPrContext(owner, repo, args.pr, token);
  const headSha = ctx.pr.head.sha;

  if (hasReceiptForHead(ctx.comments, headSha)) {
    console.log(`PR #${args.pr} (${headSha.slice(0, 7)}) already has an AI review receipt.`);
    return;
  }

  const { diffText, truncated } = buildReviewDiff(ctx.files);
  const messages = buildReviewMessages({ pr: ctx.pr, diffText, truncated, agentsMd: ctx.agentsMd });

  let verdict;
  let provider = 'deepseek';
  let model = process.env.AI_REVIEW_MODEL || 'deepseek-chat';

  if (args.opencode) {
    provider = 'opencode';
    const prompt = `${messages.system}\n\n${messages.user}`;
    const out = execFileSync('opencode', ['run', '--format', 'json', prompt], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    verdict = parseVerdict(out);
  } else {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) throw new Error('Missing DEEPSEEK_API_KEY');
    verdict = await runDeepSeekReview({
      apiKey,
      baseUrl: process.env.AI_REVIEW_BASE_URL,
      model,
      messages,
    });
  }

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
