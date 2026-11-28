import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TARGET_WORKERS = Object.freeze({
  qsl: Object.freeze({
    config: 'wrangler.qsl.toml',
    worker: 'qsl-pr-reviewer',
    githubAppIdEnv: 'GITHUB_APP_ID',
    expectedAccountEnv: 'EXPECTED_CLOUDFLARE_ACCOUNT_ID_QSL',
    providerSecrets: ['DEEPSEEK_API_KEY'],
  }),
  gdei: Object.freeze({
    config: 'wrangler.gdei.toml',
    worker: 'gdei-pr-reviewer',
    githubAppIdEnv: 'GITHUB_APP_ID',
    expectedAccountEnv: 'EXPECTED_CLOUDFLARE_ACCOUNT_ID_GDEI',
    providerSecrets: ['DEEPSEEK_API_KEY'],
  }),
  pigbibi: Object.freeze({
    config: 'wrangler.pigbibi.toml',
    worker: 'pigbibi-pr-reviewer',
    githubAppIdEnv: 'GITHUB_APP_ID',
    expectedAccountEnv: 'EXPECTED_CLOUDFLARE_ACCOUNT_ID_PIGBIBI',
    providerSecrets: ['DEEPSEEK_API_KEY'],
  }),
  'qsl-gemini': Object.freeze({
    config: 'wrangler.qsl-gemini.toml',
    worker: 'qsl-gemini-pr-reviewer',
    githubAppIdEnv: 'QSL_GEMINI_GITHUB_APP_ID',
    expectedAccountEnv: 'EXPECTED_CLOUDFLARE_ACCOUNT_ID_QSL_GEMINI',
    providerSecrets: ['GEMINI_API_KEY', 'GEMINI_AGENT_SERVICE_ACCOUNT_JSON'],
  }),
  'gdei-gemini': Object.freeze({
    config: 'wrangler.gdei-gemini.toml',
    worker: 'gdei-gemini-pr-reviewer',
    githubAppIdEnv: 'GDEI_GEMINI_GITHUB_APP_ID',
    expectedAccountEnv: 'EXPECTED_CLOUDFLARE_ACCOUNT_ID_GDEI_GEMINI',
    providerSecrets: ['GEMINI_API_KEY', 'GEMINI_AGENT_SERVICE_ACCOUNT_JSON'],
  }),
  'pigbibi-gemini': Object.freeze({
    config: 'wrangler.pigbibi-gemini.toml',
    worker: 'pigbibi-gemini-pr-reviewer',
    githubAppIdEnv: 'PIGBIBI_GEMINI_GITHUB_APP_ID',
    expectedAccountEnv: 'EXPECTED_CLOUDFLARE_ACCOUNT_ID_PIGBIBI_GEMINI',
    providerSecrets: ['GEMINI_API_KEY', 'GEMINI_AGENT_SERVICE_ACCOUNT_JSON'],
  }),
});

export const REQUIRED_BASE_SECRETS = Object.freeze([
  'GITHUB_WEBHOOK_SECRET',
  'GITHUB_APP_PRIVATE_KEY',
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

  const expectedKey = spec.expectedAccountEnv;
  const expectedAccountId = String(env[expectedKey] || '').trim();
  if (expectedAccountId && expectedAccountId !== accountId) {
    throw new Error(
      `Refusing deploy of ${spec.worker}: CLOUDFLARE_ACCOUNT_ID (${accountId}) does not match ${expectedKey} (${expectedAccountId})`
    );
  }

  if (!allowBootstrap) {
    const missingVariables = [spec.githubAppIdEnv].filter(name => !String(env[name] || '').trim());
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
    const missingProvider = spec.providerSecrets.filter(name => !present.has(name));
    if (missingProvider.length) {
      throw new Error(
        `Refusing deploy of ${spec.worker} to account ${accountId}: missing required provider secrets [${missingProvider.join(', ')}]`
      );
    }
  }

  return { ...spec, githubAppId: String(env[spec.githubAppIdEnv] || '').trim() };
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

  const validated = validateDeployPreconditions({ target, env, secretNames, allowBootstrap });
  const configPath = resolve(workflowDir, spec.config);

  if (dryRun) {
    console.log(JSON.stringify({ status: 'guard_passed_dry_run', worker: spec.worker, accountId, config: spec.config, secretCount: secretNames.length }));
    return;
  }

  execFileSync(
    'wrangler',
    buildDeployArgs(configPath, validated.githubAppId),
    { cwd: workflowDir, env: { ...env, CLOUDFLARE_ACCOUNT_ID: accountId }, stdio: 'inherit' }
  );
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runDeployCli();
}


