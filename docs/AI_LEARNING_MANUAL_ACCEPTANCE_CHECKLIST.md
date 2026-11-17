# AI Learning Center — Manual Acceptance Checklist

**Status:** PENDING. No manual accessibility check in this document has been performed or pre-approved.

This checklist is for an administrator using a local, isolated test deployment. Do not use production credentials, a production database, or an account with live publishing enabled. Browser automation and Axe results are recorded separately in [AI_LEARNING_BROWSER_ACCEPTANCE.md](AI_LEARNING_BROWSER_ACCEPTANCE.md); they do not fill in these observations.

## Verified local test environment

The handoff environment was prepared and checked on 2026-11-10:

- Disposable MySQL 8.4.13 container: `botmerzz-p1-final-mysql`, host binding `127.0.0.1:33345` (verified with `docker inspect` and `docker ps`). Its original published volume was preserved when correcting the port binding.
- Dedicated schema: `merzz_manual_test`; 19 migrations applied.
- One active synthetic administrator, four synthetic published slots, three pending synthetic validation candidates, and no learning rules before review. These are test records, not real posts.
- Application: `http://localhost:3000/`; `/health/ready` returned `{"status":"ready"}`.
- The environment was rechecked on 2026-11-11: the named MySQL container was running with `127.0.0.1:33345` binding and `curl --fail --silent --show-error http://localhost:3000/health/ready` returned `{"status":"ready"}`. The app and DB are disposable local acceptance fixtures.
- Scheduler, provider credentials, capture, retrieval, prompt integration, shadow evaluation, and retention are off. Activation is also off in the normal app session.
- A mode-0600 environment file exists outside the repository at `/tmp/botmerzz-ai-learning-manual-20261110.env`. It contains only disposable database settings and blank provider credentials. Do not copy it into the repository or replace its database name with a production/development database.

The handoff review found that the initial disposable container published MySQL on all host interfaces. It was recreated with a loopback-only host binding using the same named database volume. The post-change check showed `127.0.0.1:33345->3306/tcp`; migrations reported 0 new migrations, the manual admin and all synthetic fixtures remained present, and the browser E2E passed again. No production infrastructure was involved.

The prepared server is already running for the handoff. To start it again after stopping it, use a terminal from the repository root:

```sh
docker start botmerzz-p1-final-mysql   # only if the disposable container is stopped
set -a
. /tmp/botmerzz-ai-learning-manual-20261110.env
set +a
npm run migrate
npm start
```

In a second terminal, load the same non-secret DB environment if needed and verify the server is ready:

```sh
curl --fail --silent --show-error http://localhost:3000/health/ready
```

Expected response: `{"status":"ready"}`.

The `npm run migrate` command is safe for this dedicated schema and was verified here. For a new temporary administrator in this isolated database, open a second terminal, load the same environment, and run the repository's interactive command:

```sh
set -a
. /tmp/botmerzz-ai-learning-manual-20261110.env
set +a
npm run admin:create
```

Choose a unique `.test` email and a new test-only password in the CLI prompts. The prepared account is `learning-manual-acceptance@example.test`; its password is supplied directly to the test operator and is intentionally not stored in this document. Do not reuse it elsewhere.

Open `http://localhost:3000/`, sign in, then select **AI Learning** (`#tab-button-learning`, panel `#tab-learning`). Candidate review, rules, audit, metrics, feedback, and shadow results are sections of this dashboard tab, not separate routes. The shadow form is visible but the server rejects starts while its flag is off. A successful review can create an approved inactive rule; that state is expected. Do not activate a rule for generation.

The user confirmed on 2026-11-11 that all active authorized administrators may read feedback and rule text across the workspace. The working data policy is administrator-only free text with data minimization. The Learning screen displays that audience and says not to enter personal data, passwords, access tokens, or secrets. The notice is referenced by free-text controls. This does not provide comprehensive PII detection or require structured-only fields. Use only synthetic test text in the manual fixtures.

The one manual row that needs the activation confirmation UI (`MAN-KBD-06`) requires an isolated restart with only the activation flag overridden. Stop the current app with Ctrl-C, then start it from a terminal with:

```sh
set -a
. /tmp/botmerzz-ai-learning-manual-20261110.env
set +a
LEARNING_ACTIVATION_ENABLED=true npm start
```

This is only for observing/canceling the local confirmation. Keep scheduler, retrieval, prompt integration, shadow, capture, retention, provider credentials, and publishing disabled; cancel the dialog and verify the lesson is still inactive. Stop that process and restart normally after the row. Do not enable retrieval or prompt integration.

Run the existing disposable browser suite from another terminal with the repository command below. The browser schema was checked empty before this handoff (zero admins, slots, and shadow runs); the suite creates and cleans its own browser fixtures and starts its own random-port app.

