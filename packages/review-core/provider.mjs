// Provider adapter for OpenAI-compatible Chat Completions API and AIService bridge.

export function buildReviewMessages({ pr, diffText, truncated, agentsMd, relatedFiles = [] }) {
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

  const user = [
    agentsMd ? `## Repository AGENTS.md\n${agentsMd.slice(0, 6000)}\n` : '',
    `## PR #${pr.number}: ${pr.title}`,
    pr.body ? `### Description\n${pr.body.slice(0, 2000)}\n` : '',
    relatedSection,
    `## Diff${truncated ? ' (truncated to 60KB)' : ''}${diffText}`,
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
