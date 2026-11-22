# AiPrReviewer

Zero-VPS, universal AI PR reviewer built with a platform-agnostic `review-core` and interchangeable adapters:

- **Cloudflare Workflows (`adapters/cloudflare-workflow/`)**: 3 isolated deployments across 2 Cloudflare accounts (`qsl`, `gdei`, `pigbibi`), zero per-repo workflow files.
- **Mac mini / Local CLI (`adapters/local-cli/`)**: private repository reviewer supporting DeepSeek API or `opencode` CLI using a private-only GitHub App.

## Verification

```sh
npm test
```
