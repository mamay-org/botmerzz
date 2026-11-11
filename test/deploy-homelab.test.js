'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const deployScript = path.resolve(__dirname, '../scripts/deploy-homelab.sh');
const runtimeFlags = [
  'SCHEDULER_ENABLED',
  'LEARNING_CAPTURE_ENABLED',
  'LEARNING_ACTIVATION_ENABLED',
  'LEARNING_RETRIEVAL_ENABLED',
  'LEARNING_PROMPT_INTEGRATION_ENABLED',
  'LEARNING_SHADOW_ENABLED',
  'LEARNING_RETENTION_ENABLED',
];

function runGit(workspace, args) {
  return execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();
}

function commitSource(fixture, content = 'FROM node:22-bookworm-slim\n') {
  fs.writeFileSync(path.join(fixture.workspace, 'Dockerfile'), content);
  fs.writeFileSync(path.join(fixture.workspace, 'compose.yaml'), 'name: botmerzz\nservices: {}\n');
  if (!fs.existsSync(path.join(fixture.workspace, '.git'))) {
    runGit(fixture.workspace, ['init', '-q']);
    runGit(fixture.workspace, ['config', 'user.name', 'BotMerzz Test']);
    runGit(fixture.workspace, ['config', 'user.email', 'botmerzz@example.test']);
  }
  runGit(fixture.workspace, ['add', 'Dockerfile', 'compose.yaml']);
  runGit(fixture.workspace, ['commit', '-q', '-m', 'Test deployment source']);
  return runGit(fixture.workspace, ['rev-parse', 'HEAD']);
}

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botmerzz-deploy-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = {
    root,
    workspace: path.join(root, 'workspace'),
    appDir: path.join(root, 'opt', 'botmerzz'),
    bin: path.join(root, 'bin'),
    dockerLog: path.join(root, 'docker.log'),
    curlLog: path.join(root, 'curl.log'),
    envFile: path.join(root, 'opt', 'botmerzz', '.env'),
  };
  fs.mkdirSync(fixture.workspace, { recursive: true });
  fs.mkdirSync(fixture.appDir, { recursive: true });
  fs.mkdirSync(fixture.bin, { recursive: true });
  const envLines = [
    'NODE_ENV=production', 'PORT=3000', 'HOST_IP=192.168.0.27', 'HOST_PORT=3000',
    'BASE_URL=https://botmerzz.sequein.my.id', 'TIMEZONE=Asia/Kuala_Lumpur',
    'TRUST_PROXY=192.168.0.80', 'DB_HOST=db', 'DB_PORT=3306', 'DB_NAME=botmerzz',
    'DB_USER=botmerzz_app', 'DB_PASSWORD=test-db-secret-must-not-print',
    'DB_ROOT_PASSWORD=test-root-secret-must-not-print', 'DB_POOL_SIZE=5',
    ...runtimeFlags.map(flag => `${flag}=false`),
  ];
  fs.writeFileSync(fixture.envFile, `${envLines.join('\n')}\n`, { mode: 0o600 });
  fs.chmodSync(fixture.envFile, 0o600);

  fs.writeFileSync(path.join(fixture.bin, 'docker'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$DOCKER_LOG"
if [[ "$1" == context && "$2" == show ]]; then printf 'default\\n'; exit 0; fi
if [[ "$1" == context && "$2" == inspect ]]; then printf 'unix:///var/run/docker.sock\\n'; exit 0; fi
if [[ "$1" == info ]]; then exit 0; fi
if [[ "$1" == compose && "$2" == version ]]; then printf 'Docker Compose version v5.7.1\\n'; exit 0; fi
if [[ "$1" == volume && "$2" == inspect ]]; then [[ "\${FAKE_VOLUME_EXISTS:-false}" == true ]]; exit; fi
if [[ "$1" == build ]]; then exit "\${FAKE_BUILD_STATUS:-0}"; fi
if [[ "$1" == inspect ]]; then
  format="$3"
  case "$format" in
    *Config.Image*) printf 'botmerzz:%s\\n' "$FAKE_EXPECTED_SHA" ;;
    *org.opencontainers.image.revision*) printf '%s\\n' "$FAKE_EXPECTED_SHA" ;;
    *Config.Env*) printf '%s\\n' \\
      'SCHEDULER_ENABLED=false' \\
      'LEARNING_CAPTURE_ENABLED=false' \\
      'LEARNING_ACTIVATION_ENABLED=false' \\
      'LEARNING_RETRIEVAL_ENABLED=false' \\
      'LEARNING_PROMPT_INTEGRATION_ENABLED=false' \\
      'LEARNING_SHADOW_ENABLED=false' \\
      'LEARNING_RETENTION_ENABLED=false' ;;
    *) exit 2 ;;
  esac
  exit 0
