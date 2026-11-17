# AI Learning Center — Browser Acceptance

**Browser E2E:** PASS for the exercised workflows. **Browser and accessibility acceptance:** PARTIAL. This is not a full WCAG or product-acceptance pass.

## Environment and safeguards

- Local application process started by `e2e/learning.browser.e2e.js`.
- Disposable MySQL 8.4.13 on loopback, database `merzz_browser_test`.
- Headless Google Chrome 157.0.8103.39 through Playwright 1.62.1.
- No OpenRouter key, Tebar credentials, Telegram token, provider request, or Threads publishing.
- Scheduler was false. Activation was false at initial start; a later restart enabled only activation for explicit test lifecycle actions. Retrieval, prompt integration, shadow, provider, and scheduler remained disabled.
- The test asserts its app configuration stays isolated and cleans its fixture rows.
- A separate interactive browser-control host was unavailable. The browser evidence below comes from the automated headless E2E, not a manual browser or screen-reader session.

## Reproducible command

Substitute a local credential for the quoted placeholder. The database guard rejects a non-loopback host or any database other than the dedicated test schema.

```sh
env NODE_ENV=test ALLOW_DESTRUCTIVE_DB_TESTS=true DB_HOST=127.0.0.1 DB_PORT=33345 DB_USER=root DB_PASSWORD='replace-with-local-test-password' DB_NAME=merzz_browser_test BOTMERZZ_CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:learning:browser
```

**Earlier result:** 7 tests passed, 0 failed, 0 skipped (one parent test plus six browser subtests), 16.78 seconds. A fresh handoff rerun is recorded below. Tests use Playwright-controlled headless Chrome 157.0.8103.39; no native zoom or manual visual review was performed. No screenshot or trace artifact was captured.

## Automated browser scenarios

| Scenario | Result and evidence |
| --- | --- |
| Anonymous access and administrator login | PASS: anonymous candidates request returns 401; local admin login opens dashboard. |
| Navigation and asynchronous states | PASS: Learning tab opens; loading state, API error, retry, and recovery are exercised. |
| Candidate search/filter/pagination/empty state | PASS: filters status/source, searches category text, validates parameterized request, loads 100 plus remaining 4 records, hides next-page control at end, and displays the no-results state for a unique query. |
| Candidate details and evidence | PASS: details dialog opens with focus on its close control; unavailable caption evidence is disclosed; the original unsafe caption is not substituted. |
| Stored/reflected XSS rendering | PASS for tested `<img onerror>` payloads in candidate explanation/category, search result, approved rule text, administrator feedback, analytics label, and mocked API error: payload remains literal text, no image element is created, and the execution marker stays false. This is field-targeted evidence, not every output context. |
| Review decisions | PASS: keyboard Enter submits approve, reject, and false-positive transitions; persisted states are checked. Approved rules remain inactive when activation is disabled. |
| Rule lifecycle | PASS in isolated test configuration: explicit activation, deactivation, revision creation, version approval, activation of version 2, rollback to version 1, and audit actions. Native confirmation is observed for activation. |
| Human feedback | PASS: posting-history control fills the target slot; positive and negative ratings are submitted for distinct slots and persisted separately. Rendered quality metrics show 2/4 reviewed eligible captions, positive 1, negative 1, and the small-sample state. |
| Three-pillar analytics | PASS for displayed indicators and missing-data state. Browser opens compliance and quality details, selects 90 days, verifies the exact `from`/`to` interval and API echo, and receives HTTP 200. Effectiveness remains “Belum cukup data” in the fixture. |
| CSRF and SQL injection | PASS for tested probes: cross-origin candidate mutation returns 403 and leaves state unchanged; injection-shaped candidate search returns no results. |
| Keyboard input | Automated PASS for tested flows: Enter and Space activate the mobile sidebar; Enter opens and submits review controls; Tab and Shift+Tab stay within the candidate dialog and wrap in the mobile sidebar; Escape closes dialogs/sidebar and restores focus; arrow navigation changes the selected desktop tab. Focus visibility is asserted. This is not a manually completed keyboard-only audit. |
| Resource identifier handling | PASS for tested route probes: invalid rule ID returns 400; a validly formed but nonexistent candidate ID returns safe 404 `CANDIDATE_NOT_FOUND`; anonymous routes return 401; cross-origin state change returns 403 without changing the review row. |
| Responsive widths | PASS for horizontal overflow at 1920, 1440, 1280, 1024, 768, 390, and 320 CSS pixels. These are viewport widths, not browser-zoom tests. |
| Automated accessibility | PASS for Axe scans on dashboard and Learning review surfaces at 1280×900 with WCAG 2.0, 2.1, and 2.2 A/AA tags. Axe results do not cover all rendered states or replace manual review. |

## Manual accessibility status

