import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSecretListOutput,
  validateDeployPreconditions,
} from '../adapters/cloudflare-workflow/deploy_guard.mjs';

test('deploy guard enforces explicit account id, expected target match, and bound secrets', () => {
  assert.throws(
    () => validateDeployPreconditions({ target: 'qsl', env: {}, secretNames: [] }),
    /CLOUDFLARE_ACCOUNT_ID must be set explicitly/
  );

  assert.throws(
    () => validateDeployPreconditions({
      target: 'qsl',
      env: {
        CLOUDFLARE_ACCOUNT_ID: '00000000000000000000000000000001',
        EXPECTED_CLOUDFLARE_ACCOUNT_ID_QSL: '00000000000000000000000000000002',
      },
      secretNames: ['GITHUB_WEBHOOK_SECRET', 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'DEEPSEEK_API_KEY'],
    }),
    /does not match EXPECTED_CLOUDFLARE_ACCOUNT_ID_QSL/
  );

  assert.throws(
    () => validateDeployPreconditions({
      target: 'qsl',
      env: { CLOUDFLARE_ACCOUNT_ID: '00000000000000000000000000000001' },
      secretNames: [],
    }),
    /missing required secrets/
  );

  assert.throws(
    () => validateDeployPreconditions({
      target: 'qsl',
      env: { CLOUDFLARE_ACCOUNT_ID: '00000000000000000000000000000001' },
      secretNames: ['GITHUB_WEBHOOK_SECRET', 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY'],
    }),
    /missing AI provider secret/
  );

  const spec = validateDeployPreconditions({
    target: 'qsl',
    env: { CLOUDFLARE_ACCOUNT_ID: '00000000000000000000000000000001' },
    secretNames: parseSecretListOutput(JSON.stringify([
      { name: 'GITHUB_WEBHOOK_SECRET', type: 'secret_text' },
      { name: 'GITHUB_APP_ID', type: 'secret_text' },
      { name: 'GITHUB_APP_PRIVATE_KEY', type: 'secret_text' },
      { name: 'DEEPSEEK_API_KEY', type: 'secret_text' },
    ])),
  });
  assert.equal(spec.worker, 'qsl-pr-reviewer');
  assert.equal(spec.config, 'wrangler.qsl.toml');
});
