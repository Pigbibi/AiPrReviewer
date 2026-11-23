# AiPrReviewer

Zero-VPS, universal AI PR reviewer built with a platform-agnostic `review-core` and interchangeable adapters:

- **Cloudflare Workflows (`adapters/cloudflare-workflow/`)**: 3 isolated deployments across 2 Cloudflare accounts (`qsl`, `gdei`, `pigbibi`), zero per-repo workflow files.
- **Mac mini / Local CLI (`adapters/local-cli/`)**: private repository reviewer supporting DeepSeek API or `opencode` CLI using a private-only GitHub App.

## Upstream AIService Routing (`AI_SERVICE_URL`)

When `AI_SERVICE_URL` (+ optional `AI_SERVICE_TOKEN`) is configured in the Cloudflare Worker (`wrangler.*.toml` secrets), reviews route first to `QuantAIService` / `PersonalAIService` `/v1/pr-review` (with automatic Vertex AI fallback when omitted or unreachable):

```toml
# Optional Cloudflare secret:
# wrangler secret put AI_SERVICE_URL -c wrangler.qsl.toml
# wrangler secret put AI_SERVICE_TOKEN -c wrangler.qsl.toml
```

## Verification

```sh
npm test
```