fi
if [[ "$1" == compose ]]; then
  printf 'compose-env BOTMERZZ_IMAGE_TAG=%s BOTMERZZ_BUILD_CONTEXT=%s\\n' "\${BOTMERZZ_IMAGE_TAG:-}" "\${BOTMERZZ_BUILD_CONTEXT:-}" >> "$DOCKER_LOG"
  args=" $* "
  case "$args" in
    *' config --quiet '*) exit 0 ;;
    *' ps -q app '*) if [[ "\${FAKE_APP_RUNNING:-false}" == true ]] || grep -q 'up -d --no-deps --wait --wait-timeout 120 app' "$DOCKER_LOG"; then printf 'fake-container\\n'; fi; exit 0 ;;
    *' up -d --wait --wait-timeout 120 db '*) exit "\${FAKE_DB_STATUS:-0}" ;;
    *' run --rm --no-deps app npm run migrate '*) exit "\${FAKE_MIGRATE_STATUS:-0}" ;;
    *' stop app '*) exit 0 ;;
    *' up -d --no-deps --wait --wait-timeout 120 app '*) exit "\${FAKE_APP_STATUS:-0}" ;;
    *) printf 'Unexpected fake compose command\\n' >&2; exit 2 ;;
  esac
fi
printf 'Unexpected fake docker command\\n' >&2
exit 2
`);
  fs.writeFileSync(path.join(fixture.bin, 'curl'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$CURL_LOG"
exit "\${FAKE_CURL_STATUS:-0}"
`);
  fs.chmodSync(path.join(fixture.bin, 'docker'), 0o755);
  fs.chmodSync(path.join(fixture.bin, 'curl'), 0o755);
  fixture.sha = commitSource(fixture);
  return fixture;
}

function deploymentEnv(fixture, sha, extra = {}) {
  return {
    ...process.env,
    PATH: `${fixture.bin}:${process.env.PATH}`,
    DOCKER_LOG: fixture.dockerLog,
    CURL_LOG: fixture.curlLog,
    GITHUB_EVENT_NAME: 'workflow_run',
    GITHUB_REPOSITORY: 'mamay-org/botmerzz',
    GITHUB_WORKSPACE: fixture.workspace,
    GITHUB_RUN_ID: '12345',
    BOTMERZZ_CI_WORKFLOW_NAME: 'CI',
    BOTMERZZ_CI_WORKFLOW_PATH: '.github/workflows/ci.yml',
    BOTMERZZ_CI_EVENT: 'push',
    BOTMERZZ_CI_BRANCH: 'main',
    BOTMERZZ_CI_CONCLUSION: 'success',
    BOTMERZZ_CI_REPOSITORY: 'mamay-org/botmerzz',
    BOTMERZZ_CI_HEAD_REPOSITORY: 'mamay-org/botmerzz',
    BOTMERZZ_COMMIT_SHA: sha,
    BOTMERZZ_EXPECTED_MAIN_SHA: sha,
    BOTMERZZ_APP_DIR: fixture.appDir,
    BOTMERZZ_TEST_MODE: '1',
    BOTMERZZ_HEALTH_RETRIES: '1',
    BOTMERZZ_HEALTH_RETRY_DELAY: '0',
    FAKE_EXPECTED_SHA: sha,
    ...extra,
  };
}

function deploy(fixture, sha, extra = {}) {
  return spawnSync('bash', [deployScript], {
    cwd: fixture.workspace,
    env: deploymentEnv(fixture, sha, extra),
    encoding: 'utf8',
    timeout: 15_000,
  });
}

function logText(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

test('deployment rejects PR, non-main, failed-CI, fork, and stale release metadata before Docker mutations', t => {
  const fixture = createFixture(t);
  for (const extra of [
    { BOTMERZZ_CI_EVENT: 'pull_request' },
    { BOTMERZZ_CI_BRANCH: 'feature/untrusted' },
    { BOTMERZZ_CI_CONCLUSION: 'failure' },
    { BOTMERZZ_CI_HEAD_REPOSITORY: 'attacker/botmerzz' },
    { BOTMERZZ_EXPECTED_MAIN_SHA: 'f'.repeat(40) },
  ]) {
    const result = deploy(fixture, fixture.sha, extra);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CI provenance.*refusing/i);
  }
  assert.equal(logText(fixture.dockerLog), '');
});

test('first bootstrap refuses scheduler or Learning execution before starting the app', t => {
  const fixture = createFixture(t);
  fs.appendFileSync(fixture.envFile, 'SCHEDULER_ENABLED=true\n');
  const result = deploy(fixture, fixture.sha);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /initial bootstrap.*disabled/i);
  assert.equal(logText(fixture.dockerLog).includes('build '), false);
  assert.equal(fs.existsSync(path.join(fixture.appDir, 'active')), false);
});