```sh
set -a
. /tmp/botmerzz-ai-learning-manual-20261110.env
set +a
DB_NAME=merzz_browser_test \
  ALLOW_DESTRUCTIVE_DB_TESTS=true \
  BOTMERZZ_CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  npm run test:learning:browser
```

The browser test is automation only; its temporary login and data are deleted after the run and cannot be used for manual review. The suite injects loading/API errors through Playwright routes. For a manual error-state check, open Chrome DevTools → Network request blocking, block `*/api/learning/metrics*`, select AI Learning or reload its metrics, verify the error is readable and the rest of the dashboard remains usable, then remove the block. Record this as a manual observation; do not alter server data to create an error.

After review, stop the app with Ctrl-C. To remove only the manual schema and database user, use the MySQL root credential interactively (do not put it in shell history):

```sh
docker exec -it -e MYSQL_HISTFILE=/dev/null botmerzz-p1-final-mysql mysql -uroot -p
```

To remove only the manual app database and keep the browser E2E database/user available, enter:

```sql
REVOKE ALL PRIVILEGES ON merzz_manual_test.* FROM 'learning_manual'@'%';
DROP DATABASE merzz_manual_test;
FLUSH PRIVILEGES;
```

The browser E2E cleans its rows, but its empty schema and the user's browser-schema grant may be retained for later testing. When all local tests are finished, optionally remove that remaining browser schema/user as well:

```sql
DROP DATABASE merzz_browser_test;
DROP USER IF EXISTS 'learning_manual'@'%';
```

After all work using the disposable MySQL container is finished, `docker stop botmerzz-p1-final-mysql` returns it to the stopped state. Do not stop it while the manual app or another local test is using it.

## Test setup and recording

1. Use the prepared isolated environment above. Do not point it at another database or add provider credentials.
2. Open **`http://localhost:3000/`** in Chrome or Safari and sign in with the temporary administrator. Select **AI Learning** (`#tab-button-learning`).
3. Use the three pending candidates, four synthetic published slots, feedback form, metrics, and candidate dialog. Reviewing a candidate changes that disposable row and can create an inactive rule; record the resulting test IDs. Do not activate a rule for generation.
4. Record the application revision, browser and OS versions, viewport dimensions, zoom level, tester, date/time, and test data identifiers. Capture screenshots only after removing personal data and secrets.

For every row, fill **Observed result**, **Evidence**, **Tester/date**, and select exactly one status. Leave the status blank until the step is performed.

| Requirement ID | Procedure and exact action | Expected announcement and focus behavior | Observed result / evidence | Status (PASS / FAIL / BLOCKED / NOT EXECUTED) | Tester / date |
| --- | --- | --- | --- | --- | --- |
| MAN-KBD-01 | Starting at the login page, press Tab and Shift+Tab through email, password, password visibility, and sign-in controls. | Focus order follows visual order; each control has a visible focus indicator and an understandable accessible name. Reverse navigation returns to the preceding control. |  |  |  |
| MAN-KBD-02 | Sign in; continue using only Tab/Shift+Tab through dashboard navigation to AI Learning, then candidate search, filters, candidate cards, and pagination. | Focus stays on visible, enabled controls; selected navigation and panel are exposed; hidden panels are skipped. No focus disappears behind the responsive sidebar. |  |  |  |
| MAN-KBD-03 | On a candidate card, use Enter and Space on the details button. In the dialog, use Tab and Shift+Tab repeatedly, then Escape. | The dialog opens with its title and close action available; focus stays within the open dialog; Escape closes it; focus returns to the button that opened it. |  |  |  |
| MAN-KBD-04 | On a pending candidate, use only the keyboard to move through instruction and scope fields, then focus Approve, Reject, and False Positive actions in separate disposable fixtures. Activate each with Enter and Space where available. | Each action has a clear name and visible focus. Confirmation appears where expected. Success or error status is announced without moving focus unexpectedly. Approval leaves the rule inactive. |  |  |  |
| MAN-KBD-05 | Attempt to submit a review with required fields missing; correct it and submit using Enter. Navigate any validation error and return to the failed field. | Error text is announced; invalid field is identified; focus moves to or remains at the relevant field. Successful submission announces completion. |  |  |  |
| MAN-KBD-06 | In a disposable UI-only fixture, focus the activation confirmation, use Escape, then check activation state. Repeat the normal confirmation path without submitting any production change. | Escape cancels the dialog/confirmation; focus returns predictably; no activation occurs on cancellation. |  |  |  |
| MAN-KBD-07 | Complete the feedback form using Tab/Shift+Tab and submit with Enter from the submit button. Repeat the sidebar open/close flow at a narrow viewport using Enter, Space, Tab, Shift+Tab, and Escape. | Labels are encountered before their controls; required rating feedback is announced; sidebar focus is contained only while open; Escape closes it and restores focus to Menu. No keyboard trap remains after closing. |  |  |  |

