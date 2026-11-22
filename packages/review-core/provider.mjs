// Provider adapter for DeepSeek / OpenAI-compatible Chat Completions API.

export function buildReviewMessages({ pr, diffText, truncated, agentsMd }) {
  const system = [
    'You are a strict senior code reviewer.',
    'Check the PR diff for correctness bugs, security leaks, architecture boundary violations, silent error swallowing, missing tests, and duplicated/over-complex AI-slop code.',
    'Return ONLY valid JSON: {"summary": string, "unresolved_findings": boolean, "findings": [{"severity": "high"|"medium"|"low", "file": string, "message": string}]}.',
    'Set unresolved_findings=true ONLY when there is at least one high or medium severity bug, security issue, or missing critical test.',
  ].join(' ');

  const user = [
    agentsMd ? `## Repository AGENTS.md\n${agentsMd.slice(0, 6000)}\n` : '',
    `## PR #${pr.number}: ${pr.title}`,
    pr.body ? `### Description\n${pr.body.slice(0, 2000)}\n` : '',
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
