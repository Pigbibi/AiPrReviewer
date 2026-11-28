import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TARGET_WORKERS = Object.freeze({
  qsl: Object.freeze({ config: 'wrangler.qsl.toml', worker: 'qsl-pr-reviewer' }),
  gdei: Object.freeze({ config: 'wrangler.gdei.toml', worker: 'gdei-pr-reviewer' }),
  pigbibi: Object.freeze({ config: 'wrangler.pigbibi.toml', worker: 'pigbibi-pr-reviewer' }),
});

export const REQUIRED_BASE_SECRETS = Object.freeze([
  'GITHUB_WEBHOOK_SECRET',
  'GITHUB_APP_PRIVATE_KEY',
]);

export const REQUIRED_BASE_VARIABLES = Object.freeze([
  'GITHUB_APP_ID',
]);

export const PROVIDER_SECRET_CANDIDATES = Object.freeze([
  'DEEPSEEK_API_KEY',
]);

export function parseSecretListOutput(rawStdout) {
  const parsed = JSON.parse(String(rawStdout || '').trim() || '[]');
  if (!Array.isArray(parsed)) {
    throw new Error('wrangler secret list output must be a JSON array');
  }
  return parsed
    .map(item => (item && typeof item.name === 'string' ? item.name.trim() : ''))
    .filter(Boolean);
}

export function validateDeployPreconditions({
  target,
  env = {},
  secretNames = [],
  allowBootstrap = false,
}) {
  const spec = TARGET_WORKERS[target];
  if (!spec) {
    throw new Error(`Unknown worker target "${target}". Expected one of: ${Object.keys(TARGET_WORKERS).join(', ')}`);
  }

  const accountId = String(env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  if (!accountId) {
    throw new Error(
      `Refusing deploy of ${spec.worker}: CLOUDFLARE_ACCOUNT_ID must be set explicitly (multi-account safety guard)`
    );
  }

  const expectedKey = `EXPECTED_CLOUDFLARE_ACCOUNT_ID_${target.toUpperCase()}`;
  const expectedAccountId = String(env[expectedKey] || '').trim();
  if (expectedAccountId && expectedAccountId !== accountId) {
    throw new Error(
      `Refusing deploy of ${spec.worker}: CLOUDFLARE_ACCOUNT_ID (${accountId}) does not match ${expectedKey} (${expectedAccountId})`
    );
  }

  if (!allowBootstrap) {
    const missingVariables = REQUIRED_BASE_VARIABLES.filter(name => !String(env[name] || '').trim());
    if (missingVariables.length) {
      throw new Error(
        `Refusing deploy of ${spec.worker} to account ${accountId}: missing required variables [${missingVariables.join(', ')}]`
      );
    }

    const present = new Set(secretNames);
    const missingBase = REQUIRED_BASE_SECRETS.filter(name => !present.has(name));
    if (missingBase.length) {
      throw new Error(
        `Refusing deploy of ${spec.worker} to account ${accountId}: missing required secrets [${missingBase.join(', ')}] (pass --allow-bootstrap only for initial setup)`
      );
    }
    const hasProvider = PROVIDER_SECRET_CANDIDATES.some(name => present.has(name));
    if (!hasProvider) {
      throw new Error(
        `Refusing deploy of ${spec.worker} to account ${accountId}: missing AI provider secret (need one of ${PROVIDER_SECRET_CANDIDATES.join(', ')})`
      );
    }
  }

  return spec;
}

export function buildDeployArgs(configPath, githubAppId) {
  return [
    'deploy',
    '-c',
    configPath,
    '--keep-vars',
    '--var',
    `GITHUB_APP_ID:${githubAppId}`,
  ];
}

export function runDeployCli(argv = process.argv.slice(2), env = process.env) {
  const flags = new Set(argv.filter(a => a.startsWith('--')));
  const positional = argv.filter(a => !a.startsWith('--'));
  const target = positional[0] || '';
  const dryRun = flags.has('--dry-run');
  const allowBootstrap = flags.has('--allow-bootstrap');

  const spec = TARGET_WORKERS[target];
  if (!spec) {
    validateDeployPreconditions({ target, env, secretNames: [], allowBootstrap });
  }

  const accountId = String(env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  if (!accountId) {
    validateDeployPreconditions({ target, env, secretNames: [], allowBootstrap });
  }

  const workflowDir = dirname(fileURLToPath(import.meta.url));
  let secretNames = [];
  if (!allowBootstrap) {
    const rawSecrets = execFileSync(
      'wrangler',
      ['secret', 'list', '--name', spec.worker, '--format', 'json'],
      { cwd: workflowDir, env: { ...env, CLOUDFLARE_ACCOUNT_ID: accountId }, encoding: 'utf8' }
    );
    secretNames = parseSecretListOutput(rawSecrets);
  }

  validateDeployPreconditions({ target, env, secretNames, allowBootstrap });
  const configPath = resolve(workflowDir, spec.config);

  if (dryRun) {
    console.log(JSON.stringify({ status: 'guard_passed_dry_run', worker: spec.worker, accountId, config: spec.config, secretCount: secretNames.length }));
    return;
  }

  execFileSync(
    'wrangler',
    buildDeployArgs(configPath, String(env.GITHUB_APP_ID).trim()),
    { cwd: workflowDir, env: { ...env, CLOUDFLARE_ACCOUNT_ID: accountId }, stdio: 'inherit' }
  );
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runDeployCli();
}

