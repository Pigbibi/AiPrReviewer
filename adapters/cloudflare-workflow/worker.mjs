// Cloudflare Worker + Cloudflare Workflows adapter for AiPrReviewer.
// Uses Workflow steps so network I/O (DeepSeek API) consumes 0ms CPU and is not
// limited by Workers Free 30s waitUntil wall-clock timeout.

import { WorkflowEntrypoint } from 'cloudflare:workers';
import { verifyWebhookSignature, createAppJwt } from '../../packages/review-core/crypto.mjs';
import { getInstallationToken, fetchPrContext, fetchRepoFile, postPrComment } from '../../packages/review-core/github.mjs';
import {
  hasReceiptForHead,
  isReviewInProgressForHead,
  detectQuotaProviders,
  detectActiveSubscriptionProviders,
  extractReferencedPaths,
  buildReviewBatches,
  shouldSkipPrState,
  planPullRequestWebhook,
} from '../../packages/review-core/policy.mjs';
import {
  buildReviewMessages,
  executeReviewWithFallback,
  mergeBatchVerdicts,
} from '../../packages/review-core/provider.mjs';
import { flagsFromEnv, selectAdaptiveRoute, updateCircuitState } from '../../packages/review-core/route.mjs';
import { formatReceiptComment } from '../../packages/review-core/receipt.mjs';

async function loadCircuitState(env, owner) {
  if (!env?.ROUTE_STATE_KV) return {};
  try {
    const [codex, claude] = await Promise.all([
      env.ROUTE_STATE_KV.get(`route:v1:${owner}:codex`, 'json'),
      env.ROUTE_STATE_KV.get(`route:v1:${owner}:claude`, 'json'),
    ]);
    return {
      ...(codex ? { codex } : {}),
      ...(claude ? { claude } : {}),
    };
  } catch {
    return {};
  }
}

async function saveProviderStates(env, owner, updates) {
  if (!env?.ROUTE_STATE_KV) return;
  try {
    await Promise.all(
      Object.entries(updates).map(([provider, entry]) =>
        env.ROUTE_STATE_KV.put(`route:v1:${owner}:${provider}`, JSON.stringify(entry), {
          expirationTtl: 7 * 24 * 60 * 60,
        })
      )
    );
  } catch {
    // Non-fatal: KV write failure must not block PR review.
  }
}

