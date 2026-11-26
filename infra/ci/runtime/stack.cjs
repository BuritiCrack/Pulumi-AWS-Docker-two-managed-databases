// Public CLI: check-preview|check-deploy validate without tools/writes;
// preview|deploy operate only on the existing dev stack. Never log child output.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml'); // Already present in the unchanged npm lockfile.
const project = path.resolve(__dirname, '../..');
const env = process.env;
function fail(message) { throw new Error(message); }
function preflight(mode) {
  const deploy = mode.endsWith('deploy');
  const trusted = deploy
    ? env.CI_EVENT === 'push' && env.GITHUB_REF === 'refs/heads/main'
    : env.CI_EVENT === 'pull_request' && env.CI_BASE_REF === 'main'
      && !!env.CI_REPOSITORY && env.CI_HEAD_REPOSITORY === env.CI_REPOSITORY
      && /^feature\/.+/.test(env.CI_HEAD_REF || '');
  if (!trusted) fail('untrusted event');
  if (!env.PULUMI_STACK_CONFIG || !env.PULUMI_CONFIG_PASSPHRASE
    || !/^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(env.AWS_ROLE_ARN || '')
    || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '')) {
    fail('required configuration missing or invalid');
  }
  let config;
  try { config = yaml.load(env.PULUMI_STACK_CONFIG); } catch { /* Never print parser source excerpts. */ }
  if (!config || typeof config.encryptionsalt !== 'string' || !config.encryptionsalt
    || (config.secretsprovider && config.secretsprovider !== 'passphrase')
    || !['dbPassword', 'redisToken', 'adminPassword'].every(key =>
      typeof config.config?.[`prestashop:${key}`]?.secure === 'string'
      && config.config[`prestashop:${key}`].secure.length > 0)) {
    fail('encrypted stack configuration required');
  }
  return config;
}
function execute(mode, config) {
  const dir = fs.mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), 'pulumi-ci-'));
  fs.chmodSync(dir, 0o700);
  try {
    // Only this owned copy changes; retain salt/provider and encrypted blobs.
    delete config.config['aws:profile'];
    const configFile = path.join(dir, 'Pulumi.dev.yaml');
    fs.writeFileSync(configFile, yaml.dump(config), { mode: 0o600, flag: 'wx' });
    const deploy = mode === 'deploy';
    const docker = deploy ? { credHelpers: {
      [`${env.AWS_ROLE_ARN.split(':')[4]}.dkr.ecr.us-east-1.amazonaws.com`]: 'ecr-login',
    } } : {};
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(docker), { mode: 0o600, flag: 'wx' });
    const childEnv = { ...env, AWS_REGION: 'us-east-1', AWS_DEFAULT_REGION: 'us-east-1',
      DOCKER_CONFIG: dir, AWS_ECR_DISABLE_CACHE: 'true', AWS_ECR_CACHE_DIR: path.join(dir, 'ecr'),
      PULUMI_HOME: path.join(dir, 'pulumi'), PULUMI_SKIP_UPDATE_CHECK: 'true' };
    for (const key of ['AWS_PROFILE', 'AWS_DEFAULT_PROFILE', 'PULUMI_BACKEND_URL',
      'PULUMI_ACCESS_TOKEN', 'PULUMI_STACK_CONFIG', 'NODE_OPTIONS']) delete childEnv[key];
    const common = ['--stack', 'dev', '--non-interactive', '--suppress-outputs', '--config-file', configFile];
    function run(command, args) {
      const result = spawnSync('pulumi', [command, ...common, ...args], {
        cwd: project, env: childEnv, stdio: 'ignore',
      });
      if (result.status !== 0) fail(`${command} failed`);
    }
    // Main owns this fresh directory and plan; no PR artifacts or historical plans.
    const plan = path.join(dir, `${env.GITHUB_SHA}.plan.json`);
    if (deploy) fs.writeFileSync(plan, '', { mode: 0o600, flag: 'wx' });
    run('preview', deploy ? ['--save-plan', plan] : []);
    if (deploy) {
      if (!fs.statSync(plan).size) fail('preview did not produce a plan');
      fs.chmodSync(plan, 0o600);
      run('up', ['--yes', '--skip-preview', '--plan', plan]);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
try {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || !['check-preview', 'check-deploy', 'preview', 'deploy'].includes(mode)) {
    fail('usage: stack.cjs check-preview|check-deploy|preview|deploy');
  }
  const config = preflight(mode);
  if (mode.startsWith('check-')) process.stdout.write('CI stack: preflight passed\n');
  else { execute(mode, config); process.stdout.write(`CI stack: ${mode} succeeded\n`); }
} catch (error) {
  const safe = /^(usage:|untrusted event|required configuration|encrypted stack|preview failed|up failed|preview did not)/.test(error.message);
  process.stderr.write(`CI stack: ${safe ? error.message : 'operation failed'}\n`);
  process.exitCode = 1;
}
