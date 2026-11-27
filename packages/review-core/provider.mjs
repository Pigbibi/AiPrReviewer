// Provider adapter for OpenAI-compatible Chat Completions API and AIService bridge.

const HIGH_RISK_SECURITY_PATH_RE =
  /^(?:\.github\/(?:workflows|actions)\/|(?:.*\/)?action\.ya?ml$|packages\/review-core\/|adapters\/(?:cloudflare-workflow|local-cli)\/|deploy\/|ops\/|.*wrangler.*\.toml$|.*(?:auth|oauth|login|session|jwt|token|secret|key|crypto|webhook|signature|permission|rbac|iam|payment|charge|order|trade|execution|risk|sql|migration|security).*)/i;
const DOC_ONLY_PATH_RE = /\.(?:md|txt|rst)$/i;
const MACHINE_TEXT_FILE_RE =
  /(?:^|\/)(?:requirements[^/]*\.txt|constraints[^/]*\.txt|cmakelists\.txt|robots\.txt|humans\.txt)$/i;

function collectChangedPaths({ allFiles = [], diffText = '' } = {}) {
  const candidates = new Set(
    (Array.isArray(allFiles) ? allFiles : []).map(f => String(f || '').trim()).filter(Boolean)
  );
  for (const line of String(diffText || '').split('\n')) {
    if (line.startsWith('diff --git a/')) {
      const m = /^diff --git a\/.+ b\/(.+)$/.exec(line);
      if (m) candidates.add(m[1].trim());
    } else if (line.startsWith('+++ b/')) {
      const target = line.slice(6).trim();
      if (target && target !== '/dev/null') candidates.add(target);
    }
  }
  return [...candidates];
}

export function detectHighRiskSecurityPaths({ allFiles = [], diffText = '' } = {}) {
  return collectChangedPaths({ allFiles, diffText }).filter(filePath => HIGH_RISK_SECURITY_PATH_RE.test(filePath));
}

export function reviewPathsFromFiles(files = []) {
  return [...new Set(files.flatMap(file => [file?.filename, file?.previous_filename])
    .map(value => String(value || '').trim())
    .filter(Boolean))];
}

export function requiredProviderCountForReview(input = {}) {
  return detectHighRiskSecurityPaths(input).length ? 2 : 1;
}

export function isDocOnlyChange({ allFiles = [], diffText = '' } = {}) {
  const paths = collectChangedPaths({ allFiles, diffText });
  return paths.length > 0 && paths.every(filePath => DOC_ONLY_PATH_RE.test(filePath) && !MACHINE_TEXT_FILE_RE.test(filePath));
}

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
  const highRiskPaths = detectHighRiskSecurityPaths({ allFiles, diffText });
  const docOnly = isDocOnlyChange({ allFiles, diffText });
  const system = [
    'You are a strict senior code reviewer.',
    'Check the PR diff and related referenced files for correctness bugs, security leaks, architecture boundary violations, silent error swallowing, missing tests, and duplicated/over-complex AI-slop code.',
    'Return ONLY valid JSON: {"summary": string, "unresolved_findings": boolean, "findings": [{"severity": "high"|"medium"|"low", "file": string, "message": string}]}.',
    'Set unresolved_findings=true ONLY when there is at least one high or medium severity bug, security issue, or missing critical test.',
  ].join(' ');

  const securityChecklistSection = highRiskPaths.length
    ? [
        `## High-Risk Security Checklist (triggered by: ${highRiskPaths.slice(0, 10).join(', ')})`,
        '1. Credentials, tokens, and signing secrets: verify none are hardcoded, echoed in logs, or leaked in error responses.',
        '2. AuthN/AuthZ and signature verification: verify privilege boundaries, HMAC/JWT checks, and fail-closed guards are not weakened or bypassed.',
        '3. External inputs: check for command injection, SQL/path traversal, SSRF, or unvalidated redirects.',
        '4. CI/deploy configs: verify GitHub Actions permissions stay minimal and third-party actions remain SHA-pinned.',
        '5. Trading/execution paths: verify risk gates, idempotency, and fail-closed safety invariants are preserved.',
      ].join('\n')
    : '';

  const docsCalibrationSection = docOnly
    ? [
        '## Documentation-Only Review Calibration',
        '1. Emit severity "high" or "medium" (with unresolved_findings=true) ONLY for real credential/secret/PII leaks, broken or contradictory safety/policy rules, or wrong/dangerous operational commands.',
        '2. Do NOT classify summary-table display rounding differences (e.g., 2-decimal rounded figures vs unrounded run numbers), prose/footnote wording style nits, or external context outside this diff as "high" or "medium" — report those as "low" with unresolved_findings=false, or omit them.',
      ].join('\n')
    : '';

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
    securityChecklistSection,
    docsCalibrationSection,
    relatedSection,
    `## Diff${truncated ? ' (truncated)' : ''}${diffText}`,
  ].filter(Boolean).join('\n');

  return { system, user };
}

