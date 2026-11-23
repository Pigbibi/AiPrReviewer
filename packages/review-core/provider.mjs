// Provider adapter for OpenAI-compatible Chat Completions API and AIService bridge.

export function buildReviewMessages({
  pr,
  diffText,
  truncated,
  agentsMd,
  relatedFiles = [],
  batchIndex = 0,
  totalBatches = 1,
  allFiles = [],
}) {
  const system = [
    'You are a strict senior code reviewer.',
    'Check the PR diff and related referenced files for correctness bugs, security leaks, architecture boundary violations, silent error swallowing, missing tests, and duplicated/over-complex AI-slop code.',
    'Return ONLY valid JSON: {"summary": string, "unresolved_findings": boolean, "findings": [{"severity": "high"|"medium"|"low", "file": string, "message": string}]}.',
    'Set unresolved_findings=true ONLY when there is at least one high or medium severity bug, security issue, or missing critical test.',
  ].join(' ');

  const relatedSection = relatedFiles.length
    ? '## Related Referenced Files (read-only context)\n' + relatedFiles
        .slice(0, 3)
        .map(f => `### ${f.path}\n\`\`\`\n${String(f.content || '').slice(0, 4000)}\n\`\`\``)
        .join('\n')
    : '';

  const batchHeader = totalBatches > 1
    ? `### Review Batch ${batchIndex + 1}/${totalBatches}\nAll reviewable files (${allFiles.length}): ${allFiles.slice(0, 80).join(', ')}`
    : '';

  const user = [
    agentsMd ? `## Repository AGENTS.md\n${agentsMd.slice(0, 6000)}\n` : '',
    `## PR #${pr.number}: ${pr.title}`,
    pr.body ? `### Description\n${pr.body.slice(0, 2000)}\n` : '',
    batchHeader,
    relatedSection,
    `## Diff${truncated ? ' (truncated)' : ''}${diffText}`,
  ].filter(Boolean).join('\n');

  return { system, user };
}

export function parseVerdict(rawText) {
  const cleaned = String(rawText || '').trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  const parsed = JSON.parse(cleaned);
  if (!parsed || typeof parsed !== 'object') throw new Error('Review output must be a JSON object');
  return {
    summary: typeof parsed.summary === 'string' && parsed.summary.trim()
      ? parsed.summary.trim()
      : 'Automated review completed.',
    unresolved_findings: Boolean(parsed.unresolved_findings),
    findings: Array.isArray(parsed.findings) ? parsed.findings : [],
  };
}

export async function runDeepSeekReview({ apiKey, baseUrl, model, messages }, fetchImpl = fetch) {
  const endpoint = baseUrl || 'https://api.deepseek.com/chat/completions';
  const modelName = model || 'deepseek-chat';
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelName,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: messages.system },
        { role: 'user', content: messages.user },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`LLM API failed with HTTP ${res.status}`);
  }
  const data = await res.json();
  return parseVerdict(data?.choices?.[0]?.message?.content);
}

export async function runAiServiceReview({ serviceUrl, serviceToken, project, pr, messages }, fetchImpl = fetch) {
  const base = String(serviceUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('Missing AI_SERVICE_URL');
  const res = await fetchImpl(`${base}/v1/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(serviceToken ? { Authorization: `Bearer ${serviceToken}` } : {}),
    },
    body: JSON.stringify({
      project,
      scenario: 'pr_code_review',
      mode: 'auto',
      objective: `${messages.system}\nReview ${project}#${pr.number}: ${pr.title}`,
      materials: [{ kind: 'text', name: 'pr_context.md', content: messages.user }],
    }),
  });
  if (!res.ok) {
    throw new Error(`AIService failed with HTTP ${res.status}`);
  }
  const task = await res.json();
  const raw = task?.result?.output ?? task?.output ?? task?.result;
  if (typeof raw === 'string') return parseVerdict(raw);
  if (raw && typeof raw === 'object') return parseVerdict(JSON.stringify(raw));
  throw new Error(`AIService task ${task?.task_id || ''} did not return synchronous output`);
}