test('fresh deployment builds the exact commit locally, migrates, verifies readiness and revision, and preserves the local environment', t => {
  const fixture = createFixture(t);
  const envBefore = fs.readFileSync(fixture.envFile);
  const result = deploy(fixture, fixture.sha, {
    BOTMERZZ_IMAGE_TAG: 'stale-runner-image',
    BOTMERZZ_BUILD_CONTEXT: '/tmp/untrusted-build-context',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, new RegExp(`Deployment succeeded.*${fixture.sha}`));
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /test-db-secret-must-not-print|test-root-secret-must-not-print/);
  assert.equal(fs.readFileSync(fixture.envFile).equals(envBefore), true);
  assert.equal(fs.statSync(fixture.envFile).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(fixture.appDir, 'source', fixture.sha, '.env')), false);
  assert.equal(fs.readFileSync(path.join(fixture.appDir, 'source', fixture.sha, '.botmerzz-commit'), 'utf8').trim(), fixture.sha);
  assert.equal(fs.readlinkSync(path.join(fixture.appDir, 'active')), `releases/${fixture.sha}`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.appDir, 'releases', fixture.sha, 'metadata.json'), 'utf8')).commit, fixture.sha);
  const commands = logText(fixture.dockerLog);
  assert.match(fs.readFileSync(path.join(fixture.appDir, 'releases', fixture.sha, 'release.env'), 'utf8'), new RegExp(`^BOTMERZZ_IMAGE_TAG=${fixture.sha}\\nBOTMERZZ_BUILD_CONTEXT=${fixture.appDir}/source/${fixture.sha}\\n$`));
  assert.doesNotMatch(commands, /stale-runner-image|untrusted-build-context/);
  assert.match(commands, new RegExp(`build .*--target runtime .*--build-arg VCS_REF=${fixture.sha} .*--tag botmerzz:${fixture.sha}`));
  assert.match(commands, /run --rm --no-deps app npm run migrate/);
  assert.match(commands, /up -d --wait --wait-timeout 120 db/);
  assert.match(commands, /up -d --no-deps --wait --wait-timeout 120 app/);
  assert.match(logText(fixture.curlLog), /192\.168\.0\.27:3000\/health\/ready/);
  assert.doesNotMatch(commands, /down -v|volume rm|image prune|image rm|ghcr\.io|ssh /i);
});

test('successful release switches to its SHA and retains the previous release reference; failed health never promotes', t => {
  const fixture = createFixture(t);
  const first = deploy(fixture, fixture.sha);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const previousSha = fixture.sha;
  fixture.sha = commitSource(fixture, 'FROM node:22-bookworm-slim\n# second release\n');
  const second = deploy(fixture, fixture.sha, { FAKE_APP_RUNNING: 'true', FAKE_VOLUME_EXISTS: 'true' });
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.equal(fs.readlinkSync(path.join(fixture.appDir, 'active')), `releases/${fixture.sha}`);
  assert.equal(fs.readFileSync(path.join(fixture.appDir, 'previous-release'), 'utf8').trim(), previousSha);

  const promotedSha = fixture.sha;
  fixture.sha = commitSource(fixture, 'FROM node:22-bookworm-slim\n# failing release\n');
  const failed = deploy(fixture, fixture.sha, { FAKE_APP_RUNNING: 'true', FAKE_VOLUME_EXISTS: 'true', FAKE_CURL_STATUS: '22' });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /health check failed/i);
  assert.equal(fs.readlinkSync(path.join(fixture.appDir, 'active')), `releases/${promotedSha}`);
  assert.equal(fs.readFileSync(path.join(fixture.appDir, 'previous-release'), 'utf8').trim(), previousSha);
  assert.doesNotMatch(logText(fixture.dockerLog), /image prune|image rm|down -v|volume rm/i);
});

test('failed migration leaves the app stopped and active release unchanged', t => {
  const fixture = createFixture(t);
  const result = deploy(fixture, fixture.sha, { FAKE_MIGRATE_STATUS: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /migrations failed/i);
  const commands = logText(fixture.dockerLog);
  assert.match(commands, /run --rm --no-deps app npm run migrate/);
  assert.doesNotMatch(commands, /up -d --no-deps --wait --wait-timeout 120 app/);
  assert.equal(fs.existsSync(path.join(fixture.appDir, 'active')), false);
});

test('first deployment refuses an unexplained pre-existing persistent database volume', t => {
  const fixture = createFixture(t);
  const result = deploy(fixture, fixture.sha, { FAKE_VOLUME_EXISTS: 'true' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /existing MySQL volume.*refusing/i);
  assert.equal(logText(fixture.dockerLog).includes('build '), false);
  assert.equal(fs.existsSync(path.join(fixture.appDir, 'active')), false);
});