| Check | Status | Evidence boundary |
| --- | --- | --- |
| Keyboard-only manual walkthrough | NOT EXECUTED | Automated key events cover details, candidate decisions, sidebar, and tab navigation; a human still needs to traverse the full interface and confirm focus/announcements. |
| 200% and 400% browser zoom/reflow | NOT EXECUTED | CSS viewport tests do not emulate Chrome zoom. |
| Full contrast review | NOT EXECUTED | Automated Axe and focused CSS contrast unit checks cover selected states/pairs only; they do not verify every text, control, status, focus, hover, and disabled state. |
| Screen reader | NOT EXECUTED | macOS VoiceOver is installed but was off and no VoiceOver session was performed. |

### Reproducible manual follow-up

Use [AI_LEARNING_MANUAL_ACCEPTANCE_CHECKLIST.md](AI_LEARNING_MANUAL_ACCEPTANCE_CHECKLIST.md), which records the exact route (`http://localhost:3000/`), action, expected announcement/focus behavior, evidence field, and an unfilled status for each manual step. It covers keyboard interaction, 100%/200%/400% zoom, visual contrast, and macOS Safari VoiceOver. No manual row has been pre-marked as passed.

During this verification, the computer-use browser host reported unavailable (`browsers: []`); Chrome and Safari were installed, but a native browser session was not controlled. VoiceOver was installed but off and was not enabled. Therefore keyboard-only manual review, actual zoom, full contrast, and all VoiceOver steps remain **NOT EXECUTED**. This requirement keeps browser/accessibility and P1 acceptance at **NO-GO** until a human performs and records the checklist. No production operation is authorized.

## Acceptance handoff rerun — 2026-11-10

The disposable browser schema was checked before execution and contained zero administrator rows, slots, or shadow evaluations. The exact command was:

```sh
set -a
. /tmp/botmerzz-ai-learning-manual-20261110.env
set +a
DB_NAME=merzz_browser_test \
  ALLOW_DESTRUCTIVE_DB_TESTS=true \
  BOTMERZZ_CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  npm run test:learning:browser
```

**Result:** 7 passed, 0 failed, 0 skipped in 16.09 seconds. The suite created a random administrator and browser fixtures, used local headless Chrome and isolated MySQL, and cleaned its fixture data. The disposable MySQL host port was verified as loopback-only (`127.0.0.1:33345`). No OpenRouter/Tebar/Threads credentials were supplied, no paid provider was called, and no publishing request occurred.

After the run, a direct count against the disposable schema returned 0 admins, 0 slots, 0 learning candidates, and 0 shadow evaluations.

Separately, a persistent local manual environment is prepared at `http://localhost:3000/` using schema `merzz_manual_test`; its health endpoint returned `{"status":"ready"}`. It contains one synthetic test administrator, four synthetic published slots, and three pending synthetic candidates. The server runs with scheduler and all Learning execution flags off. The test account credentials are provided to the local operator, not stored in this repository. Exact commands, route navigation, test-only activation confirmation, and cleanup are in [AI_LEARNING_MANUAL_ACCEPTANCE_CHECKLIST.md](AI_LEARNING_MANUAL_ACCEPTANCE_CHECKLIST.md).

No person used a physical keyboard, native Chrome zoom, visual contrast tool, Safari screen reader, or VoiceOver during the handoff rerun. Therefore every manual row remains unfilled and **NOT EXECUTED**. The persistent local environment makes those checks available; it does not make them passed. P1 acceptance remains **NO-GO** until the human evidence is recorded.

## Security and browser-output recheck — 2026-11-11

The current `npm run test:learning:browser` rerun completed **7 passed, 0 failed, 0 skipped** in 16.60 seconds against the disposable loopback MySQL schema and headless Chrome. The test fixture supplies an actual candidate row with a standalone prompt marker plus unsafe current-rule/version responses; the API withholds the candidate text, and the UI displays fixed withheld notices and a separate unavailable notice without rendering the canaries. Current-rule/version UI assertions use mocked responses; API mappings are verified by `test/learning-security.test.js` and `test/learning.mysql.integration.test.js`.

Automated Axe scans and keyboard events still pass for their exercised states. They do not establish the manual checklist. A fresh workspace check found all 23 rows (MAN-KBD-01–07, MAN-ZOOM-100/200/400, MAN-CON-01–05, MAN-VO-01–08) blank, with no tester/date/evidence fields completed. No manual PASS is reported. There was no confirmed manual accessibility defect to reproduce because no manual observation was present; human focus, zoom, contrast, and VoiceOver results remain pending.

The latest source/output review also fixed the current-rule and rule-version disclosure paths for supported sensitive values and explicit prompt labels; missing legacy instruction text is separately identified as unavailable. See [AI_LEARNING_SECURITY_TEST_MATRIX.md](AI_LEARNING_SECURITY_TEST_MATRIX.md) and [AI_LEARNING_P1_ACCEPTANCE.md](AI_LEARNING_P1_ACCEPTANCE.md). This does not change the separate manual accessibility status or production NO-GO.

## Final acceptance recheck — 2026-11-11