export function mergeBatchVerdicts(batchResults) {
  if (!batchResults.length) {
    return {
      verdict: { summary: 'No reviewable changes.', unresolved_findings: false, findings: [] },
      provider: 'opencode',
      model: 'google/gemini-4-hydrogen',
    };
  }
  if (batchResults.length === 1) {
    return batchResults[0];
  }
  const seen = new Set();
  const findings = [];
  const summaries = [];
  for (let i = 0; i < batchResults.length; i++) {
    const { verdict } = batchResults[i];
    if (verdict.summary) {
      summaries.push(`Batch ${i + 1}: ${verdict.summary}`);
    }
    for (const f of verdict.findings || []) {
      const key = `${String(f.severity || '').toLowerCase()}|${f.file || ''}|${f.message || ''}`;
      if (!seen.has(key)) {
        seen.add(key);
        findings.push(f);
      }
    }
  }
  const last = batchResults[batchResults.length - 1];
  const fallbackUsed = batchResults.find(r => r.provider === 'deepseek');
  return {
    verdict: {
      summary: summaries.join(' '),
      unresolved_findings: batchResults.some(r => Boolean(r.verdict.unresolved_findings)),
      findings,
    },
    provider: fallbackUsed ? fallbackUsed.provider : last.provider,
    model: fallbackUsed ? fallbackUsed.model : last.model,
  };
}

export async function executeReviewWithFallback(
  { env, project, pr, messages, getGcpToken },
  fetchImpl = fetch
) {
  const attempts = [];

  if (env.AI_SERVICE_URL) {
    attempts.push({
      provider: env.AI_REVIEW_PROVIDER || 'opencode',
      model: env.AI_REVIEW_MODEL || 'google/gemini-4-hydrogen',
      run: () => runAiServiceReview(
        { serviceUrl: env.AI_SERVICE_URL, serviceToken: env.AI_SERVICE_TOKEN, project, pr, messages },
        fetchImpl
      ),
    });
  }

  if (env.GCP_SERVICE_ACCOUNT_JSON && typeof getGcpToken === 'function') {
    attempts.push({
      provider: env.AI_REVIEW_PROVIDER || 'opencode',
      model: env.AI_REVIEW_MODEL || 'google/gemini-4-hydrogen',
      run: async () => {
        const gcp = await getGcpToken(env.GCP_SERVICE_ACCOUNT_JSON);
        const loc = env.GCP_VERTEX_LOCATION || 'global';
        const baseUrl = env.AI_REVIEW_BASE_URL
          || `https://aiplatform.googleapis.com/v1/projects/${gcp.projectId}/locations/${loc}/endpoints/openapi/chat/completions`;
        return runDeepSeekReview(
          { apiKey: gcp.accessToken, baseUrl, model: env.AI_REVIEW_MODEL || 'gemini-4-hydrogen', messages },
          fetchImpl
        );
      },
    });
  } else if (env.AI_API_KEY || env.GEMINI_API_KEY) {
    const model = env.AI_REVIEW_MODEL || 'gemini-4-hydrogen';
    attempts.push({
      provider: env.AI_REVIEW_PROVIDER || 'opencode',
      model,
      run: () => runDeepSeekReview(
        { apiKey: env.AI_API_KEY || env.GEMINI_API_KEY, baseUrl: env.AI_REVIEW_BASE_URL, model, messages },
        fetchImpl
      ),
    });
  }

  if (env.DEEPSEEK_API_KEY) {
    const dsModel = env.DEEPSEEK_MODEL || 'deepseek-chat';
    attempts.push({
      provider: 'deepseek',
      model: dsModel,
      run: () => runDeepSeekReview(
        {
          apiKey: env.DEEPSEEK_API_KEY,
          baseUrl: env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/chat/completions',
          model: dsModel,
          messages,
        },
        fetchImpl
      ),
    });
  }

  if (!attempts.length) {
    throw new Error('No AI review provider credentials configured');
  }

  let lastError;
  for (const attempt of attempts) {
    try {
      const verdict = await attempt.run();
      return { verdict, provider: attempt.provider, model: attempt.model };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}
