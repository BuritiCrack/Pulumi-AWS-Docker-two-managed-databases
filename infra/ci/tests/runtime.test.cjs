const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');
const cli = path.resolve(__dirname, '../runtime/stack.cjs');
const fixture = {
  encryptionsalt: 'synthetic-original-salt',
  config: { 'aws:profile': 'local-only', 'aws:region': 'us-east-1',
    'prestashop:dbPassword': { secure: 'encrypted-db' },
    'prestashop:redisToken': { secure: 'encrypted-redis' },
    'prestashop:adminPassword': { secure: 'encrypted-admin' } },
};
function invoke(mode, changes = {}, fail = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-stack-test-'));
  try {
    const record = path.join(dir, 'calls.json');
    const hook = path.join(dir, 'hook.cjs');
    // Intercept only the OS command boundary; exercise the real public CLI.
    fs.writeFileSync(hook, `
      const fs = require('node:fs');
      const cp = require('node:child_process');
      const calls = [];
      cp.spawnSync = (cmd, args, opts) => {
        const config = args.includes('--config-file') ? args[args.indexOf('--config-file') + 1] : null;
        calls.push({cmd, args, config: config && fs.readFileSync(config, 'utf8'),
          mode: config && (fs.statSync(config).mode & 511), docker: opts.env.DOCKER_CONFIG,
          dockerConfig: fs.readFileSync(opts.env.DOCKER_CONFIG + '/config.json', 'utf8'),
          backend: opts.env.PULUMI_BACKEND_URL, profile: opts.env.AWS_PROFILE,
          cache: opts.env.AWS_ECR_DISABLE_CACHE, cwd: opts.cwd});
        fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(calls));
        if (args[0] === 'preview' && args.includes('--save-plan') && ${JSON.stringify(fail)} !== 'no-plan') {
          fs.writeFileSync(args[args.indexOf('--save-plan') + 1], 'synthetic-current-plan');
        }
        return {status: args[0] === ${JSON.stringify(fail)} ? 1 : 0};
      };
    `);
    const env = { ...process.env, RUNNER_TEMP: dir, CI_EVENT: 'pull_request',
      CI_REPOSITORY: 'owner/repo', CI_HEAD_REPOSITORY: 'owner/repo',
      CI_HEAD_REF: 'feature/test', CI_BASE_REF: 'main', GITHUB_REF: 'refs/pull/1/merge',
      GITHUB_SHA: 'a'.repeat(40), AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/preview',
      PULUMI_STACK_CONFIG: yaml.dump(fixture), PULUMI_CONFIG_PASSPHRASE: 'original-passphrase',
      AWS_PROFILE: 'must-not-inherit', PULUMI_BACKEND_URL: 'file://must-not-inherit',
      DOCKER_CONFIG: 'must-not-inherit', ...changes };
    const before = env.PULUMI_STACK_CONFIG;
    const result = spawnSync(process.execPath, ['--require', hook, cli, mode], { env, encoding: 'utf8' });
    const calls = fs.existsSync(record) ? JSON.parse(fs.readFileSync(record)) : [];
    assert.equal(env.PULUMI_STACK_CONFIG, before);
    assert.deepEqual(fs.readdirSync(dir).sort(), calls.length ? ['calls.json', 'hook.cjs'] : ['hook.cjs']);
    return { ...result, calls };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function rejected(result, message) {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `CI stack: ${message}\n`);
  assert.deepEqual(result.calls, []);
}
test('trust boundary rejects fork, non-feature, wrong base/event and deploy from PR', () => {
  for (const changes of [ { CI_HEAD_REPOSITORY: 'fork/repo' }, { CI_HEAD_REF: 'fix/x' },
    { CI_BASE_REF: 'other' }, { CI_EVENT: 'workflow_dispatch' } ]) {
    rejected(invoke('preview', changes), 'untrusted event');
  }
  rejected(invoke('deploy'), 'untrusted event');
  rejected(invoke('deploy', { CI_EVENT: 'push', GITHUB_REF: 'refs/heads/feature/test' }), 'untrusted event');
  rejected(invoke('unknown'), 'usage: stack.cjs check-preview|check-deploy|preview|deploy');
});
test('secrets and role fail closed before any command or persistent write', () => {
  for (const key of ['PULUMI_STACK_CONFIG', 'PULUMI_CONFIG_PASSPHRASE', 'AWS_ROLE_ARN']) {
    rejected(invoke('check-preview', { [key]: '' }), 'required configuration missing or invalid');
  }
  for (const config of ['not: [yaml', yaml.dump({ config: {} }), yaml.dump({ ...fixture,
    config: { ...fixture.config, 'prestashop:dbPassword': 'plaintext' } })]) {
    rejected(invoke('preview', { PULUMI_STACK_CONFIG: config }), 'encrypted stack configuration required');
  }
  rejected(invoke('preview', { AWS_ROLE_ARN: 'not-an-arn' }), 'required configuration missing or invalid');
  rejected(invoke('deploy', { ...main, GITHUB_SHA: 'not-a-commit' }), 'required configuration missing or invalid');
});
test('preflight succeeds without running tools or materializing secrets', () => {
  const r = invoke('check-preview');
  assert.equal(r.status, 0); assert.equal(r.stdout, 'CI stack: preflight passed\n');
  assert.equal(r.stderr, ''); assert.deepEqual(r.calls, []);
});
test('preview preserves ciphertext/provider, drops local profile only in ephemeral copy', () => {
  const r = invoke('preview');
  assert.equal(r.status, 0); assert.equal(r.stdout, 'CI stack: preview succeeded\n'); assert.equal(r.stderr, '');
  assert.equal(r.calls.length, 1);
  const c = r.calls[0];
  const expected = structuredClone(fixture); delete expected.config['aws:profile'];
  assert.deepEqual(yaml.load(c.config), expected);
  if (process.platform !== 'win32') assert.equal(c.mode, 0o600);
  assert.equal(c.profile, undefined); assert.equal(c.backend, undefined);
  assert.deepEqual(JSON.parse(c.dockerConfig), {});
  assert.deepEqual(c.args.slice(0, 6), ['preview', '--stack', 'dev', '--non-interactive', '--suppress-outputs', '--config-file']);
  assert.ok(!c.args.includes('--save-plan')); assert.ok(!c.args.includes('--show-secrets'));
});
const main = { CI_EVENT: 'push', GITHUB_REF: 'refs/heads/main' };
test('main creates and enforces its own plan, with isolated ECR helper configuration', () => {
  const r = invoke('deploy', main);
  assert.equal(r.status, 0); assert.equal(r.stdout, 'CI stack: deploy succeeded\n'); assert.equal(r.stderr, '');
  assert.equal(r.calls.length, 2);
  const [preview, up] = r.calls;
  assert.equal(preview.args[0], 'preview'); assert.equal(up.args[0], 'up');
  assert.equal(preview.args.at(-1), up.args[up.args.indexOf('--plan') + 1]);
  assert.ok(up.args.includes('--yes')); assert.ok(up.args.includes('--skip-preview'));
  assert.equal(up.cache, 'true');
  assert.deepEqual(JSON.parse(up.dockerConfig), { credHelpers: { '123456789012.dkr.ecr.us-east-1.amazonaws.com': 'ecr-login' } });
});
test('failed main preview never applies and suppresses tool output', () => {
  const r = invoke('deploy', main, 'preview');
  assert.equal(r.status, 1); assert.equal(r.stdout, ''); assert.equal(r.stderr, 'CI stack: preview failed\n');
  assert.equal(r.calls.length, 1);
});
test('absent fresh plan fails closed; failed apply still cleans up', () => {
  const missing = invoke('deploy', main, 'no-plan');
  assert.equal(missing.status, 1); assert.equal(missing.stdout, '');
  assert.equal(missing.stderr, 'CI stack: preview did not produce a plan\n');
  assert.equal(missing.calls.length, 1);
  const failed = invoke('deploy', main, 'up');
  assert.equal(failed.status, 1); assert.equal(failed.stdout, '');
  assert.equal(failed.stderr, 'CI stack: up failed\n'); assert.equal(failed.calls.length, 2);
});
