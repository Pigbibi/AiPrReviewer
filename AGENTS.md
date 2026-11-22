# AGENTS.md

Rules for AI assistants and maintainers in `Pigbibi/AiPrReviewer`.

## What this repository is

Zero-VPS, platform-agnostic AI PR reviewer (`packages/review-core/`) with interchangeable adapters for Cloudflare Workflows (`adapters/cloudflare-workflow/`) and Mac mini / local CLI (`adapters/local-cli/`).

## Local checks

```sh
npm test
```

## Do not

- Never commit `.pem` private keys, API keys, webhook secrets, or real account/installation IDs.
- Keep `packages/review-core/` free of cloud-specific imports (`cloudflare:*`, `node:fs`, etc.).
