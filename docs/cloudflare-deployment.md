# Cloudflare deployment

The production Worker is deployed from this repository through Cloudflare Workers Builds.

## Production source

- Worker: `pigbibi-pr-reviewer`
- Branch: `main`
- Wrangler configuration: `adapters/cloudflare-workflow/wrangler.pigbibi.toml`
- Deploy command: `npx --yes --package wrangler@4.167.0 -- node adapters/cloudflare-workflow/deploy_guard.mjs pigbibi`
- Preview builds: disabled

Production deployment starts after a change passes the repository's required checks and is merged into `main`. The deploy command must always run through `deploy_guard.mjs`; direct `wrangler deploy` is not an approved production path.

Cloudflare Builds defines these non-secret guard inputs with account-specific values kept outside the repository:

- `CLOUDFLARE_ACCOUNT_ID=<PIGBIBI_CLOUDFLARE_ACCOUNT_ID>`
- `EXPECTED_CLOUDFLARE_ACCOUNT_ID_PIGBIBI=<PIGBIBI_CLOUDFLARE_ACCOUNT_ID>`
- `GITHUB_APP_ID=<PIGBIBI_REVIEWER_GITHUB_APP_ID>`

## Configuration ownership

- Runtime variables and bindings are repository-managed in `wrangler.pigbibi.toml`, except identifiers that repository policy requires Cloudflare to manage.
- Secret values and real account or installation identifiers are Cloudflare-managed and must never be committed.
- The guarded deploy preserves dashboard-managed runtime variables such as `GITHUB_APP_ID` while applying repository-managed variables and bindings.
- The deploy guard is the authoritative pre-deployment validation for account targeting, required variables, and required secret presence.
