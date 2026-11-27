# AiPrReviewer

Zero-VPS, universal AI PR reviewer built with a platform-agnostic `review-core` and interchangeable adapters:

- **Cloudflare Workflows (`adapters/cloudflare-workflow/`)**: 3 isolated deployments across 2 Cloudflare accounts (`qsl`, `gdei`, `pigbibi`), zero per-repo workflow files.
- **Mac mini / Local CLI (`adapters/local-cli/`)**: private repository reviewer. It posts a DeepSeek receipt when `CODEX_REVIEW_ENABLED` and `CLAUDE_REVIEW_ENABLED` are both false. While either subscription flag is on, the command leaves the pull request to that reviewer.

## Review route

`CODEX_REVIEW_ENABLED` defaults to on and `CLAUDE_REVIEW_ENABLED` defaults to off when the variable is empty. Set either to `true` or `false` on the Worker and on the machine that runs the local CLI. The API call is `DEEPSEEK_API_KEY` only.

```sh
wrangler secret put DEEPSEEK_API_KEY -c wrangler.qsl.toml
```

## Verification

```sh
npm test
```
