const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const workflowPath = path.resolve(__dirname, '../../../.github/workflows/infrastructure.yml');
function workflow() { return yaml.load(fs.readFileSync(workflowPath, 'utf8')); }
test('only main PR and main push triggers; validation is unprivileged for every PR', () => {
  const w = workflow();
  assert.deepEqual(w.on, { pull_request: { branches: ['main'] }, push: { branches: ['main'] } });
  assert.deepEqual(w.permissions, {});
  const v = w.jobs.validate;
  assert.equal(v.if, undefined); assert.deepEqual(v.permissions, { contents: 'read' });
  assert.ok(!JSON.stringify(v).includes('secrets.'));
  const commands = v.steps.map(s => s.run || '').join('\n');
  for (const command of ['npm ci', 'npm run typecheck', 'npm test', 'node --test ci/tests/*.test.cjs']) assert.ok(commands.includes(command));
});
test('privileged event matrix and separate scheduling groups are fail closed', () => {
  const w = workflow();
  for (const mode of ['preview', 'deploy']) {
    const job = w.jobs[mode];
    assert.equal(job.needs, 'validate');
    assert.deepEqual(job.permissions, { contents: 'read', 'id-token': 'write' });
    assert.deepEqual(job.concurrency, {
      group: mode === 'deploy' ? 'prestashop-dev-s3' : 'prestashop-dev-preview',
      'cancel-in-progress': false,
    });
    // Evaluate GitHub's boolean expression against a bounded synthetic event matrix.
    const source = job.if.replace(/\$\{\{|\}\}/g, '').replaceAll('startsWith(', 'prefix(');
    const evaluate = github => Function('github', 'prefix', `return (${source});`)(github, (s, p) => s.startsWith(p));
    for (const [event, fork, branch, base, ref, expected] of [
      ['pull_request', false, 'feature/x', 'main', 'refs/pull/1/merge', 'preview'],
      ['pull_request', true, 'feature/x', 'main', 'refs/pull/1/merge', 'none'],
      ['pull_request', false, 'other/x', 'main', 'refs/pull/1/merge', 'none'],
      ['pull_request', false, 'feature/x', 'other', 'refs/pull/1/merge', 'none'],
      ['push', false, '', '', 'refs/heads/main', 'deploy'],
      ['push', false, '', '', 'refs/heads/feature/x', 'none'],
      ['workflow_dispatch', false, '', '', 'refs/heads/main', 'none'],
    ]) {
      const github = { event_name: event, repository: 'owner/repo', ref,
        event: { pull_request: { head: { repo: { full_name: fork ? 'fork/repo' : 'owner/repo' }, ref: branch }, base: { ref: base } } } };
      assert.equal(!!evaluate(github), expected === mode);
    }
    const credentials = job.steps.find(s => s.uses?.startsWith('aws-actions/'));
    assert.equal(credentials.with['aws-region'], 'us-east-1');
    assert.equal(credentials.with['role-to-assume'], `\${{ vars.AWS_${mode.toUpperCase()}_ROLE_ARN }}`);
    assert.ok(job.steps.findIndex(s => s.run?.includes('check-' + mode)) < job.steps.indexOf(credentials));
    assert.equal(job.env.PULUMI_STACK_CONFIG, undefined);
    for (const s of job.steps.filter(s => s.run?.includes('stack.cjs'))) {
      assert.equal(s.env.PULUMI_STACK_CONFIG, '${{ secrets.PULUMI_STACK_CONFIG }}');
      assert.equal(s.env.PULUMI_CONFIG_PASSPHRASE, '${{ secrets.PULUMI_CONFIG_PASSPHRASE }}');
      assert.ok(!s.run.includes('${{'));
    }
  }
});
test('PR preview cannot replace a pending main deployment or cancel its active predecessor', () => {
  const w = workflow();
  const groups = new Map();
  const canceled = [];
  function enqueue(event, id) {
    const job = w.jobs[event === 'push' ? 'deploy' : 'preview'];
    const key = job.concurrency.group;
    const state = groups.get(key) || { running: null, pending: null };
    // GitHub default: one running + one pending; new arrivals replace pending.
    if (state.running && job.concurrency['cancel-in-progress']) {
      canceled.push(state.running); state.running = null;
    }
    if (!state.running) state.running = id;
    else {
      if (state.pending) canceled.push(state.pending);
      state.pending = id;
    }
    groups.set(key, state);
  }
  enqueue('push', 'main-A');
  enqueue('push', 'main-B');
  enqueue('pull_request', 'preview-PR');
  const main = groups.get(w.jobs.deploy.concurrency.group);
  assert.deepEqual(main, { running: 'main-A', pending: 'main-B' });
  assert.deepEqual(canceled, []);
  assert.notEqual(w.jobs.preview.concurrency.group, w.jobs.deploy.concurrency.group);
  // Finishing A must promote B; the preview remains independently scheduled.
  main.running = main.pending; main.pending = null;
  assert.deepEqual(main, { running: 'main-B', pending: null });
  assert.deepEqual(groups.get(w.jobs.preview.concurrency.group), { running: 'preview-PR', pending: null });
});
test('all actions immutable; checkout credentials disabled; no plan/cache uploads', () => {
  const w = workflow();
  for (const job of Object.values(w.jobs)) {
    for (const step of job.steps) {
      if (step.uses) assert.match(step.uses, /^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
      if (step.uses?.startsWith('actions/checkout@')) assert.equal(step.with['persist-credentials'], false);
    }
    const text = JSON.stringify(job);
    for (const forbidden of ['upload-artifact', 'download-artifact', 'actions/cache', '--show-secrets', 'aws-access-key-id']) assert.ok(!text.includes(forbidden));
  }
});
