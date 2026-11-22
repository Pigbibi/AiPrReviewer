// Standard PrGovernance ai-review-receipt:v1 formatter.

export function formatReceiptComment({ headSha, provider = 'deepseek', model = 'deepseek-chat', verdict, truncated = false }) {
  const receipt = {
    review: {
      provider,
      model,
      commit_sha: headSha,
      coverage: truncated ? 'partial' : 'complete',
      unresolved_findings: verdict.unresolved_findings,
    },
  };
  const lines = [
    `<!-- ai-review-receipt:v1 ${JSON.stringify(receipt)} -->`,
    `### AI Code Review (${provider} / \`${model}\`)`,
    '',
    verdict.summary,
    '',
    `**Reviewed commit:** \`${headSha.slice(0, 10)}\` · **Coverage:** ${receipt.review.coverage} · **Unresolved findings:** ${verdict.unresolved_findings}`,
  ];
  if (verdict.findings.length) {
    lines.push('', '#### Findings');
    for (const f of verdict.findings.slice(0, 20)) {
      const sev = String(f.severity || 'medium').toUpperCase();
      const file = f.file ? `\`${f.file}\`` : 'general';
      lines.push(`- **[${sev}]** ${file}: ${f.message}`);
    }
  }
  return lines.join('\n');
}
