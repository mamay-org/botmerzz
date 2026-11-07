const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const retryScript = path.join(root, 'scripts/retry-command.sh');

function createCommandHarness(t, { failCount = 0, alwaysFail = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'botmerzz-pull-retry-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const counter = path.join(directory, 'attempts');
  const docker = path.join(directory, 'docker');
  const sleep = path.join(directory, 'sleep');
  fs.writeFileSync(docker, [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'attempt=0',
    '[[ ! -f "$PULL_COUNTER_FILE" ]] || read -r attempt < "$PULL_COUNTER_FILE"',
    'attempt=$((attempt + 1))',
    'printf "%s\\n" "$attempt" > "$PULL_COUNTER_FILE"',
    'if [[ "${PULL_ALWAYS_FAIL:-false}" == true || "$attempt" -le "${PULL_FAIL_COUNT:-0}" ]]; then exit 1; fi',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o700 });
  fs.writeFileSync(sleep, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o700 });
  return {
    counter,
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      PULL_COUNTER_FILE: counter,
      PULL_FAIL_COUNT: String(failCount),
      PULL_ALWAYS_FAIL: String(alwaysFail),
    },
  };
}

test('GHCR pull retries transient failures with bounded backoff, then succeeds', (t) => {
  const harness = createCommandHarness(t, { failCount: 3 });
  const result = spawnSync('bash', [retryScript, 'docker', 'compose', 'pull', 'app'], {
    cwd: root, env: harness.env, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(harness.counter, 'utf8').trim(), '4');
  assert.match(result.stderr, /attempt 1\/4; retrying in 5s/);
  assert.match(result.stderr, /attempt 2\/4; retrying in 10s/);
  assert.match(result.stderr, /attempt 3\/4; retrying in 20s/);
});

test('GHCR pull stops after four failed attempts', (t) => {
  const harness = createCommandHarness(t, { alwaysFail: true });
  const result = spawnSync('bash', [retryScript, 'docker', 'compose', 'pull', 'app'], {
    cwd: root, env: harness.env, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.equal(fs.readFileSync(harness.counter, 'utf8').trim(), '4');
  assert.match(result.stderr, /Command failed after 4 attempts/);
});

test('staging deployment uploads the retry helper and diagnoses GHCR connectivity after a failed pull', () => {
  const deploy = fs.readFileSync(path.join(root, 'scripts/deploy-staging.sh'), 'utf8');
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/publish.yml'), 'utf8');
  const ciWorkflow = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /scripts\/retry-command\.sh/);
  assert.match(workflow, /remote_retry_helper="\$\{app_dir\}\/retry-command\.sh\.next\.\$\{GITHUB_RUN_ID\}"/);
  assert.match(workflow, /scp "\$\{ssh_args\[@\]\}" scripts\/retry-command\.sh "\$\{target\}:\$\{remote_retry_helper\}"/);
  assert.match(workflow, /\/bin\/bash '\$\{remote_script\}' '\$\{COMMIT_SHA\}' '\$\{IMAGE_REF\}' '\$\{remote_compose\}' '\$\{remote_retry_helper\}'/);
  assert.match(workflow, /rm -f --[^\n]*'\$\{remote_retry_helper\}'/);
  assert.match(deploy, /retry_helper_file/);
  assert.match(deploy, /rm -f -- "\$next_compose_file" "\$retry_helper_file" "\$deploy_script_file"/);
  assert.match(deploy, /! -f "\$retry_helper_file"/);
  assert.match(deploy, /curl[\s\S]*https:\/\/ghcr\.io\/v2\//);
  assert.match(deploy, /200\|401/);
  assert.match(ciWorkflow, /bash -n scripts\/deploy-staging\.sh && bash -n scripts\/retry-command\.sh/);
});
