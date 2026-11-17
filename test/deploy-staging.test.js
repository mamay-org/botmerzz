const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { gzipSync } = require('node:zlib');

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

function deployHarness(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botmerzz-deploy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const commit = 'a'.repeat(40);
  const image = `ghcr.io/mamay-org/botmerzz@sha256:${'b'.repeat(64)}`;
  const script = path.join(dir, 'deploy-staging.sh.next.123');
  const compose = path.join(dir, 'compose.vps.yaml.next.123');
  const retry = path.join(dir, 'retry-command.sh.next.123');
  const auth = path.join(dir, '.ghcr-auth-123');
  const log = path.join(dir, 'docker.log');
  fs.mkdirSync(auth);
  fs.mkdirSync(path.join(dir, 'backups'));
  fs.writeFileSync(path.join(auth, 'config.json'), '{}');
  fs.writeFileSync(path.join(dir, '.env'), 'APP_IMAGE=old-image\nBASE_URL=https://example.test\n');
  fs.writeFileSync(path.join(dir, 'compose.vps.yaml'), 'old compose');
  fs.writeFileSync(path.join(dir, 'backups', 'predeploy-old.sql.gz'), 'keep');
  fs.utimesSync(path.join(dir, 'backups', 'predeploy-old.sql.gz'), new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
  fs.writeFileSync(compose, 'new compose');
  fs.writeFileSync(retry, '#!/bin/bash\n"$@"\n', { mode: 0o700 });
  fs.writeFileSync(script, fs.readFileSync(path.join(root, 'scripts/deploy-staging.sh'), 'utf8').replaceAll('/opt/botmerzz-staging', dir), { mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'flock'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'curl'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'docker'), `#!/bin/bash
printf '%s\\n' "$*" >> "$DOCKER_LOG"
case "$*" in
  *'config --format json'*) printf '%s' "$SAFE_CONFIG" ;;
  *'exec -T db'*mysqldump*) printf '%s' 'synthetic dump' ;;
  *'exec -T db'*schema_migrations*) printf '%s' "\${DB_HAS_019:-1}" ;;
  *'up -d --no-deps'*) [[ "\${UP_FAIL:-0}" != 1 ]] ;;
  *'ps -q app'*) printf '%s\\n' "\${PS_IDS:-container-id}" ;;
  'image inspect'*) printf 'sha256:config-id\\n' ;;
  'inspect --format'*) printf 'sha256:config-id\\n' ;;
  'inspect container-id'*) if [[ -e "$INSPECT_SEEN" ]]; then printf '%s' "$RUNTIME_AFTER"; else : > "$INSPECT_SEEN"; printf '%s' "$RUNTIME_CONFIG"; fi ;;
esac
`, { mode: 0o700 });
  const names = ['CAPTURE', 'ACTIVATION', 'RETRIEVAL', 'PROMPT_INTEGRATION', 'SHADOW', 'RETENTION'];
  const flags = Object.fromEntries(names.map(name => [`LEARNING_${name}_ENABLED`, 'false']));
  if (options.unsafe) flags.LEARNING_CAPTURE_ENABLED = 'true';
  flags.SCHEDULER_ENABLED = 'false';
  return { dir, commit, image, log, run(extra = {}) { return spawnSync('bash', [script, commit, image, compose, retry], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DOCKER_CONFIG: auth,
      DOCKER_LOG: log, SAFE_CONFIG: JSON.stringify({ services: { app: { environment: flags } } }),
      INSPECT_SEEN: path.join(dir, 'inspect-seen'),
      RUNTIME_CONFIG: JSON.stringify([{ Config: { Env: Object.entries(flags).map(([k, v]) => `${k}=${v}`) } }]),
      RUNTIME_AFTER: JSON.stringify([{ Config: { Env: Object.entries(flags).map(([k, v]) => `${k}=${v}`) } }]), ...extra },
  }); } };
}

test('deployment checks flags and backup, keeps older backups and uses only app replacement', (t) => {
  const h = deployHarness(t);
  const result = h.run();
  assert.equal(result.status, 0, result.stderr);
  const calls = fs.readFileSync(h.log, 'utf8');
  assert.match(calls, /up -d --no-deps --wait --wait-timeout 240 app/);
  assert.equal(fs.readFileSync(path.join(h.dir, 'backups', 'predeploy-old.sql.gz'), 'utf8'), 'keep');
  assert.ok(fs.readdirSync(path.join(h.dir, 'backups')).some(f => f.endsWith('.env')));
});