## Browser zoom and reflow

Use Chrome menu **View → Zoom** at **100%**, **200%**, and **400%**. Keep the browser window at a typical laptop width (for example 1280 CSS pixels at 100%) before changing zoom. At each level, visit `/` and select AI Learning. Inspect search, filters, pagination, details, approve/reject, feedback, rules, metrics, and the sidebar.

| Requirement ID | Procedure and exact action | Expected result | Observed result / evidence | Status (PASS / FAIL / BLOCKED / NOT EXECUTED) | Tester / date |
| --- | --- | --- | --- | --- | --- |
| MAN-ZOOM-100 | Set Chrome zoom to 100%; inspect all listed controls and the candidate dialog. | Text and controls are not clipped or overlapped; dialogs and tables/lists remain operable. |  |  |  |
| MAN-ZOOM-200 | Set Chrome zoom to 200%; repeat candidate, review, feedback, metrics, and sidebar actions. | Content reflows without loss of information or function; no page-level horizontal scrolling is needed for ordinary text/forms; all controls remain reachable. |  |  |  |
| MAN-ZOOM-400 | Set Chrome zoom to 400%; repeat the critical review and feedback path. | At an effective 320 CSS-pixel viewport, content reflows; no essential control is clipped, obscured, or unreachable. Wide tabular content may use a labelled local scroll region if necessary. |  |  |  |

Record the effective viewport width, any horizontal scroll container, clipped text, hidden controls, modal size/scroll behavior, sidebar access, and whether the workflow could be completed without resetting zoom.

## Contrast and visual states

Inspect the actual rendered colors in the default, hover, keyboard-focus, disabled, selected, loading, success, warning, and error states. Record foreground/background color values and the ratio source or tool used. Automated Axe findings and CSS checks do not substitute for this visual state-by-state observation.

For WCAG 2.2 AA, use at least 4.5:1 for normal text and 3:1 for large text under [SC 1.4.3](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html). Necessary component boundaries, states, and focus indicators generally need 3:1 against adjacent colors under [SC 1.4.11](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html). For reflow at 400% zoom, inspect whether content works at an effective width of 320 CSS pixels under [SC 1.4.10](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html). Record exceptions only when the criterion itself allows them; do not treat a disabled color as acceptable when the information is still needed.

| Requirement ID | Elements to inspect | Expected WCAG 2.2 AA contrast | Observed colors, ratio, state, and evidence | Status (PASS / FAIL / BLOCKED / NOT EXECUTED) | Tester / date |
| --- | --- | --- | --- | --- | --- |
| MAN-CON-01 | Body text and headings against page/panel backgrounds | 4.5:1 for normal text; 3:1 for large text |  |  |  |
| MAN-CON-02 | Secondary text, helper text, disabled text, loading and empty-state text | Applicable text contrast; note that disabled-state exceptions do not excuse loss of essential information |  |  |  |
| MAN-CON-03 | Buttons, links, selected navigation, status badges and error/success messages | 4.5:1 for normal text; state must not rely on color alone |  |  |  |
| MAN-CON-04 | Input boundaries, selected control state, dialog boundaries, and meaningful icons | At least 3:1 for necessary non-text visual information against adjacent colors |  |  |  |
| MAN-CON-05 | Focus indicators in both themes/states and around all interactive controls | At least 3:1 against adjacent colors where applicable; indicator remains visible and not obscured |  |  |  |

For each contrast row, attach a screenshot or color-pair record and name the contrast tool/calculation. Include a normal, hover, focus, disabled, success, and error state where present. Do not report one sampled pair as a page-wide pass.

## macOS Safari VoiceOver

Use a separate local test administrator. Start VoiceOver with **Command-F5** or through **System Settings → Accessibility → VoiceOver** if the shortcut is remapped. Do not enable or change VoiceOver preferences on another user's behalf. When finished, turn VoiceOver off with the same control.

