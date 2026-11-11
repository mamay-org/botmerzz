'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const workflowDir = path.join(root, '.github/workflows');
const workflowPath = path.join(workflowDir, 'ci.yml');
const workflow = fs.readFileSync(workflowPath, 'utf8');
const deployWorkflowPath = path.join(workflowDir, 'deploy-homelab.yml');
const deployWorkflow = fs.readFileSync(deployWorkflowPath, 'utf8');
const deployJob = deployWorkflow.split(/^  deploy:\s*$/m)[1] || '';
const validateJob = deployWorkflow.split(/^  validate_release:\s*$/m)[1]?.split(/^  deploy:\s*$/m)[0] || '';
const activeWorkflows = fs.readdirSync(workflowDir)
  .filter(file => /\.ya?ml$/.test(file))
  .map(file => fs.readFileSync(path.join(workflowDir, file), 'utf8'))
  .join('\n');

test('GitHub-hosted CI uses disposable MySQL for destructive database integration tests', () => {
  assert.match(workflow, /runs-on:\s*ubuntu-latest/);
  assert.match(workflow, /image:\s*mysql:8\.4/);
  assert.match(workflow, /DB_HOST:\s*127\.0\.0\.1/);
  assert.match(workflow, /ALLOW_DESTRUCTIVE_DB_TESTS:\s*["']true["']/);
  assert.match(workflow, /run:\s*npm run test:integration/);
});

test('CI runs PR and main validation only on GitHub-hosted infrastructure', () => {
  assert.match(workflow, /pull_request:\s*\n\s+branches:\s*\[main\]/);
  assert.match(workflow, /push:\s*\n\s+branches:\s*\[main\]/);
  assert.match(workflow, /runs-on:\s*ubuntu-latest/);
  assert.doesNotMatch(workflow, /self-hosted|workflow_run|deploy:/);
});

test('deployment is triggered only by a completed main-branch CI run', () => {
  assert.match(deployWorkflow, /workflow_run:\s*\n\s+workflows:\s*\[CI\]\s*\n\s+types:\s*\[completed\]\s*\n\s+branches:\s*\[main\]/);
  assert.notEqual(deployJob, '', 'expected a deploy job in the homelab workflow');
  assert.match(deployJob, /needs:\s*validate_release/);
  assert.match(deployJob, /github\.event_name == 'workflow_run'/);
  assert.match(deployJob, /github\.event\.workflow_run\.event == 'push'/);
  assert.match(deployJob, /github\.event\.workflow_run\.head_branch == 'main'/);
  assert.match(deployJob, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(deployJob, /github\.event\.repository\.full_name == github\.repository/);
  assert.match(deployJob, /github\.event\.workflow_run\.repository\.full_name == github\.repository/);
  assert.match(deployJob, /github\.event\.workflow_run\.head_repository\.full_name == github\.repository/);
  assert.match(deployJob, /runs-on:\s*\[self-hosted,\s*linux,\s*x64,\s*botmerzz-lxc-10027\]/);
  assert.match(deployJob, /needs\.validate_release\.outputs\.workflow_name == 'CI'/);
  assert.match(deployJob, /needs\.validate_release\.outputs\.workflow_path == '\.github\/workflows\/ci\.yml'/);
  for (const field of ['event', 'branch', 'conclusion', 'repository', 'head_repository', 'commit_sha']) {
    assert.match(deployJob, new RegExp(`needs\\.validate_release\\.outputs\\.${field} ==`));
  }
  assert.doesNotMatch(deployWorkflow, /pull_request_target|workflow_dispatch/);
});

test('workflow-run validation checks source name/path, event, branch, conclusion, repositories, and full SHA before checkout', () => {
  assert.match(validateJob, /run\.name !== 'CI'/);
  assert.match(validateJob, /run\.event !== 'push'/);
  assert.match(validateJob, /run\.head_branch !== 'main'/);
  assert.match(validateJob, /run\.conclusion !== 'success'/);
  assert.match(validateJob, /run\.status !== 'completed'/);
  assert.match(validateJob, /repository !== expectedRepository/);
  assert.match(validateJob, /run\.repository\?\.full_name !== expectedRepository/);
  assert.match(validateJob, /run\.head_repository\?\.full_name !== expectedRepository/);
  assert.match(validateJob, /\^\[a-f0-9\]\{40\}\$/);
  assert.match(validateJob, /Number\.isSafeInteger\(run\.id\)/);
  assert.match(validateJob, /github\.rest\.actions\.getWorkflowRun/);
  assert.match(validateJob, /github\.rest\.actions\.getWorkflow/);
  assert.match(validateJob, /verifiedRun\.head_sha !== run\.head_sha/);
  assert.match(validateJob, /workflowResponse\.data\.path !== '\.github\/workflows\/ci\.yml'/);
  assert.match(validateJob, /workflowResponse\.data\.name !== 'CI'/);
  assert.doesNotMatch(validateJob, /actions\/checkout|download-artifact|upload-artifact/);
});

test('deployment checks out only the validated SHA and refuses stale releases before mutation', () => {
  assert.match(deployJob, /ref:\s*\$\{\{\s*needs\.validate_release\.outputs\.commit_sha\s*\}\}/);
  assert.match(deployJob, /check-release-head/);
  assert.match(deployJob, /RELEASE_COMMIT_SHA:\s*\$\{\{\s*needs\.validate_release\.outputs\.commit_sha\s*\}\}/);
  assert.ok(deployJob.indexOf('check-release-head') < deployJob.indexOf('bash scripts/deploy-homelab.sh'));
  assert.match(deployJob, /BOTMERZZ_COMMIT_SHA:\s*\$\{\{\s*needs\.validate_release\.outputs\.commit_sha\s*\}\}/);
  assert.doesNotMatch(deployWorkflow, /download-artifact|upload-artifact/);
  assert.match(deployJob, /bash scripts\/deploy-homelab\.sh/);
});

test('deployment runs serially without cancellation and gets read-only repository access', () => {
  assert.match(deployJob, /group:\s*botmerzz-[^\n]+/);
  assert.match(deployJob, /cancel-in-progress:\s*false/);
  assert.match(deployJob, /permissions:\s*\n\s+actions:\s*read\s*\n\s+contents:\s*read/);
  assert.match(deployWorkflow, /permissions:\s*\n\s+actions:\s*read\s*\n\s+contents:\s*read/);
  assert.doesNotMatch(deployWorkflow, /packages:\s*(write|read)|contents:\s*write|id-token:\s*write/);
});

test('active workflows contain no registry or VPS deployment path', () => {
  assert.doesNotMatch(activeWorkflows, /ghcr\.io|STAGING_SSH|deploy-staging|compose\.vps/i);
  assert.equal((activeWorkflows.match(/workflow_run:/g) || []).length, 1);
  assert.doesNotMatch(workflow, /self-hosted|workflow_run|deploy:/);
  for (const obsolete of [
    '.github/workflows/publish.yml',
    'compose.vps.yaml',
    'scripts/deploy-staging.sh',
    'test/deploy-staging.test.js',
  ]) {
    assert.equal(fs.existsSync(path.join(root, obsolete)), false, `${obsolete} should be removed`);
  }
});