test('unsafe incoming Learning flag blocks app replacement', (t) => {
  const h = deployHarness(t, { unsafe: true });
  const result = h.run();
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(fs.readFileSync(h.log, 'utf8'), /up -d --no-deps/);
  assert.match(fs.readFileSync(path.join(h.dir, '.env'), 'utf8'), /APP_IMAGE=old-image/);
});

test('first Learning migration without verified backup and approved plan blocks startup', (t) => {
  const h = deployHarness(t);
  const result = h.run({ DB_HAS_019: '0' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /backup, restore and plan evidence/);
  assert.doesNotMatch(fs.readFileSync(h.log, 'utf8'), /up -d --no-deps/);
  assert.match(fs.readFileSync(path.join(h.dir, '.env'), 'utf8'), /APP_IMAGE=old-image/);
});

test('first upgrade requires release-bound restore and approved-plan evidence', (t) => {
  const h = deployHarness(t);
  const prefix = path.join(h.dir, 'backups', `first-learning-upgrade-${h.commit}`);
  const backup = gzipSync('synthetic isolated backup');
  const plan = Buffer.from('approved isolated plan');
  const sha = value => createHash('sha256').update(value).digest('hex');
  fs.writeFileSync(`${prefix}.sql.gz`, backup);
  fs.writeFileSync(`${prefix}.plan`, plan);
  fs.writeFileSync(`${prefix}.evidence`, `image=${h.image}\nbackup_sha256=${sha(backup)}\nplan_sha256=${sha(plan)}\nrestore_verified=yes\nplan_approved=yes\n`);
  const result = h.run({ DB_HAS_019: '0' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(h.log, 'utf8'), /up -d --no-deps/);
});

test('modified backup is rejected despite a restore attestation', (t) => {
  const h = deployHarness(t);
  const prefix = path.join(h.dir, 'backups', `first-learning-upgrade-${h.commit}`);
  fs.writeFileSync(`${prefix}.sql.gz`, gzipSync('different backup'));
  fs.writeFileSync(`${prefix}.plan`, 'approved plan');
  fs.writeFileSync(`${prefix}.evidence`, `image=${h.image}\nbackup_sha256=${'0'.repeat(64)}\nplan_sha256=${'0'.repeat(64)}\nrestore_verified=yes\nplan_approved=yes\n`);
  const result = h.run({ DB_HAS_019: '0' });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(fs.readFileSync(h.log, 'utf8'), /up -d --no-deps/);
});

test('incoming scheduler change blocks replacement', (t) => {
  const h = deployHarness(t);
  const names = ['CAPTURE', 'ACTIVATION', 'RETRIEVAL', 'PROMPT_INTEGRATION', 'SHADOW', 'RETENTION'];
  const flags = Object.fromEntries(names.map(name => [`LEARNING_${name}_ENABLED`, 'false']));
  flags.SCHEDULER_ENABLED = 'true';
  const result = h.run({ SAFE_CONFIG: JSON.stringify({ services: { app: { environment: flags } } }) });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(fs.readFileSync(h.log, 'utf8'), /up -d --no-deps/);
});

test('multiple current app containers block replacement', (t) => {
  const h = deployHarness(t);
  const result = h.run({ PS_IDS: 'container-one\ncontainer-two' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exactly one current app container/);
  assert.doesNotMatch(fs.readFileSync(h.log, 'utf8'), /up -d --no-deps/);
});

test('mismatched running flags fail deployment without an automatic rollback', (t) => {
  const h = deployHarness(t);
  const result = h.run({ RUNTIME_AFTER: JSON.stringify([{ Config: { Env: ['SCHEDULER_ENABLED=false', 'LEARNING_CAPTURE_ENABLED=true'] } }]) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Running app configuration verification failed/);
  assert.equal((fs.readFileSync(h.log, 'utf8').match(/up -d --no-deps/g) || []).length, 1);
});

test('failure after startup attempt does not restart an old image against an unknown schema', (t) => {
  const h = deployHarness(t);
  const result = h.run({ UP_FAIL: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No automatic image rollback/);
  assert.equal((fs.readFileSync(h.log, 'utf8').match(/up -d --no-deps/g) || []).length, 1);
});
