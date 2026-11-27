# Cloudflare deployment

The production Worker is deployed from this repository through Cloudflare Workers Builds.

## Production source

- Worker: `pigbibi-pr-reviewer`
- Branch: `main`
- Wrangler configuration: `adapters/cloudflare-workflow/wrangler.pigbibi.toml`
- Deploy command: `npx wrangler deploy -c adapters/cloudflare-workflow/wrangler.pigbibi.toml`
- Preview builds: disabled

Production deployment starts after a change passes the repository's required checks and is merged into `main`.

## Configuration ownership

Runtime variables, bindings, and secrets remain managed in Cloudflare. Secret values must never be committed to this repository. The deploy guard is the authoritative pre-deployment validation for required bindings, account targeting, and secret presence.
