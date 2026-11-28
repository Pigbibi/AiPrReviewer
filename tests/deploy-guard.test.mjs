import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDeployArgs,
  parseSecretListOutput,
  validateDeployPreconditions,
} from '../adapters/cloudflare-workflow/deploy_guard.mjs';

test('deploy preserves dashboard-managed runtime variables', () => {
  assert.deepEqual(
    buildDeployArgs('/tmp/wrangler.toml', '1234567'),
    [
      'deploy',
      '-c',
      '/tmp/wrangler.toml',
      '--keep-vars',
      '--var',
      'GITHUB_APP_ID:1234567',
    ]
  );
});

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
      env: {
        CLOUDFLARE_ACCOUNT_ID: '00000000000000000000000000000001',
        GITHUB_APP_ID: '1234567',
      },
      secretNames: [],
    }),
    /missing required secrets/
  );

  assert.throws(
    () => validateDeployPreconditions({
      target: 'qsl',
      env: { CLOUDFLARE_ACCOUNT_ID: '00000000000000000000000000000001' },
      secretNames: ['GITHUB_WEBHOOK_SECRET', 'GITHUB_APP_PRIVATE_KEY', 'DEEPSEEK_API_KEY'],
    }),
    /missing required variables \[GITHUB_APP_ID\]/
  );

  assert.throws(
    () => validateDeployPreconditions({
      target: 'qsl',
      env: {
        CLOUDFLARE_ACCOUNT_ID: '00000000000000000000000000000001',
        GITHUB_APP_ID: '1234567',
      },
      secretNames: ['GITHUB_WEBHOOK_SECRET', 'GITHUB_APP_PRIVATE_KEY'],
    }),
    /missing required provider secret \[DEEPSEEK_API_KEY\]/
  );

  const spec = validateDeployPreconditions({
    target: 'qsl',
    env: {
      CLOUDFLARE_ACCOUNT_ID: '00000000000000000000000000000001',
      GITHUB_APP_ID: '1234567',
    },
    secretNames: parseSecretListOutput(JSON.stringify([
      { name: 'GITHUB_WEBHOOK_SECRET', type: 'secret_text' },
      { name: 'GITHUB_APP_PRIVATE_KEY', type: 'secret_text' },
      { name: 'DEEPSEEK_API_KEY', type: 'secret_text' },
    ])),
  });
  assert.equal(spec.worker, 'qsl-pr-reviewer');
  assert.equal(spec.config, 'wrangler.qsl.toml');
});

test('Gemini secondary targets require an independent App ID and Gemini secret', () => {
  const baseEnv = {
    CLOUDFLARE_ACCOUNT_ID: '00000000000000000000000000000001',
    EXPECTED_CLOUDFLARE_ACCOUNT_ID_QSL_GEMINI: '00000000000000000000000000000001',
    QSL_GEMINI_GITHUB_APP_ID: '7654321',
  };
  const baseSecrets = [
    'GITHUB_WEBHOOK_SECRET',
    'GITHUB_APP_PRIVATE_KEY',
  ];

  assert.throws(
    () => validateDeployPreconditions({
      target: 'qsl-gemini',
      env: { ...baseEnv, QSL_GEMINI_GITHUB_APP_ID: '' },
      secretNames: [...baseSecrets, 'GEMINI_API_KEY'],
    }),
    /missing required variables \[QSL_GEMINI_GITHUB_APP_ID\]/
  );

  assert.throws(
    () => validateDeployPreconditions({
      target: 'qsl-gemini',
      env: baseEnv,
      secretNames: [...baseSecrets, 'DEEPSEEK_API_KEY'],
    }),
    /missing required provider secret \[GEMINI_API_KEY\]/
  );

  const spec = validateDeployPreconditions({
    target: 'qsl-gemini',
    env: baseEnv,
    secretNames: [...baseSecrets, 'GEMINI_API_KEY'],
  });
  assert.equal(spec.worker, 'qsl-gemini-pr-reviewer');
  assert.equal(spec.config, 'wrangler.qsl-gemini.toml');
  assert.equal(spec.githubAppId, '7654321');
});

