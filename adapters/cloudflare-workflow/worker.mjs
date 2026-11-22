// Cloudflare Worker + Cloudflare Workflows adapter for AiPrReviewer.
// Uses Workflow steps so network I/O (DeepSeek API) consumes 0ms CPU and is not
// limited by Workers Free 30s waitUntil wall-clock timeout.

import { WorkflowEntrypoint } from 'cloudflare:workers';
import { verifyWebhookSignature, createAppJwt } from '../../packages/review-core/crypto.mjs';
import { getInstallationToken, fetchPrContext, postPrComment } from '../../packages/review-core/github.mjs';
import { hasReceiptForHead, isCodexQuotaComment, buildReviewDiff, shouldTriggerNow } from '../../packages/review-core/policy.mjs';
import { buildReviewMessages, runDeepSeekReview } from '../../packages/review-core/provider.mjs';
import { formatReceiptComment } from '../../packages/review-core/receipt.mjs';

export class PrReviewWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { owner, repo, prNumber, installationId, headSha, immediate } = event.payload;
    const waitMinutes = Number(this.env.FALLBACK_WAIT_MINUTES ?? '12');

    if (!immediate && waitMinutes > 0) {
      await step.sleep('wait-for-primary-reviewer', `${waitMinutes} minutes`);
    }

    const reviewContext = await step.do('fetch-pr-context', async () => {
      const jwt = await createAppJwt(this.env.GITHUB_APP_ID, this.env.GITHUB_APP_PRIVATE_KEY);
      const token = await getInstallationToken(jwt, installationId);
      const ctx = await fetchPrContext(owner, repo, prNumber, token);
      if (ctx.pr.state !== 'open' || ctx.pr.draft) return { skip: true, reason: 'closed_or_draft' };
      if (ctx.pr.head.sha !== headSha) return { skip: true, reason: 'stale_head' };
      if (hasReceiptForHead(ctx.comments, headSha)) return { skip: true, reason: 'already_reviewed' };
      const { diffText, truncated } = buildReviewDiff(ctx.files);
      if (!diffText) return { skip: true, reason: 'empty_diff' };
      return {
        skip: false,
        messages: buildReviewMessages({ pr: ctx.pr, diffText, truncated, agentsMd: ctx.agentsMd }),
        truncated,
      };
    });

    if (reviewContext.skip) {
      return { status: 'skipped', reason: reviewContext.reason };
    }

    const verdict = await step.do('call-deepseek-api', async () => {
      return runDeepSeekReview({
        apiKey: this.env.AI_API_KEY || this.env.DEEPSEEK_API_KEY || this.env.GEMINI_API_KEY,
        baseUrl: this.env.AI_REVIEW_BASE_URL,
        model: this.env.AI_REVIEW_MODEL || 'gemini-2.5-flash',
        messages: reviewContext.messages,
      });
    });

    await step.do('post-receipt-comment', async () => {
      const jwt = await createAppJwt(this.env.GITHUB_APP_ID, this.env.GITHUB_APP_PRIVATE_KEY);
      const token = await getInstallationToken(jwt, installationId);
      const body = formatReceiptComment({
        headSha,
        provider: this.env.AI_REVIEW_PROVIDER || 'deepseek',
        model: this.env.AI_REVIEW_MODEL || 'deepseek-chat',
        verdict,
        truncated: reviewContext.truncated,
      });
      await postPrComment(owner, repo, prNumber, body, token);
    });

    return { status: 'reviewed', headSha, unresolved: verdict.unresolved_findings };
  }
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
    const rawBody = await request.text();
    const sig = request.headers.get('X-Hub-Signature-256') || '';
    if (!(await verifyWebhookSignature(rawBody, sig, env.GITHUB_WEBHOOK_SECRET))) {
      return new Response('Invalid signature', { status: 401 });
    }

    const eventName = request.headers.get('X-GitHub-Event') || '';
    const payload = JSON.parse(rawBody);
    const installationId = payload.installation?.id;
    const owner = payload.repository?.owner?.login;
    const repo = payload.repository?.name;
    if (!installationId || !owner || !repo) return new Response('Ignored', { status: 202 });

    let prNumber = null;
    let headSha = null;
    let immediate = Number(env.FALLBACK_WAIT_MINUTES ?? '12') === 0;

    if (eventName === 'pull_request' && shouldTriggerNow({ eventName, action: payload.action })) {
      if (payload.pull_request?.draft) return new Response('Draft skipped', { status: 202 });
      prNumber = payload.pull_request?.number;
      headSha = payload.pull_request?.head?.sha;
    } else if (eventName === 'issue_comment' && payload.action === 'created' && payload.issue?.pull_request) {
      const body = payload.comment?.body || '';
      const login = payload.comment?.user?.login || '';
      const mentioned = shouldTriggerNow({
        eventName,
        action: payload.action,
        commentBody: body,
        mentionHandle: env.REVIEW_MENTION_HANDLE || '@ai-reviewer review',
      });
      if (!mentioned && !isCodexQuotaComment(body, login)) {
        return new Response('Comment ignored', { status: 202 });
      }
      immediate = true;
      prNumber = payload.issue.number;
      const jwt = await createAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
      const token = await getInstallationToken(jwt, installationId);
      const ctx = await fetchPrContext(owner, repo, prNumber, token);
      headSha = ctx.pr.head.sha;
    } else {
      return new Response('Event ignored', { status: 202 });
    }

    if (!prNumber || !headSha) return new Response('Missing PR head', { status: 202 });
    const instanceId = `${owner}-${repo}-${prNumber}-${headSha.slice(0, 12)}`.replace(/[^A-Za-z0-9_-]/g, '_');
    await env.PR_REVIEW_WORKFLOW.create({
      id: instanceId,
      params: { owner, repo, prNumber, installationId, headSha, immediate },
    });

    return Response.json({ accepted: true, instanceId }, { status: 202 });
  },
};
