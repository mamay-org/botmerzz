'use strict';

async function checkReleaseHead({ repository, commit, token, fetchImpl = fetch }) {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(repository || '') ||
      !/^[a-f0-9]{40}$/.test(commit || '') || !token) {
    throw new Error('Release head check is missing valid repository, commit, or authentication.');
  }
  let response;
  try {
    response = await fetchImpl(`https://api.github.com/repos/${repository}/git/ref/heads/main`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'botmerzz-release-check' },
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new Error('Unable to verify current main revision.');
  }
  if (!response?.ok) throw new Error('Unable to verify current main revision.');
  let head;
  try { head = (await response.json())?.object?.sha; }
  catch { throw new Error('Unable to verify current main revision.'); }
  if (!/^[a-f0-9]{40}$/.test(head || '')) throw new Error('Unable to verify current main revision.');
  if (head !== commit) throw new Error('Release revision is no longer the current main head; refusing deployment.');
}

if (require.main === module) {
  checkReleaseHead({ repository: process.env.GITHUB_REPOSITORY, commit: process.env.COMMIT_SHA, token: process.env.RELEASE_GITHUB_TOKEN })
    .then(() => process.stdout.write('Release revision matches current main head.\n'))
    .catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

module.exports = { checkReleaseHead };