| Requirement ID | Exact route and action | Expected announcement and focus behavior | Observed announcement / evidence | Status (PASS / FAIL / BLOCKED / NOT EXECUTED) | Tester / date |
| --- | --- | --- | --- | --- | --- |
| MAN-VO-01 | Safari `http://localhost:3000/`; navigate login fields and submit a local test login. | Announces email and password labels, password visibility state, and sign-in button; focus order matches visual order; authentication result is announced. |  |  |  |
| MAN-VO-02 | From dashboard navigation choose AI Learning. | Announces navigation/tab name, selected state, and AI Learning panel heading; focus remains on the navigation control or moves to panel heading in a predictable way. |  |  |  |
| MAN-VO-03 | In AI Learning, traverse status/source/search filters and candidate results; open candidate details. | Announces filter labels/values, candidate identity/status, details button, dialog name/role, and unavailable-evidence notice. Dialog focus starts inside it. |  |  |  |
| MAN-VO-04 | Traverse candidate review instruction/scope fields and approve/reject/false-positive controls; trigger one invalid submission in the disposable fixture. | Announces labels, current values, validation errors, and result status. No decision is silently applied; approved rule remains inactive. |  |  |  |
| MAN-VO-05 | Traverse published-post feedback dimensions and explanation, then save a local fixture rating. | Announces each rating dimension and its current value; announces validation feedback and successful save. Unrated dimensions are not announced as positive. |  |  |  |
| MAN-VO-06 | Traverse rule lifecycle actions and cancel any native confirmation before ending. | Announces rule status/version, activation state, action name, and confirmation/cancellation outcome. No rule is activated by merely opening or canceling confirmation. |  |  |  |
| MAN-VO-07 | Visit analytics and shadow sections; trigger loading, empty, and a controlled error response if the isolated harness supports it. | Dynamic success/error text in `aria-live`/`role=status` or `role=alert` is announced once; metric headings, samples, and “Belum cukup data” are understandable in reading order. |  |  |  |
| MAN-VO-08 | Close the candidate dialog, then continue with Tab/Shift+Tab through the page and navigate away from the Learning tab. | Focus returns to the dialog opener; no keyboard trap; focus is not stranded in hidden content; navigation remains available. |  |  |  |

If Safari/VoiceOver or physical keyboard access is unavailable, mark the affected row **BLOCKED** and record the device, OS/browser version, and missing access. Do not mark it PASS based on DOM inspection or Playwright key events.

## Acceptance recording

| Field | Value |
| --- | --- |
| Tester / role |  |
| Date and time |  |
| Repository revision |  |
| macOS version |  |
| Safari version |  |
| Chrome version |  |
| Viewport and zoom levels |  |
| VoiceOver version/settings changed |  |
| Evidence locations |  |
| Failed or blocked requirement IDs |  |
| Follow-up owner and due date |  |

Manual P1 accessibility acceptance remains **PENDING** until every mandatory row has an observed result and an evidence reference. Do not record an unexecuted check as PASS based on Playwright, Axe, CSS inspection, or this checklist's expected results.

## Workspace evidence status check — 2026-11-11

The current repository copy was checked after the user described the checklist as completed. All 23 manual observation/evidence/status cells above remain blank, and the tester/date and evidence-location fields are also empty. No external completed checklist or screenshot/trace artifact was present in the workspace. Accordingly, no manual result is recorded as PASS in this file. Fill the relevant cells with the actual observed result, tester/date, browser/OS/zoom details, and a sanitized evidence reference before treating manual accessibility as accepted.

## User execution handoff — 2026-11-11

The local app was live and ready when this handoff was prepared. To execute the remaining 23 checks:

1. In one terminal from the repository root, use the verified disposable environment and start the app if it is not already running:

   ```sh
   docker start botmerzz-p1-final-mysql   # only when stopped
   set -a
   . /tmp/botmerzz-ai-learning-manual-20261110.env
   set +a
   npm run migrate
   npm start
   ```

2. In a second terminal, verify readiness with `curl --fail --silent --show-error http://localhost:3000/health/ready`. Open `http://localhost:3000/` in Chrome for keyboard, zoom, and contrast rows, and Safari for VoiceOver rows. Sign in using the previously delivered disposable account or create a unique `.test` administrator with `npm run admin:create` under the same environment.
3. Follow MAN-KBD-01–07, MAN-ZOOM-100/200/400, MAN-CON-01–05, and MAN-VO-01–08 above in order. Use only the synthetic slots/candidates. For MAN-KBD-06, use the separately documented activation-confirmation-only process; cancel confirmation and verify the rule remains inactive.
4. For each row, enter the browser/OS, observed announcement/focus/layout/colors, tester/date, and a screenshot or other sanitized evidence path. Choose PASS only if observation matches its expected result; otherwise choose FAIL and include exact reproduction steps. Choose BLOCKED for unavailable hardware/browser or NOT EXECUTED if not attempted. Keep all provider credentials blank and do not activate retrieval or prompt integration.
5. Send back the completed checklist or the specific failed/blocked rows. Do not include secrets, personal data, or unredacted captions in screenshots. Stop the app with Ctrl-C when finished; stop the disposable DB only after no local test needs it.

No manual status in this file has been prefilled as PASS. All 23 rows remain **NOT EXECUTED** until actual observations are recorded. Under the 2026-11-11 risk-based release decision, this is an important deferred check rather than a deployment blocker for a release with Learning execution flags off. Complete it before broad administrator rollout; any observed high-impact defect remains release-blocking. See the current disposition in `AI_LEARNING_P1_ACCEPTANCE.md`.