export function parseVerdict(rawText) {
  const cleaned = String(rawText || '').trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  const parsed = JSON.parse(cleaned);
  if (!parsed || typeof parsed !== 'object') throw new Error('Review output must be a JSON object');
  const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
  // Match receipt.mjs: omitted/empty severities default to 'medium' and stay blocking.
  const hasBlockingFinding = findings.some(f => {
    const sev = String(f?.severity ?? '').trim().toLowerCase() || 'medium';
    return sev !== 'low';
  });
  return {
    summary: typeof parsed.summary === 'string' && parsed.summary.trim()
      ? parsed.summary.trim()
      : 'Automated review completed.',
    unresolved_findings: findings.length > 0
      ? Boolean(parsed.unresolved_findings) && hasBlockingFinding
      : Boolean(parsed.unresolved_findings),
    findings,
  };
}

export async function runDeepSeekReview({ apiKey, baseUrl, model, messages }, fetchImpl = fetch) {
  const endpoint = baseUrl || 'https://api.deepseek.com/chat/completions';
  const modelName = model || 'deepseek-flash';
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

export async function runGeminiReview({ apiKey, baseUrl, model, messages }, fetchImpl = fetch) {
  if (!apiKey) throw new Error('Missing GEMINI_API_KEY');
  const modelName = model || 'gemini-3.8-flash';
  const base = String(baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
  const endpoint = `${base}/models/${encodeURIComponent(modelName)}:generateContent`;
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: messages.system }] },
      contents: [{ role: 'user', parts: [{ text: messages.user }] }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json',
      },
    }),
  });
  if (!res.ok) throw new Error(`Gemini API failed with HTTP ${res.status}`);
  const data = await res.json();
  const raw = data?.candidates?.[0]?.content?.parts
    ?.map(part => typeof part?.text === 'string' ? part.text : '')
    .join('');
  if (!raw) throw new Error('Gemini API returned no review content');
  return parseVerdict(raw);
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
      provider: 'deepseek',
      model: 'deepseek-flash',
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

export async function executeReviewWithFallback({ env, messages }, fetchImpl = fetch) {
  const provider = String(env.AI_REVIEW_PROVIDER || 'deepseek').trim().toLowerCase();
  if (provider === 'gemini') {
    const model = env.GEMINI_MODEL || 'gemini-3.8-flash';
    const verdict = await runGeminiReview({
      apiKey: env.GEMINI_API_KEY,
      baseUrl: env.GEMINI_BASE_URL,
      model,
      messages,
    }, fetchImpl);
    return { verdict, provider, model };
  }
  if (provider !== 'deepseek') throw new Error(`Unsupported API review provider: ${provider}`);
  if (!env.DEEPSEEK_API_KEY) throw new Error('No DeepSeek review credentials configured');
  const model = env.DEEPSEEK_MODEL || 'deepseek-flash';
  const verdict = await runDeepSeekReview({
    apiKey: env.DEEPSEEK_API_KEY,
    baseUrl: env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/chat/completions',
    model,
    messages,
  }, fetchImpl);
  return { verdict, provider, model };
}