export class PrReviewWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const {
      owner,
      repo,
      prNumber,
      installationId,
      headSha,
      immediate,
      allowDraft = false,
    } = event.payload;
    const waitMinutes = Number(this.env.FALLBACK_WAIT_MINUTES ?? '12');
    const probeMinutes = Math.min(waitMinutes, Number(this.env.CODEX_PROBE_MINUTES ?? '2'));
    const flags = flagsFromEnv(this.env);
    const circuitState = await step.do('load-route-state', () => loadCircuitState(this.env, owner));
    const route = selectAdaptiveRoute({
      codexMode: flags.codexMode,
      claudeMode: flags.claudeMode,
      circuitState,
    });

    if (!immediate && route.kind === 'subscription' && waitMinutes > 0) {
      if (probeMinutes > 0) {
        await step.sleep('probe-primary-reviewer', `${probeMinutes} minutes`);
      }

      const probe = await step.do('check-primary-reviewer', async () => {
        const jwt = await createAppJwt(this.env.GITHUB_APP_ID, this.env.GITHUB_APP_PRIVATE_KEY);
        const token = await getInstallationToken(jwt, installationId);
        const ctx = await fetchPrContext(owner, repo, prNumber, token);
        if (shouldSkipPrState(ctx.pr, { allowDraft })) return { proceed: false, reason: 'closed_or_draft' };
        if (ctx.pr.head.sha !== headSha) return { proceed: false, reason: 'stale_head' };

        const now = Date.now();
        const activeProviders = detectActiveSubscriptionProviders(ctx.comments, headSha);
        if (hasReceiptForHead(ctx.comments, headSha)) {
          if (activeProviders.length) {
            await saveProviderStates(this.env, owner, updateCircuitState({}, { activeProviders, now }));
          }
          return { proceed: false, reason: 'already_reviewed' };
        }

        const quotaProviders = detectQuotaProviders(ctx.comments, { now })
          .filter(p => route.providers.includes(p));
        const running = isReviewInProgressForHead(ctx.comments, headSha);

        if (running) {
          const updates = updateCircuitState({}, { activeProviders, quotaProviders, now });
          if (Object.keys(updates).length) {
            await saveProviderStates(this.env, owner, updates);
          }
          return {
            proceed: true,
            waitRemainingMinutes: Math.max(0, waitMinutes - probeMinutes),
          };
        }

        const inactiveProviders = route.autoProbed.filter(p => !quotaProviders.includes(p));
        const updates = updateCircuitState({}, { quotaProviders, inactiveProviders, now });
        if (Object.keys(updates).length) {
          await saveProviderStates(this.env, owner, updates);
        }
        return { proceed: true, waitRemainingMinutes: 0 };
      });

      if (!probe.proceed) {
        return { status: 'skipped', reason: probe.reason };
      }

      if (probe.waitRemainingMinutes > 0) {
        await step.sleep('wait-active-primary', `${probe.waitRemainingMinutes} minutes`);
      }
    }

    const reviewContext = await step.do('fetch-pr-context', async () => {
      const jwt = await createAppJwt(this.env.GITHUB_APP_ID, this.env.GITHUB_APP_PRIVATE_KEY);
      const token = await getInstallationToken(jwt, installationId);
      const ctx = await fetchPrContext(owner, repo, prNumber, token);
      if (shouldSkipPrState(ctx.pr, { allowDraft })) return { skip: true, reason: 'closed_or_draft' };
      if (ctx.pr.head.sha !== headSha) return { skip: true, reason: 'stale_head' };
      const now = Date.now();
      const activeProviders = detectActiveSubscriptionProviders(ctx.comments, headSha);
      const quotaProviders = detectQuotaProviders(ctx.comments, { now });
      const updates = updateCircuitState({}, { activeProviders, quotaProviders, now });
      if (Object.keys(updates).length) {
        await saveProviderStates(this.env, owner, updates);
      }
      if (hasReceiptForHead(ctx.comments, headSha)) return { skip: true, reason: 'already_reviewed' };
      const { batches, allReviewableFiles, truncated } = buildReviewBatches(ctx.files);
      if (!batches.length) return { skip: true, reason: 'empty_diff' };
      const refPaths = extractReferencedPaths(ctx.files, 3);
      const relatedFiles = [];
      for (const relPath of refPaths) {
        const content = await fetchRepoFile(owner, repo, relPath, headSha, token);
        if (content) relatedFiles.push({ path: relPath, content });
      }
      return {
        skip: false,
        pr: { number: ctx.pr.number, title: ctx.pr.title, body: ctx.pr.body || '' },
        agentsMd: ctx.agentsMd || '',
        relatedFiles,
        batches,
        allReviewableFiles,
        truncated,
      };
    });

    if (reviewContext.skip) {
      return { status: 'skipped', reason: reviewContext.reason };
    }

    const batchResults = [];
    const totalBatches = reviewContext.batches.length;
    for (let i = 0; i < totalBatches; i++) {
      const batch = reviewContext.batches[i];
      const result = await step.do(`review-batch-${i + 1}`, async () => {
        const messages = buildReviewMessages({
          pr: reviewContext.pr,
          diffText: batch.diffText,
          truncated: reviewContext.truncated,
          agentsMd: reviewContext.agentsMd,
          relatedFiles: i === 0 ? reviewContext.relatedFiles : [],
          batchIndex: i,
          totalBatches,
          allFiles: reviewContext.allReviewableFiles,
        });
        return executeReviewWithFallback({
          env: this.env,
          messages,
        });
      });
      batchResults.push(result);
    }

    const merged = mergeBatchVerdicts(batchResults);

    await step.do('post-receipt-comment', async () => {
      const jwt = await createAppJwt(this.env.GITHUB_APP_ID, this.env.GITHUB_APP_PRIVATE_KEY);
      const token = await getInstallationToken(jwt, installationId);
      const body = formatReceiptComment({
        headSha,
        provider: merged.provider,
        model: merged.model,
        verdict: merged.verdict,
        truncated: reviewContext.truncated,
      });
      await postPrComment(owner, repo, prNumber, body, token);
    });

    return {
      status: 'reviewed',
      headSha,
      provider: merged.provider,
      model: merged.model,
      batches: totalBatches,
      truncated: reviewContext.truncated,
      unresolved: merged.verdict.unresolved_findings,
    };
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
    const plan = planPullRequestWebhook({
      eventName,
      payload,
      mentionHandle: env.REVIEW_MENTION_HANDLE || '@ai-reviewer review',
      fallbackWaitMinutes: env.FALLBACK_WAIT_MINUTES ?? '12',
    });
    if (plan.action === 'ignore') {
      return new Response(plan.reason, { status: 202 });
    }

    const { owner, repo, installationId, prNumber, immediate, allowDraft } = plan;
    let headSha = plan.headSha || null;
    if (plan.action === 'fetch_and_dispatch') {
      const jwt = await createAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
      const token = await getInstallationToken(jwt, installationId);
      const ctx = await fetchPrContext(owner, repo, prNumber, token);
      if (shouldSkipPrState(ctx.pr, { allowDraft })) {
        return new Response('Closed or draft skipped', { status: 202 });
      }
      headSha = ctx.pr.head.sha;
    }

    if (!prNumber || !headSha) return new Response('Missing PR head', { status: 202 });
    const baseId = `${owner}-${repo}-${prNumber}-${headSha.slice(0, 12)}`.replace(/[^A-Za-z0-9_-]/g, '_');
    const instanceId = plan.source === 'issue_comment'
      ? `${baseId}-m${String(plan.commentId || Date.now())}`
      : baseId;
    await env.PR_REVIEW_WORKFLOW.create({
      id: instanceId,
      params: { owner, repo, prNumber, installationId, headSha, immediate, allowDraft },
    });

    return Response.json({ accepted: true, instanceId }, { status: 202 });
  },
};
