# AiPrReviewer

Zero-VPS, universal AI PR reviewer built with a platform-agnostic `review-core` and interchangeable adapters:

- **Cloudflare Workflows (`adapters/cloudflare-workflow/`)**: 3 primary DeepSeek deployments plus 3 independent Gemini secondary deployments across 2 Cloudflare accounts, with zero per-repo workflow files.
- **Mac mini / Local CLI (`adapters/local-cli/`)**: private repository reviewer using the same trusted-receipt and provider-quorum rules as the Worker.

## Review route

`CODEX_REVIEW_ENABLED` and `CLAUDE_REVIEW_ENABLED` default to `auto`. The Worker probes trusted, exact-head receipts and stores per-repository inactive/quota cooldowns in KV. Routine changes need one provider; security-sensitive paths need two distinct providers. A forged marker from an untrusted login never satisfies quorum.

The primary API reviewer is DeepSeek:

```sh
wrangler secret put DEEPSEEK_API_KEY -c wrangler.qsl.toml
```

For high-risk changes, each organization has a separate Gemini secondary deployment:

```toml
[vars]
AI_REVIEW_PROVIDER = "gemini"
AI_REVIEW_PROVIDER_ROLE = "secondary"
GEMINI_MODEL = "gemini-3.8-flash"
SECONDARY_GRACE_MINUTES = "3"
REVIEWER_LOGIN = "qsl-gemini-reviewer[bot]"
TRUSTED_REVIEWERS_JSON = '{"qsl-ai-reviewer[bot]":["deepseek"]}'
```

```sh
wrangler secret put GEMINI_API_KEY -c wrangler.qsl-gemini.toml
```

The deploy guard exposes the targets `qsl-gemini`, `gdei-gemini`, and `pigbibi-gemini`. Each target requires its own GitHub App ID variable (`QSL_GEMINI_GITHUB_APP_ID`, `GDEI_GEMINI_GITHUB_APP_ID`, or `PIGBIBI_GEMINI_GITHUB_APP_ID`), App private key, webhook secret, and Gemini API key. Primary and secondary deployments trust only the explicitly named counterpart App.

The secondary reviewer must be a separate GitHub App identity. Two models posting through the same bot login do not count as independent reviewers in PrGovernance v4. Configure each deployment's `TRUSTED_REVIEWERS_JSON` with only the other reviewer Apps that are allowed to attest a provider.

The secondary deployment waits an extra grace window before its final quorum check. Normally DeepSeek fills the missing slot first; Gemini runs only when the primary API reviewer is absent or failed, or when explicitly mentioned.

An explicit `@<reviewer> review` mention forces that App's provider to review the exact head even when another provider has already completed. It never duplicates its own existing receipt.

No API key belongs in TOML, repository variables, comments, or receipts. Keep provider credentials in Worker secrets or the local machine's secret store.

The local CLI also requires `REVIEWER_LOGIN`; it refuses to spend API credits when it cannot bind existing receipts to its own authenticated App identity.

## Verification

```sh
npm test
```

