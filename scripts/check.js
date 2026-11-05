const { readdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const root = resolve(__dirname, '..');
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : path.endsWith('.js') ? [path] : [];
  });
}
for (const folder of ['src', 'test', 'scripts']) {
  for (const file of walk(join(root, folder))) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) {
      process.stderr.write(result.stderr || `${file}: syntax check failed\n`);
      process.exit(result.status || 1);
    }
  }
}
process.stdout.write('JavaScript syntax checks passed.\n');