The latest local headless Chrome command, `npm run test:learning:browser`, completed **7 passed, 0 failed, 0 skipped** in 16.02 seconds against disposable loopback MySQL. Existing browser assertions cover admin sign-in, Learning navigation, loading/error and filter states, candidate details and text-only rendering, feedback, metrics insufficiency, lifecycle in a disposable process, scripted keyboard events, and seven viewport widths. No provider credentials were supplied; no publishing request occurred.

The API output fix also covers candidate/feedback explanations and decision/history reasons, shadow captions, action metadata, shadow model/context identifiers, and ratings. Synthetic canaries are tested in `test/learning-security.test.js`, `test/learning-shadow.test.js`, and `test/learning-shadow.mysql.integration.test.js`. The browser renderer continues to use text nodes. No new manual finding was available to reproduce.

Automated E2E, Axe and scripted keyboard actions remain **automated evidence only**. All 23 manual rows in `AI_LEARNING_MANUAL_ACCEPTANCE_CHECKLIST.md` remain unrecorded: 7 keyboard, 3 browser zoom/reflow, 5 contrast, and 8 Safari VoiceOver. Do not count the seven CSS viewport widths as native browser zoom. There are no manual PASS results in this report. P1 acceptance remains **NO-GO** until required observations are recorded; production readiness remains separately **NO-GO**.

## Latest browser/security acceptance run — 2026-11-11

The final Chrome run used:

```sh
BM_TEST_DB_PASS=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' botmerzz-p1-final-mysql | sed -n 's/^MYSQL_ROOT_PASSWORD=//p')
env -i PATH="$PATH" HOME="/tmp/botmerzz-learning-e2e-home" NODE_ENV=test ALLOW_DESTRUCTIVE_DB_TESTS=true DB_HOST=127.0.0.1 DB_PORT=33345 DB_USER=root DB_PASSWORD="$BM_TEST_DB_PASS" DB_NAME=merzz_browser_test BOTMERZZ_CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' OPENROUTER_API_KEY='' TEBAR_API_KEY='' TELEGRAM_BOT_TOKEN='' npm run test:learning:browser
```

Observed: **7 passed, 0 failed, 0 skipped**, duration **15.79 s**. This used disposable loopback MySQL 8.4.13 and local headless Chrome. Provider and messaging credentials were empty; scheduler/publishing and Learning execution flags remained disabled except the explicit isolated rule lifecycle activation test. No real provider call or Threads request occurred.

One preceding run failed at the feedback XSS fixture because the test typed before the app’s next-animation-frame focus transfer from the history button to the slot ID field. The failure was reproduced twice. The test now explicitly waits until the slot field owns focus, preserving the XSS value assertion; the final full run passed. No user-facing accessibility defect was evidenced by this race.

The browser test covers automated auth rejection, admin login, Learning navigation, loading/error and filtering states, text-only XSS handling, review lifecycle, focus handoff, feedback, metric insufficiency, keyboard dialog interactions, Axe scans and seven viewport widths. These do not verify actual keyboard-only usage beyond scripted actions, native browser zoom at 100/200/400%, visual contrast measurements, or Safari VoiceOver.

The manual checklist remains **NOT EXECUTED**: its 23 rows have no observations, evidence, tester/date or PASS/FAIL values. No manual outcomes are inferred from the E2E results. P1 acceptance therefore remains **NO-GO** pending those results and owner confirmation of the documented workspace-wide admin audience; production activation remains separately **NO-GO** pending production-only gates.

## Privacy-notice regression — 2026-11-11

After adding the workspace-wide administrator visibility/data-minimization notice and aligning UI max lengths with server validation, the directly affected browser suite was rerun with empty provider credentials and isolated MySQL: **7 passed, 0 failed, 0 skipped** in **16.28 s**. Browser assertions verify the notice and associated descriptions on feedback, candidate/revision instructions and rationales, decision reasons, and their max lengths; the Axe checks in the suite also passed. `node --test test/learning-ui.contract.test.js` passed **5/5**. This verifies browser rendering and markup associations, not whether VoiceOver announces them correctly; manual VoiceOver rows remain pending.

These automated results do not complete any manual checklist row. No full unrelated regression suite was rerun because this was a markup/accessibility-label change.

## Risk-based release update — 2026-11-11

The current user's risk-based instruction supersedes earlier statements that missing manual rows automatically block all deployment. A fresh `npm run test:learning:browser` run passed **7/7** in **15.99 seconds** against disposable MySQL and local Chrome 157. It covers the exercised admin, Learning lifecycle, validation, feedback, analytics, scripted keyboard/Axe, and viewport paths; it does not establish native zoom, full physical keyboard, visual contrast, or VoiceOver behavior.

All 23 manual rows remain **NOT EXECUTED**, not PASS. This gap is an accepted important residual for application deployment with Learning execution flags off. The accessibility owner should complete the checklist before broad administrator rollout; any high-impact defect found remains release-blocking. The user confirmed workspace-wide active-admin access; no authorization-model change was made.
