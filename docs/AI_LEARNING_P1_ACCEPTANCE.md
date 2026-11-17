# AI Learning Center — P1 Acceptance Report

- **Assessment date:** 2026-11-11
- **Source of truth:** BOTMERZZ_AI_LEARNING_P1_MASTER_MERGED.md
- **Implementation completeness:** **COMPLETE for implemented P1 functionality**
- **Historical strict P1 checklist:** **NOT FULLY CLOSED** (manual accessibility and real-model observations remain NOT EXECUTED).
- **Current risk-based functional acceptance:** **GO** for tested critical workflows only; see the disposition at the end of this report.
- **Production activation:** **NO-GO**

This report records repository and runtime evidence for P1 implementation and acceptance. The main lifecycle, retrieval, prompt, attribution, shadow, and three-pillar analytics implementation exists and was exercised with unit tests, disposable MySQL, and browser automation. The current risk-based decision allows functional acceptance for the critical tested workflows, while manual and real-model checks remain explicitly unexecuted and deferred; it does not mark the full historical checklist as passed. No production activation or deployment was performed.

> **Current release decision:** use the risk-based disposition at the end of this report. It supersedes older blanket NO-GO statements for manual accessibility and live-model evaluation. Those checks remain NOT EXECUTED; this change records an explicitly authorized deferral, not a pass.

## Scope and safeguards

The review used the current repository, the merged master, the implementation status, the P0 gap audit, migrations 011–019, server/API code, UI code, test suites, scheduler, and publishing integration.

The isolated browser app used no provider credentials and had scheduling disabled. Activation was false on first start. The lifecycle UI was then exercised after restart with only the test app's activation flag enabled; retrieval, prompt integration, shadow evaluation, scheduler, and provider credentials remained disabled. No live provider request or Threads publish was made. A separate unit test verified OpenRouter request construction with a mocked transport. No production database, account, schedule, or deployment was touched.

## Requirement and gap matrix

Status meanings: **VERIFIED** means the specified evidence ran; **PARTIAL** means some requested scenarios remain untested; **MISSING** means the requested capability/evidence was not found; **BLOCKED** means an environmental condition prevented a test; **NOT EXECUTED** means no test was performed. Skips are reported separately and never counted as passes. Severity is recorded only for confirmed defects.

| Requirement ID | Requirement | Implementation | Evidence | Coverage | Status | Severity | Remediation | Acceptance blocker? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P1-01 | Contextual failure capture and candidate provenance | Durable attempt ledger is authoritative; optional capture stores eligible contextual candidates with slot/attempt association. | Unit and MySQL dedupe, withheld-evidence, technical/unknown exclusion cases. | Tested paths; optional capture can be disabled. | VERIFIED | — | None for tested paths. | No |
| P1-02 | Human feedback and quality ratings | Admin UI records positive/negative feedback and eight dimensions, tied to the selected published slot. | Browser submits both polarities on separate slots; API/MySQL and rendered analytics assertions. | Tested workflow; no production data. | VERIFIED | — | None for tested workflow. | No |
| P1-03 | Candidate search, filtering, details, pagination, and decisions | Admin UI supports bounded search/filter/cursor paging, evidence disclosure, review decisions, and empty/loading/error states. | Browser checks 100-item paging, empty state, details, evidence-unavailable, approve/reject/false-positive, recovery, and text-safe XSS payload. | Exercised browser path. | VERIFIED | — | None for exercised browser path. | No |
| P1-04 | Approval, activation, revisions, audit, rollback | Approval is inactive; explicit activation, deactivation, immutable versions, version approval, rollback, and audit are implemented. New activations are transactionally capped at 500 concurrently active rule versions. | Isolated MySQL lifecycle tests, cap transaction unit test, and browser actions; audit rows queried. | Isolated fixture; no production execution. | VERIFIED for tested workflow | — | The explicit active-rule cap prevents unbounded conflict scans. | No |
| P1-05 | Conflict and duplicate controls | Deterministic instruction/scope/fact/guideline/active-rule checks serialize activation; AI suggestions remain non-authoritative. | Unit conflict tests and MySQL transactional/concurrency cases; cap test rejects adding rule 501 before mutation. | Tests cover current rules; natural-language conflict coverage is finite. | VERIFIED for tested constraints | — | Continue human review of ambiguous conflicts. | No |
| P1-06 | Approval isolation scenarios A–G | Retrieval filters states and scope; authorization, deactivation, snapshot stability, concurrency, and known prompt-injection patterns are tested. | Unit, route, MySQL, browser, and mocked OpenRouter request evidence summarized in the A–G matrix below. | All active administrator accounts share the same workspace-wide role; no tenant or per-record ownership boundary exists. Live-model behavior remains untested. | PARTIAL | — | Keep model-facing claims bounded to the mock contract; any authorized model test and future role/tenant boundary need separate evidence. | Yes |
| P1-07 | Scoped deterministic retrieval and bounded prompt budget | Retrieval is structured, scoped, stable, and prompt-bounded; no more than 500 active rules are supported. Over-limit legacy state returns no lessons with an explicit incomplete reason. | Unit tests cover scope, ordering, exclusions, rule/token bounds, explicit 501+ fail-closed behavior, conflicts, and hierarchy. `test/content-service.test.js` verifies the mocked OpenRouter request and auditor independence. | Mocked request contract passed; no paid/live provider call. | VERIFIED for tested contract | — | Keep production flags off; live-provider behavior requires separate authorization and spend limits. | No for isolated development |
| P1-08 | Immutable attempt attribution snapshot | Migration 017 stores attempt, slot, model/config, facts, context, and exact applied rule versions. | Unit/MySQL persistence and ambiguous-replay tests. | No real provider in-flight activation race. | VERIFIED | — | None for persistence paths; no production inference claimed. | No |
| P1-09 | Shadow isolation and resource bounds | Shadow stores paired evaluations separately, coordinates one active run per database, and persists per-admin start quotas across restarts. | Mock-provider unit tests; two-pool MySQL quota/lock tests; actual worker SIGKILL after reservation; actual disposable MySQL container restart; publisher/slot-spy test. | No external provider shadow run or live cost measurement. | VERIFIED for tested paths | — | Provider spend is not measured or capped by application code; an external numeric cap is required before real calls. | No for isolated development; yes for real provider calls |
| P1-10 | Three independent analytics pillars | Compliance v3, quality rubric v1, and observational effectiveness v1 are independently calculated and displayed. | Unit/MySQL formulas; browser disclosures, 90-day request/echo, quality counts and missing-data state. | No causal claim or production dataset; windows are bounded to 30/90/365 UI choices (API max 365 days). | VERIFIED | — | Denominator mismatch found in review was corrected and versioned as v3; see metric contract. | No |
| P1-11 | Security verification | Auth/CSRF/input/SQLi/XSS/lifecycle/scope/shadow controls have automated evidence. Malicious lesson probes include facts, validation, secrets, provider configuration, unsafe content, and publishing attempts. | `test/learning-security.test.js`, `test/learning.test.js`, browser probes, MySQL lifecycle and shadow concurrency/restart cases. | Tested XSS probes now cover candidate, search, feedback, rule instruction, metric label, and API error output. Exhaustive secret/log review and live-model behavior remain unverified. | PARTIAL | Low: a deterministic rule conflict check missed direct Tebar API-call wording; now covered by regression checks. No publishing path or tool was exposed to the model. | Treat deterministic prompt checks as finite; keep execution flags off and resolve remaining evidence before acceptance. | Yes for P1 acceptance and production activation |
| P1-12 | Browser acceptance and accessibility | Local Chrome exercises login, Learning workflows, lifecycle, feedback, analytics, Enter/Space/Tab/Shift+Tab/Escape, dialog focus trapping/restoration, responsive widths, and Axe scans. | `e2e/learning.browser.e2e.js`; automation passes for tested keyboard and rendered states. | Manual VoiceOver, actual browser 200%/400% zoom, full contrast review, and complete keyboard-only walkthrough are pending because the browser-control host was unavailable and VoiceOver was off. | PARTIAL | — | Record the manual rows in `AI_LEARNING_MANUAL_ACCEPTANCE_CHECKLIST.md`; automated evidence cannot substitute. | Yes |
| P1-13 | Migrations, upgrade, recovery | Additive migrations through 019 and recovery paths are covered. | Full serial isolated MySQL suite, fresh-schema upgrade from 011 fixture, worker-kill recovery, and actual disposable MySQL restart. | Packet-level loss during COMMIT acknowledgement was not injected; lost acknowledgement was controlled after a real commit. | VERIFIED for tested paths | — | Retain packet-level commit-ack injection as an explicit unverified failure scenario. | No for isolated development |
| P1-14 | Default-off flags and server enforcement | Capture, activation, retrieval, prompt integration, shadow, and retention flags default false and are enforced server-side. | Config unit tests and browser capabilities; test-only activation explicitly isolated. | Verified defaults and API flags. | VERIFIED | — | Keep defaults false; no automatic activation. | No |
| P1-15 | Publishing non-regression | Learning/shadow endpoints remain outside dispatcher; current scheduler and publisher flows retain existing operation identities. | Existing dispatcher, scheduler, provider tests and isolated MySQL integration. | No live Threads publishing. | VERIFIED | — | None; no live publishing performed. | No |
| P1-16 | Production activation and rollout safety | Production configuration is unchanged and execution flags default off. The isolated E2E temporarily enables activation only to exercise lifecycle UI; retrieval, prompt integration, shadow, provider, and scheduler remain off. | Config, E2E environment assertions, and audit of executed commands. | Task boundary verified; test-only activation was scoped to the isolated app. | VERIFIED | — | Production activation and deployment remain NO-GO and require separate authorization. | Yes for production activation |

Review found a compliance formula inconsistency: `compliance-v2` calculated success over passing plus contextual failures, while the UI showed a broader eligible-attempt count. The implementation now uses `compliance-v3`: the denominator is eligible first attempts minus technical exclusions, so contextual failures, unknown and incomplete outcomes, and missing attempt rows remain visible in the primary population. Unknown/incomplete/missing outcomes make the report incomplete; truncated populations withhold the rate. Tests cover a six-outcome mixed population, zero denominator, and truncation. No historical outcome was backfilled. A separate low-severity rate-limit issue also allowed active in-memory IP buckets to be evicted at capacity; the limiter now rejects new IPs with a bounded 503 retry time until an expired bucket is available. Both corrections are included in the fresh test pass below.

One initial MySQL failure was a test-fixture contamination issue: a shared disposable outbox was reused across runs and a FIFO assertion selected rows by repeated text. The guarded test now isolates that queue and uses a unique message; it is not a product defect.

A later full-suite run exposed a second test-fixture defect: `test/database.integration.test.js` used `DELETE FROM admins` although Learning shadow evaluations intentionally preserve their administrator actor through an `ON DELETE RESTRICT` foreign key. The test now snapshots and temporarily isolates active-admin state, creates its own actors, disables those actors after use, and restores pre-existing active flags. It preserves the audit-linked administrator rows and passes in the complete serial MySQL run. The application foreign key and audit-retention behavior were not weakened.

## Approval isolation A–G

| Scenario | Evidence | Result |
| --- | --- | --- |
| A — Pending candidate | Retrieval eligibility tests exclude unapproved rules. | PASS for unit/service path |
| B — Rejected candidate | Candidate state and retrieval eligibility tests exclude rejected rules. | PASS for unit/service path |
| C — Approved and active | Approval is separate from activation; MySQL/browser verifies inactive approval and explicit test-only activation; retrieval unit tests exclude ineligible rules; the mocked OpenRouter request contains the selected lesson and keeps the auditor lesson-free. | PASS for mocked request contract; no live provider call |
| D — Deactivation | Browser deactivated rule; attribution tests preserve immutable snapshots. | PASS for these paths; no real in-flight provider race |
| E — Unauthorized mutation | Anonymous/invalid session and missing/invalid/foreign-origin CSRF requests are rejected before storage access. | PARTIAL: no non-admin account/role fixture exists |
| F — Concurrent changes | MySQL lifecycle/concurrency cases verify conditional transitions and consistent persisted history. | PASS for tested transactions |
| G — Prompt injection | Deterministic instruction checks reject override/unsupported content and keep lessons below safety, facts, and administrator guidance. | PARTIAL: no adversarial live-model evaluation; finite deterministic probes do not prove every natural-language case |

## Three-pillar metric contract

| Pillar / formula version | Definition and source | Numerator / denominator and sample N | Window, exclusions, missing-data policy, and interpretation limit |
| --- | --- | --- | --- |
| Content Compliance, `compliance-v3` | First durable ordinal for each slot in `generation_slot_claims`; authoritative deterministic and semantic outcomes from generation attempts. | First-pass successes / (eligible claimed slots − technical exclusions). `eligibleFirstAttempts` is the claimed-slot population; `evaluatedFirstAttempts` is passed + contextual; technical exclusions and each unresolved outcome count are separately reported. | UI offers 30/90/365 days; API range is `[from,to)` and max 365 days. Technical failures are excluded from the denominator; unknown, incomplete, and missing remain in the denominator and mark completeness incomplete. Truncation withholds denominator/rates. Legacy unprovable identity is separately disclosed and never fabricated. First-pass evaluation is a rate over the declared eligible population, not a causal measure. |
| Content Quality, `rubric-v1` | Published captions with current caption-hash match; actual administrator feedback and eight structured dimensions. | Feedback coverage = distinct reviewed captions / eligible published captions. Positive/negative are submission counts. Each dimension reports rating count `n`, distinct-caption sample size, and mean. | UI offers 30/90/365 days; eligibility is by slot completion timestamp in `[from,to)`. No feedback/unrated dimension stays missing, not positive. “Data tersedia” requires at least five reviewed captions; dimension samples remain independently shown. Truncation or small samples are disclosed. No engagement/conversion is inferred. |
| Learning Effectiveness, `effectiveness-v1` | Exact rule ID/version from immutable attempt snapshots, grouped into baseline and active observed exposure with matching scope/configuration checks. | Per arm: attributed snapshots, first-attempt outcome sample `n`, evaluated sample (passed + contextual), failure categories/rates, and distinct reviewed-caption/dimension samples. | Requested report window is 30/90/365 days (`[from,to)`, max 365); baseline is the 30 days before activation and observed window is the active portion. Technical outcomes are separately excluded from evaluated rate; unknown/incomplete are shown. At least 10 evaluated attempts per arm and compatible validator are required; confounders and co-applied rules are disclosed. Observational association is not causation; insufficient samples display “Belum cukup data”. |

Quality is computed from persisted human feedback only. `test/learning-analytics.test.js` checks multiple reviewers, submission polarity counts, distinct-caption coverage, per-dimension sample sizes, and unrated submissions; browser output verified 2/4 reviewed eligible captions with one positive and one negative submission. Feedback is append-only for each reviewer/caption hash: the database unique key and API return a duplicate conflict, and there is no edit endpoint. Edited-review behavior is unsupported, not silently overwritten. Effectiveness uses applied rule ID/version from immutable attempt snapshots, compatible configuration/validator checks, baseline and observed windows, actual feedback, disclosed sample sizes, and a non-causal interpretation. The isolated fixture had too few observations and displayed “Belum cukup data”.

The formula/window/source details are implemented in the reports and service code. The UI never combines the pillars into one score.

## Verification commands and results

All MySQL commands below used the disposable local MySQL 8.4.13 server on loopback. Replace the quoted password placeholder with a local test-only credential. The 19 default skips require the exact test database, NODE_ENV=test, loopback host, and explicit destructive-test opt-in.

| Command | Result |
| --- | --- |
| npm test | 388 tests: 369 passed, 0 failed, 19 intentionally skipped because MySQL configuration is absent. |
| env NODE_ENV=test DB_HOST=127.0.0.1 DB_PORT=33345 DB_USER=root DB_PASSWORD='replace-with-local-test-password' DB_NAME=merzz_test ALLOW_DESTRUCTIVE_DB_TESTS=true node --test --test-concurrency=1 test/*.test.js | 403 tests: 401 passed, 0 failed, 2 gated skips. Fresh-schema upgrade and actual database-restart tests ran separately. |
| env NODE_ENV=test DB_HOST=127.0.0.1 DB_PORT=33345 DB_USER=root DB_PASSWORD='replace-with-local-test-password' DB_NAME=merzz_test_upgrade ALLOW_DESTRUCTIVE_DB_TESTS=true node --test test/learning-upgrade.mysql.integration.test.js | 1 passed, 0 failed, 0 skipped on a recreated, isolated test schema. |
| env NODE_ENV=test ALLOW_DESTRUCTIVE_DB_TESTS=true DB_HOST=127.0.0.1 DB_PORT=33345 DB_USER=root DB_PASSWORD='replace-with-local-test-password' DB_NAME=merzz_test BOTMERZZ_TEST_MYSQL_CONTAINER=botmerzz-p1-final-mysql node --test test/learning-shadow.database-restart.test.js | 1 passed, 0 failed, 0 skipped; actually restarted only the named disposable MySQL container. |
| env NODE_ENV=test DB_HOST=127.0.0.1 DB_PORT=33345 DB_USER=root DB_PASSWORD='replace-with-local-test-password' DB_NAME=merzz_test ALLOW_DESTRUCTIVE_DB_TESTS=true npm run test:integration | First command: 75 passed. The script then ran test/configuration.mysql.js: 1 passed. |
| env NODE_ENV=test ALLOW_DESTRUCTIVE_DB_TESTS=true DB_HOST=127.0.0.1 DB_PORT=33345 DB_USER=root DB_PASSWORD='replace-with-local-test-password' DB_NAME=merzz_browser_test BOTMERZZ_CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:learning:browser | Latest run: 7 passed, 0 failed, 0 skipped in 16.78 seconds; local app, isolated MySQL, headless Chrome; no provider credentials. |
| env NODE_ENV=test DB_HOST=127.0.0.1 DB_PORT=33345 DB_USER=root DB_PASSWORD='replace-with-local-test-password' DB_NAME=merzz_test ALLOW_DESTRUCTIVE_DB_TESTS=true node --test test/learning-shadow.mysql.integration.test.js | 1 passed, 0 failed, 0 skipped; a separate Node child process observed the exhausted persisted per-admin shadow quota, then was SIGKILLed after reserving a run; recovery stayed fail-closed. |
| npm run check | JavaScript syntax checks passed. |
| git diff --check | Passed. |
| npm audit --audit-level=low | 0 reported vulnerabilities. |

Suite counts overlap; do not add them into a unique total. `npm run test:integration` reported 75 passed, then the MySQL configuration test reported 1 passed. E2E output reported one parent test plus six browser subtests. Automated Axe scans passed on the dashboard and Learning surface at 1280×900 for WCAG 2.0, 2.1, and 2.2 A/AA tags; this is not a manual WCAG conformance audit. The 90-day browser check validates the exact range delta and API `from`/`to` echo. The displayed Content Quality details report two reviewed of four eligible captions, one positive submission, and one negative submission.

## Skipped-test review

The default suite’s 19 skips are intentional environment gates, not test failures. Each requires NODE_ENV=test, a test-only DB_NAME, DB_HOST on loopback, and ALLOW_DESTRUCTIVE_DB_TESTS=true. The main group was rerun serially on disposable MySQL 8.4.13 using merzz_test; the upgrade case was rerun separately on an empty merzz_test_upgrade schema. Every case below passed in the appropriate run, so no skip remains blocking after the isolated executions.

| # | File and skipped test name | Why skipped by npm test | Rerun evidence | P1 / production impact |
| --- | --- | --- | --- | --- |
| 1 | test/database.integration.test.js — confirmed cancellation atomically settles provider state across repository restart | MySQL connection and destructive-test gates absent in default run. | PASS in 401-pass serial MySQL run. | No remaining blocker from this test. |
| 2 | test/database.integration.test.js — MySQL login throttles are shared and bound concurrent attempts across auth instances | Same MySQL-only gate. | PASS in 401-pass serial MySQL run. | No remaining blocker from this test. |
| 3 | test/database.integration.test.js — MySQL migrations and repository are reachable in integration environment | Same MySQL-only gate; uses isolated repository/outbox fixture. | PASS in 401-pass serial MySQL run; rerun repeatability was separately confirmed. | No remaining blocker from this test. |
| 4 | test/database.integration.test.js — MySQL checks prepared caption evidence atomically before publishing | Same MySQL-only gate. | PASS in 401-pass serial MySQL run. | No live publishing; mocked/isolated persistence only. |
| 5 | test/database.integration.test.js — MySQL fences a concurrent account switch against publication start | Same MySQL-only gate. | PASS in 401-pass serial MySQL run. | No remaining blocker from this test. |
| 6 | test/database.integration.test.js — independent MySQL dispatchers serialize one-minute slot claims and preserve the prepared second slot | Same MySQL-only gate. | PASS in 401-pass serial MySQL run. | Publishing non-regression covered without live publishing. |
| 7 | test/database.integration.test.js — MySQL planner and publication cooldown preserve exact minute intervals | Same MySQL-only gate. | PASS in 401-pass serial MySQL run. | No remaining blocker from this test. |
| 8 | test/database.integration.test.js — MySQL interval updates preserve the due slot and apply the new cadence afterward | Same MySQL-only gate. | PASS in 401-pass serial MySQL run. | No remaining blocker from this test. |
| 9 | test/generation-attempts.mysql.integration.test.js — attempt reservation is slot-ordered, replay-safe, terminally consistent, and survives worker kill on isolated MySQL | Requires disposable MySQL schema and explicit destructive-test opt-in. | PASS in 401-pass serial MySQL run. | Attempt durability/restart invariant verified for this scenario. |
| 10 | test/learning-analytics.mysql.integration.test.js — three-pillar analytics queries execute against isolated MySQL schema | Same MySQL-only gate. | PASS in 401-pass serial MySQL run. | Analytics SQL gate resolved for tested fixtures. |
| 11 | test/learning-failure.mysql.integration.test.js — isolated MySQL failure and ambiguity exercises | Same MySQL-only gate. | PASS in 401-pass serial MySQL run, including nested fault cases. | Wrapper-based lost-ack test is not packet-level COMMIT loss. |
| 12 | test/learning-pool1.mysql.integration.test.js — idempotent event replay completes using a single-connection MySQL pool | Same MySQL-only gate. | PASS in 401-pass serial MySQL run. | No remaining blocker from this test. |
| 13 | test/learning-retention.mysql.integration.test.js — retention expires only bounded old evidence and keeps review records on MySQL | Same MySQL-only gate. | PASS in 401-pass serial MySQL run. | Does not establish a strict maximum age under persistent backlog. |
| 14 | test/learning-shadow.mysql.integration.test.js — shadow evaluation persistence, durable quotas, cross-pool admission, worker kill and recovery on isolated MySQL | Same MySQL-only gate. | PASS in final serial MySQL run and targeted rerun. | No external provider or live publishing. |
| 15 | test/learning-shutdown.mysql.integration.test.js — optional-pool shutdown cancels an active stalled query on isolated MySQL | Same MySQL-only gate. | PASS in 401-pass serial MySQL run. | Optional query shutdown verified; critical publishing work is not force-canceled. |
| 16 | test/learning-upgrade.mysql.integration.test.js — upgrade from existing 011 records retains legacy evidence as unavailable | Requires a separate, empty merzz_test_upgrade schema; the default suite does not provision it. | PASS separately, 1/1, after recreating only the dedicated local upgrade schema. | No legacy identity was fabricated. Separate rerun closes the skip. |
| 17 | test/learning.mysql.integration.test.js — learning persistence and reviewer concurrency on isolated MySQL | Same MySQL-only gate. | PASS in 401-pass serial MySQL run. | No remaining blocker from this test. |
| 18 | test/validation-outcomes.mysql.integration.test.js — outcome observations are idempotent and conflict-safe on isolated MySQL | Same MySQL-only gate. | PASS in 401-pass serial MySQL run. | No remaining blocker from this test. |
| 19 | test/learning-shadow.database-restart.test.js — MySQL restart cancels shadow admission and a new worker waits for ambiguous running results | Requires the explicit named disposable-container variable in addition to the loopback/test-schema gates. | PASS separately, 1/1; MySQL container restart was real, not mocked. | Confirms tested lock-loss and restart recovery; no external provider or publishing. |

The aggregate default npm test output still reports 19 skips by design because it does not connect to MySQL. This is distinct from the disposable-MySQL verification above. See the exact commands and suite limitations in the verification table.

## Changed-file inventory

The complete P0/P1 implementation tree includes migrations 011–019; operational attempt, lifecycle, learning, analytics, attribution, retention, and shadow services under src; Learning API routes; public dashboard files; and P0/P1 unit, MySQL, security, and browser tests. This verification pass also corrected the repeatability of the guarded notification outbox test; versioned the first-pass denominator correction as compliance-v3; made IP bucket capacity fail closed; and extended browser coverage for the candidate empty state, analytics disclosures, rendered feedback counts, and exact 90-day range echo.

The current P0/P1 worktree inventory is grouped below. These files are not all newly modified by the last verification pass.

- Runtime/configuration: .env.example; compose.yaml; compose.vps.yaml; package.json; package-lock.json; src/cli.js; src/config.js; src/content-service.js; src/db.js; src/providers/openrouter.js; src/repository.js; src/scheduler.js; src/server.js.
- Durable lifecycle, learning, and analytics services: src/generation-attempts.js; src/validation-outcomes.js; src/learning.js; src/learning-capture.js; src/learning-evidence.js; src/learning-attribution.js; src/learning-metrics.js; src/learning-analytics.js; src/learning-retention.js; src/learning-shadow.js; src/learning-shadow-execution.js; src/http/routes/learning.js; src/http/routes/learning-evaluation.js.
- Database: migrations/011_learning_center.sql; migrations/012_learning_events.sql; migrations/013_validation_outcome_observations.sql; migrations/014_generation_attempts.sql; migrations/015_learning_lifecycle.sql; migrations/016_learning_shadow_evaluation.sql; migrations/017_generation_learning_snapshots.sql; migrations/018_learning_quality_analytics_index.sql; migrations/019_learning_shadow_admission.sql.
- Administrator UI and browser test: public/app.js; public/index.html; public/styles.css; e2e/learning.browser.e2e.js.
- Targeted security hardening: src/rate-limit.js; test/rate-limit.test.js.
- Modified existing tests: test/config.test.js; test/configuration.mysql.js; test/content-service.test.js; test/database.integration.test.js; test/dispatcher.test.js; test/openrouter.test.js; test/routes.contract.test.js; test/scheduler.test.js.
- Added P0/P1 tests: test/generation-attempts.mysql.integration.test.js; test/learning-analytics.mysql.integration.test.js; test/learning-analytics.test.js; test/learning-attribution.test.js; test/learning-capture.test.js; test/learning-failure.mysql.integration.test.js; test/learning-metrics.test.js; test/learning-pool1.mysql.integration.test.js; test/learning-retention.mysql.integration.test.js; test/learning-retention.test.js; test/learning-security.test.js; test/learning-shadow-execution.test.js; test/learning-shadow.mysql.integration.test.js; test/learning-shadow.database-restart.test.js; test/learning-shadow.test.js; test/learning-shutdown.mysql.integration.test.js; test/learning-ui.contract.test.js; test/learning-upgrade.mysql.integration.test.js; test/learning.mysql.integration.test.js; test/learning.test.js; test/validation-outcomes.mysql.integration.test.js; test/validation-outcomes.test.js.
- Reports updated for this P1 closure: docs/AI_LEARNING_IMPLEMENTATION_STATUS.md; docs/AI_LEARNING_P1_ACCEPTANCE.md; docs/AI_LEARNING_SECURITY_TEST_MATRIX.md; docs/AI_LEARNING_BROWSER_ACCEPTANCE.md; docs/AI_LEARNING_PRODUCTION_READINESS.md.
- `docs/AI_LEARNING_P0_GAP_AUDIT.md` was reviewed and left unchanged because this closure pass found no new evidence changing the P0 findings.

### Final acceptance-closure files

This final verification/remediation pass changed `src/learning.js` (bounded active-rule population and deterministic conflict checks), `public/app.js` (administrator-facing lifecycle conflict errors), `e2e/learning.browser.e2e.js` (security, keyboard, and responsive browser probes), and focused regression coverage in `test/learning.test.js`, `test/learning-ui.contract.test.js`, `test/learning-security.test.js`, `test/server.test.js`, `test/database.integration.test.js`, `test/content-service.test.js`, and `test/learning-shadow.mysql.integration.test.js`. It updated the five reports listed above and added `docs/AI_LEARNING_MANUAL_ACCEPTANCE_CHECKLIST.md`. No migration was added.

The merged prompt and Enhanced Master Prompt are source documents, not implementation changes made by this report pass. The unrelated docs/featv1.md working-tree change was not edited, restored, staged, or committed.

The working tree contains an unrelated pre-existing change to docs/featv1.md. It was preserved and not edited, restored, staged, or committed by this report pass.

## Remaining blockers and deferred work

- Complete the remaining security evidence for the current workspace-wide administrator role: targeted Learning secret/log-output review and authorized isolated live-model adversarial testing. Non-admin role and tenant/per-record ownership scenarios are not implemented in the current model and are not claimed; anonymous access, CSRF, invalid IDs, and nonexistent objects were tested.
- Complete manual accessibility checks for screen-reader announcements, zoom, contrast, keyboard-only workflows, and modal focus behavior; Axe alone is insufficient.
- Mocked OpenRouter request construction with approved retrieval passed; live-provider behavior and adversarial model testing remain unverified and require separate provider authorization and spend limits.
- No dollar-cost, performance, storage-growth, or production-scale benchmark was run.
- Shadow start quotas are durable per authenticated administrator and admission locks coordinate app processes sharing a MySQL database. Separate databases have separate quotas/locks. No application dollar-cost cap or actual spend measurement exists.
- The commit-success/lost-ack case uses a wrapper after a real MySQL commit. Packet-level loss during the COMMIT response remains untested.
- Backup expiry is operator-managed; removed records may persist in backups through their retention window. Admin feedback and audit history have no app-enforced expiry.

## Finding classification and next release-readiness actions

| Class | Finding | Impact and required handling |
| --- | --- | --- |
| P0 | No new confirmed critical security, integrity, or publishing defect was established by this closure pass. | Keep the P0 attempt/validation foundation and publishing isolation unchanged; this is not production authorization. |
| P1 | Required manual accessibility evidence is missing: complete manual keyboard review, 200%/400% zoom, full contrast, and VoiceOver. | Complete the documented manual steps and attach observed results before P1 acceptance can become GO. |
| P1 | Security evidence is partial for the current workspace-wide administrator model: targeted XSS routes/fields passed, but exhaustive Learning secret/log-output review and live-model adversarial evaluation were not run. There is no non-admin role or tenant/per-record ownership boundary to test. | Preserve the stated authorization boundary; complete the targeted output-context review and run model-facing adversarial tests only in a separately authorized isolated environment. No exploit was confirmed in reviewed paths. |
| P1 | Real provider shadow execution lacks an application-enforced dollar cap and actual usage accounting. | Keep shadow disabled. Before any live provider call, obtain separate authorization, define numeric per-run and daily provider-side limits, and add spend observability. |
| P2 | Packet-level connection loss during the MySQL COMMIT acknowledgement was not injected; existing lost-ack coverage simulates a lost response after a real commit. | Retain as a targeted reliability follow-up; do not report it as a real packet-level fault test. |
| P2 | Production-scale latency, storage-growth, and backup-expiration behavior were not benchmarked or independently verified. | Measure on a restored non-production copy and publish the operator's backup-expiry window before rollout. |

Recommended next actions are to complete the manual accessibility session, close or explicitly bound the remaining security checks, then review Stage A on a restored non-production database. Stage transitions and production authorization remain separate decisions; no automatic progression is permitted.

## Decisions

**A — P1 implementation completeness: COMPLETE for implemented P1 functionality.** The lifecycle, scoped retrieval/prompt integration, immutable snapshots, isolated shadow evaluation, and three analytics pillars are implemented and exercised. This does not imply acceptance or activation.

**B — P1 acceptance: NO-GO.** Mandatory security and manual accessibility evidence is incomplete. The current authorization model has one workspace-wide administrator role shared by active administrator accounts; it has no tenant or per-record ownership boundary, so cross-tenant isolation is not a supported guarantee. There is no additional role hierarchy for cross-role authorization tests. Targeted XSS cases passed, while an exhaustive Learning secret/log-output review and live-model adversarial evaluation remain unexecuted. VoiceOver, actual 200%/400% browser zoom, full manual contrast, and complete manual keyboard walkthrough also remain unverified. These are documented P1 acceptance conditions, not confirmed P0 defects.

**C — Production activation: NO-GO.** This task does not authorize activation, production deployment, paid provider evaluation, or publishing.

## Final security and accessibility closure — 2026-11-10

This closure addendum supersedes earlier totals in this report. Two concrete defects were confirmed and fixed:

- **Medium — active-rule set truncation.** Both conflict checks and retrieval read only the first 500 active rules, while lifecycle operations did not limit active rules. This could omit later rules from conflict detection and silently return incomplete retrieval. The service now transactionally caps new activations at 500, checks the population and selected rows in one SQL snapshot, blocks activation with a clear conflict at the limit, and returns no lessons with an explicit incomplete reason if historical/out-of-band data exceeds the limit. Unit tests failed against the old behavior for the over-limit population, then passed with the fail-closed behavior; a second test verifies a 501st activation rolls back without writing.
- **Low — deterministic conflict-check false negative.** A rule directly instructing the model to call the Tebar API could pass the known application-control patterns. A focused regression failed before the fix, then passed after bounded checks for direct external-service actions and explicit unsafe content were added in `src/learning.js`. No provider tool is exposed to the model, so the finding did not enable an actual Tebar request; it could have admitted an unsafe prompt instruction. Deterministic checks remain finite and do not guarantee model behavior for novel wording.

No database migration was required. No production config, account, slot, schedule, ready payload, or publishing idempotency key was changed. The UI continues to render Learning strings as text. No real or paid provider was called.

### Acceptance evidence matrix

| Requirement ID | Requirement | Method and environment / exact test command | Observed result and evidence reference | Status | Residual risk |
| --- | --- | --- | --- | --- | --- |
| SEC-AUTH-01 | Unauthenticated Learning reads and mutations rejected before storage | `node --test test/learning-security.test.js`; mocked HTTP server | All registered Learning reads return 401; mutation routes without same-origin CSRF return 403 with zero storage queries. `test/learning-security.test.js` | PASS | No live deployment/proxy assessment. |
| SEC-AUTH-02 | Current admin role and object-access boundary | Route middleware source review plus local Chrome/isolated MySQL E2E | Active administrator sessions are required; invalid ID returns 400; nonexistent candidate decision returns safe 404 `CANDIDATE_NOT_FOUND`; anonymous request returns 401; no row changes. `e2e/learning.browser.e2e.js` | PASS for the existing role model | All active administrators share workspace-wide authority. No tenant or per-record owner boundary is implemented or claimed; reassess if that changes. |
| SEC-SESSION-01 | Cookie, session expiry, login, logout | `test/learning-security.test.js`, `test/server.test.js`, serial MySQL suite | Cookie flags, invalid/expired token rejection, CSRF-protected logout and cookie clearing, and an expired persisted session were tested. | PASS for tested controls | Reverse-proxy/TLS and production `TRUST_PROXY` settings were not exercised in this environment. |
| SEC-CSRF-01 | CSRF, foreign origin, unauthorized state changes | Route tests and browser E2E against local isolated MySQL | Missing/invalid CSRF and foreign Origin are rejected; review remains pending/version unchanged. `test/learning-security.test.js`, `e2e/learning.browser.e2e.js` | PASS | Does not replace ingress/deployment verification. |
| SEC-INPUT-01 | Malformed, oversized, unexpected types, invalid scope/status/IDs | Route, service and browser tests | Malformed JSON 400, 262145-byte JSON 413, invalid types/scope/query/id rejected; nonexistent ID yields safe 404. | PASS for tested cases | Not a fuzz test of every field combination. |
| SEC-SQL-01 | Injection-shaped search and parameterized identifiers | Browser E2E against isolated MySQL | `' OR 1=1 --` returns no candidate rows and does not broaden search. | PASS for tested routes | Not a full SQL-injection assessment of every SQL path. |
| SEC-XSS-01 | Candidate explanation and validation/category findings | Local headless Chrome, isolated MySQL | `<img onerror>` displays literally in card/detail; no image node or execution marker. `e2e/learning.browser.e2e.js` | PASS for tested payload | Other browser engines and every output context remain outside this probe. |
| SEC-XSS-02 | Search/filter reflected text | Local headless Chrome, isolated MySQL | XSS-shaped query searches bounded fixtures and returns literal text with no executable node. | PASS for tested input | Not all Unicode/encoding variants. |
| SEC-XSS-03 | Approved rule text and admin feedback | Local headless Chrome, isolated MySQL | Payload persisted as plain text and rendered literally; no executable node. | PASS for tested fields | Does not prove safety of all future rendering contexts. |
| SEC-XSS-04 | Analytics labels and error messages | Local headless Chrome with mocked metrics/shadow API responses | Adversarial category and error strings remain text; no generated `<img>` or execution marker. | PASS for tested responses | API error is deliberately mocked; no provider is involved. |
| SEC-OUTPUT-01 | Sensitive information in Learning error responses/logs | `node --test test/learning-security.test.js`; injected database failure with fake password and private host | Response is only `{error:"INTERNAL_ERROR"}`; log contains only event and safe code; fake details absent. `test/learning-security.test.js` | PASS for tested failure path | Not an exhaustive scan of all runtime logs, browser storage, or production traces. |
| SEC-CONC-01 | Duplicate/stale approval, concurrent activation/revision/rollback | Full serial disposable-MySQL suite | Transactional lifecycle and conflict tests pass; action/version state stays consistent. `test/learning.mysql.integration.test.js` | PASS for tested transactions | No multi-tenant race boundary exists. |
| SEC-FLAG-01 | Feature flags/defaults, shadow isolation and quota | Config/unit tests, browser app config assertions, isolated MySQL child process | Execution flags are false by default; approved lesson stays inactive unless explicitly activated in isolated test; separate Node process sees exhausted persisted quota; worker kill and real database restart recovery passed. | PASS for tested isolation | Limits are per administrator/database; no provider USD cap or separate-database global quota. |
| SEC-PUBLISH-01 | No shadow/lesson-triggered publishing or schedule changes | Unit service spies, dispatcher regression, E2E process config | No provider credentials; scheduler disabled; publisher/slot spies and app assertions show no shadow publishing path, ready-slot mutation, or live request. | PASS for tested isolated path | No live posting attempted, by design. |
| SEC-PROMPT-01 | Deterministic adversarial lesson checks and prompt hierarchy | `node --test test/learning.test.js test/content-service.test.js`; mocked OpenRouter transport | Tested instructions attempt system/fact override, validation disable, secret disclosure, provider change, unsafe content, posting changes, and Tebar calls. A lesson remains lower-trust user data and absent from privileged system/auditor requests; no tool is sent. | PASS for deterministic/mock contract | Pattern-based checks cannot cover all natural language. |
| SEC-PROMPT-02 | Model-facing adversarial behavior | Authorized model/test environment | **NOT EXECUTED**; no authorized real or non-paid model environment was available. Mock behavior is not equivalent to a model response. | NOT EXECUTED | Model response to malicious lesson text remains unknown. Do not enable prompt integration or make safety claims from the mock. |
| ACC-AUTO-01 | Automated accessibility and keyboard assertions | Local Playwright/Chrome E2E, Axe at 1280×900 | 7/7 browser tests pass; Axe reports no tested WCAG 2.0/2.1/2.2 A/AA violations on the scanned dashboard/Learning states; Enter/Space/Tab/Shift+Tab/Escape/focus restoration and viewport widths pass. | PASS for tested automation | Axe/headless events do not establish manual accessibility. |
| ACC-MAN-KBD | Full keyboard-only navigation and focus behavior | Manual interaction required | **NOT EXECUTED**; steps MAN-KBD-01–07 are blank in the manual checklist. | NOT EXECUTED | Human walkthrough required. |
| ACC-MAN-ZOOM | Actual 100%/200%/400% Chrome zoom/reflow | Native browser interaction required | **NOT EXECUTED**; viewport-width E2E is not browser zoom. Steps MAN-ZOOM-100/200/400 remain blank. | NOT EXECUTED | Human browser check required. |
| ACC-MAN-CONTRAST | Full visual contrast across states | Native visual review required | **NOT EXECUTED**; Axe and selected CSS checks are partial. Steps MAN-CON-01–05 remain blank. | NOT EXECUTED | Human inspection/ratio recording required. |
| ACC-MAN-VOICEOVER | macOS Safari VoiceOver | Assistive technology/user interaction required | **NOT EXECUTED**; VoiceOver was installed but off. Steps MAN-VO-01–08 remain blank. | NOT EXECUTED | Human screen-reader session required. |

### Exact final commands and results

| Command | Environment/result |
| --- | --- |
| `npm test` | DB-free run: **388 tests, 369 passed, 0 failed, 19 MySQL-gated skipped**. |
| `env NODE_ENV=test ALLOW_DESTRUCTIVE_DB_TESTS=true DB_HOST=127.0.0.1 DB_PORT=33345 DB_USER=root DB_PASSWORD='<local-test-password>' DB_NAME=merzz_test node --test --test-concurrency=1 test/*.test.js` | Disposable local MySQL 8.4.13: **403 tests, 401 passed, 0 failed, 2 gated skipped**. The test password was populated from the named disposable container in memory and was not printed. |
| `env NODE_ENV=test ALLOW_DESTRUCTIVE_DB_TESTS=true DB_HOST=127.0.0.1 DB_PORT=33345 DB_USER=root DB_PASSWORD='<local-test-password>' DB_NAME=merzz_test_upgrade node --test test/learning-upgrade.mysql.integration.test.js` | Fresh isolated upgrade schema: **1 passed, 0 failed, 0 skipped**. |
| `env NODE_ENV=test ALLOW_DESTRUCTIVE_DB_TESTS=true DB_HOST=127.0.0.1 DB_PORT=33345 DB_USER=root DB_PASSWORD='<local-test-password>' DB_NAME=merzz_test BOTMERZZ_TEST_MYSQL_CONTAINER=botmerzz-p1-final-mysql node --test test/learning-shadow.database-restart.test.js` | Real restart of the named disposable MySQL container: **1 passed, 0 failed, 0 skipped**. |
| `env NODE_ENV=test ALLOW_DESTRUCTIVE_DB_TESTS=true DB_HOST=127.0.0.1 DB_PORT=33345 DB_USER=root DB_PASSWORD='<local-test-password>' DB_NAME=merzz_test node --test test/learning-shadow.mysql.integration.test.js` | Separate-process durable quota and kill/recovery test: **1 passed, 0 failed, 0 skipped**. |
| `env NODE_ENV=test ALLOW_DESTRUCTIVE_DB_TESTS=true DB_HOST=127.0.0.1 DB_PORT=33345 DB_USER=root DB_PASSWORD='<local-test-password>' DB_NAME=merzz_test npm run test:integration` | Integration: **75 passed, 0 failed, 0 skipped**; MySQL configuration subtest: **1 passed, 0 failed, 0 skipped**. |
| `env NODE_ENV=test ALLOW_DESTRUCTIVE_DB_TESTS=true DB_HOST=127.0.0.1 DB_PORT=33345 DB_USER=root DB_PASSWORD='<local-test-password>' DB_NAME=merzz_browser_test BOTMERZZ_CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:learning:browser` | Isolated local app/MySQL, headless Chrome 157.0.8103.39: **7 passed, 0 failed, 0 skipped**. No provider credentials. |
| `node --test test/learning-security.test.js` | **5 passed, 0 failed, 0 skipped**, including Learning error/log redaction. |
| `node --test test/learning.test.js test/learning-ui.contract.test.js test/learning-security.test.js` | **33 passed, 0 failed, 0 skipped**, including 500-rule capacity guard, explicit over-limit retrieval result, and clear administrator messaging. |
| `npm run check`; `npm audit --audit-level=low`; `git diff --check` | Syntax check passed; 0 reported dependency vulnerabilities; clean diff check. |

The DB-free and MySQL suite counts overlap and must not be added as unique tests. Earlier 381/362, 384/365, 385/366, 396/394, and 400/398 totals in this report are superseded by these final counts. The first upgrade-test invocation correctly refused to proceed because the dedicated upgrade schema already contained 33 tables; only `merzz_test_upgrade` was then recreated, and the upgrade test passed 1/1. All manual rows are still blank; do not mark them passed without a human observation. The unrelated working-tree change to `docs/featv1.md` was preserved and not staged or restored.

### Readiness decision

- **Implementation status: COMPLETE for the existing P1 features; PARTIAL for this acceptance-closure task.** The 500-rule truncation and direct Tebar instruction gaps are closed with regression tests; mandatory manual accessibility and model-facing behavior evidence could not be executed here.
- **P1 acceptance: NO-GO.** Required keyboard, zoom, contrast, VoiceOver, and authorized model-facing adversarial evidence is missing. Use the manual checklist and keep any model test inside an authorized isolated environment.
- **Production activation/deployment: NO-GO.** No production operation, paid provider call, Threads publish, or deployment occurred.

## Final acceptance handoff — 2026-11-10

This handoff did not restart implementation. It rechecked the current reports and ran the remaining safe local automation. No paid provider was called; no provider credentials were placed in the manual environment; no rule was activated in the persistent manual schema or for generation. The separate disposable browser E2E had previously enabled activation temporarily to exercise explicit activation/deactivation/rollback of a test rule. No live publish was performed and no production system was contacted.

### Current acceptance crosswalk

| Requirement | Method / environment / exact command or procedure | Observed result and evidence | Status | Residual risk / blocker |
| --- | --- | --- | --- | --- |
| Automated shadow default-off route | `node --test test/learning-security.test.js test/server.test.js`; mocked HTTP route, valid admin+CSRF, shadow flag false | 18 passed, 0 failed, 0 skipped. Assertion confirms 503 `SHADOW_EVALUATION_DISABLED` and zero durable quota/evaluator calls. | PASS for tested route | Provider/model behavior is not covered by a mock. |
| Focused Learning security route suite | `node --test test/learning-security.test.js` | Current rerun: 6 passed, 0 failed, 0 skipped. Includes synthetic legacy version-secret withholding and provider/session/prompt/PII canaries against response, log, and notification output. | PASS for tested paths | Not a penetration test; arbitrary names/addresses in admin-authored free text remain outside generic detection. |
| Unit suite | `npm test` | Current rerun: 389 total, 370 passed, 0 failed, 19 explicitly MySQL-gated skips. Skips are not passes. | PASS for DB-free suite | MySQL-gated tests are represented by isolated MySQL results below. |
| Browser E2E | With a clean test environment: `DB_NAME=merzz_browser_test ALLOW_DESTRUCTIVE_DB_TESTS=true BOTMERZZ_CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:learning:browser` | 2026-11-10 rerun: 7 passed, 0 failed, 0 skipped in 16.15 seconds. The newer 2026-11-11 rerun including rule-list/version notices is recorded below. | PASS for automated scenarios | Not native browser zoom, full manual keyboard, contrast, or VoiceOver evidence. |
| Learning MySQL lifecycle + legacy-output regression | `DB_NAME=merzz_test node --test test/learning.mysql.integration.test.js` with root credentials from the disposable local container held in memory | Current isolated MySQL 8.4.13 run: 12 passed, 0 failed, 0 skipped. It inserted a synthetic legacy version containing fake provider/session canaries and verified the public mapping withholds them. | PASS for tested MySQL cases | The first attempt used the restricted manual DB user and failed on access; rerun succeeded using the disposable container's test-only root account. No production or manual schema changes. |
| Manual accessibility | Local handoff app and fixture database prepared; follow blank rows in `AI_LEARNING_MANUAL_ACCEPTANCE_CHECKLIST.md`. | Health endpoint returned ready; manual schema has one test admin, four synthetic published slots, three pending synthetic validation candidates, and no rules before review. No keyboard, zoom, contrast, or VoiceOver observation was performed. | NOT EXECUTED | Human acceptance required. |
| Learning secret/log output review | Source review of Learning route families, data mappers, UI output, error middleware/logging; synthetic local HTTP canaries; isolated MySQL and browser regression | Legacy rule-version instruction leak reproduced and fixed. Synthetic provider key, session token, internal-prompt, email, phone, and DB-error canaries are absent from tested HTTP errors/logs/notification events; unsafe legacy instruction is withheld from the version API and browser. | PASS for enumerated contexts; overall privacy assurance PARTIAL | Arbitrary names/street addresses in admin-authored free text are not detectable by the current conservative filter; production traces were not inspected. |
| Real-model adversarial evaluation | See [controlled evaluation plan](AI_LEARNING_CONTROLLED_MODEL_EVALUATION_PLAN.md). | No provider call made; handoff DB has blank provider credentials and shadow disabled. | NOT EXECUTED | Requires explicit authorization and provider-enforced USD ceilings. |
| Proxy / deployed ingress | Static config review only; local test environment, not deployed ingress. | `TRUST_PROXY` is explicit; actual VPS reverse-proxy hop and forwarded-header behavior were not inspected. | BLOCKED for production topology | Conditional production-only login-throttle availability risk; not a confirmed local Learning vulnerability. |

### Prepared manual environment and exact operator actions

The local app is running at `http://localhost:3000/` on the isolated disposable MySQL container `botmerzz-p1-final-mysql`, now bound at host `127.0.0.1:33345`. The host binding was corrected from all-interface publication while preserving the database volume; after restart, `npm run migrate` applied 0 migrations, the manual fixture counts remained one admin/four published synthetic slots/three pending synthetic candidates/zero rules, health and test-account login returned success, and the browser suite passed 7/7. The complete setup, CLI commands, `#tab-button-learning` route, isolated activation-confirmation override, browser E2E command, and cleanup instructions are in [AI_LEARNING_MANUAL_ACCEPTANCE_CHECKLIST.md](AI_LEARNING_MANUAL_ACCEPTANCE_CHECKLIST.md). The test-only account is `learning-manual-acceptance@example.test`; its password was delivered to the local operator outside this repository. Do not reuse it. The 0600 environment file is outside the repository under `/tmp` and contains only disposable DB settings with provider credentials blank.

The browser E2E uses a separate empty schema and deletes its fixtures. Do not treat its ephemeral login as the manual account. Candidates, review dialog, rule lifecycle, feedback, metrics, and shadow results are sections of the dashboard Learning tab.

### Genuinely outstanding requirements

1. Complete the blank manual keyboard-only rows, actual 100%/200%/400% Chrome zoom and reflow rows, visual contrast rows, and macOS Safari VoiceOver rows, attaching observations and sanitized evidence. If hardware/browser interaction is unavailable, mark a row BLOCKED and name what was unavailable.
2. Resolve the bounded data-minimization limitation for arbitrary names/addresses in administrator-authored feedback, reasons, and rule text before claiming that no unnecessary personal information can be exposed to workspace administrators. Production log/trace review remains a production-only gate.
3. Real-model behavior remains unknown. Existing acceptance rows P1-06/P1-11 and SEC-PROMPT-02 mark model-facing adversarial evaluation mandatory for P1. The merged Master §3 requires prompt-injection security testing; §5 defaults to mocked providers, requires explicit authorization before paid calls, and requires live-provider gaps to be documented. Preserve the acceptance blocker: mocks do not satisfy its model-facing portion. Explicitly authorize the isolated provider/account, exact model, scenario set, test window, maximum calls, per-run and aggregate USD caps, and provider-side enforcement before execution. The app has no dollar-metering control. The [evaluation plan](AI_LEARNING_CONTROLLED_MODEL_EVALUATION_PLAN.md) defines a bounded plan; execution remains disabled.
4. Before production activation only: verify the actual reverse-proxy hop and forwarded-client-IP normalization against deployed topology. Do not use unrestricted proxy trust. Also complete separate production migration/restore, backup expiry, rollout exposure, monitoring, provider-cost, and security gates in `AI_LEARNING_PRODUCTION_READINESS.md`.

The current admin model is workspace-wide: every active admin account has the same Learning authority. There is no non-admin Learning role, tenant, or per-record owner boundary. Anonymous access, invalid identifiers, and nonexistent objects are tested. Cross-tenant and cross-role tests are **not applicable** to the present architecture and do not represent an invented P1 requirement.

### Remaining work by verification type

1. **Automatable and rerun in this handoff:** unit suite, focused auth/session/CSRF/error tests, the disabled-shadow zero-quota gate, existing browser E2E, and static/syntax checks. MySQL lifecycle/recovery evidence remains from the prior isolated MySQL runs because no database/application implementation changed in this handoff. The outstanding exhaustive output/log context review is a reviewer evidence task; passing one more generic scanner would not close it.
2. **Physical/user interaction:** manual keyboard traversal, focus visibility/restoration, dialog Escape/keyboard behavior, native Chrome zoom/reflow at 100%/200%/400%, visual contrast readings, Safari VoiceOver announcements, and any dynamic status speech. These require a human on the prepared local environment; the checklist rows are blank.
3. **Explicit provider authorization:** real-model paired cases EVAL-01–03. No key is present in the manual environment. Authorization must name provider/account, exact model, scenarios, window, max calls, provider-enforced per-run and aggregate USD limits, and explicitly exclude production quota/publishing. Until then permitted spend is US$0 and the test is NOT EXECUTED.
4. **Production-only acceptance:** verify actual proxy trust/forwarded-IP behavior, migration and restore against a production-like copy, backup expiry, production security/log traces, spend controls/monitoring, and any staged exposure controls. These do not block local isolated development but do block production activation.
5. **Non-blocking future improvements:** multi-role/tenant IDOR coverage only if those authorization concepts are added; packet-level COMMIT-response fault injection; production-scale latency/storage benchmarking; app-side dollar usage metering; broader causal analytics. These are not evidence of a current P1 code defect. External provider hard limits are still mandatory before any paid real-model run.

### Separate readiness decisions

- **Implementation status:** COMPLETE for the implemented P1 feature set; acceptance evidence closure remains partial.
- **P1 acceptance:** **NO-GO.** Manual accessibility acceptance is still unobserved. The Learning output/log review is complete for the enumerated source paths and synthetic canaries, but arbitrary names/addresses in administrator-authored free text remain a bounded privacy limitation; real-model behavior was not authorized or executed. No confirmed P0 data-integrity or publishing regression was found in this closure pass.
- **Production activation/deployment:** **NO-GO.** All execution flags remain off in the handoff app; shadow, retrieval, prompt integration, live providers, scheduler, production DB, Threads publishing, and deployment were not enabled or used.

To close P1 acceptance, complete and record all manual checklist rows, confirm the workspace-wide administrator audience, and explicitly authorize the mandatory model-facing adversarial evaluation with provider/account/model/scenario/call limits and provider-enforced spend ceilings. No provider credentials are included in this report and no call is authorized here.

## Final evidence recheck — 2026-11-11

This section supersedes the 2026-11-10 secret/output-review status and test counts where they differ. It does not claim completion of physical/manual accessibility checks.

### Manual results recorded from repository evidence

The user described the manual accessibility checklist as completed, but the current workspace copy of `docs/AI_LEARNING_MANUAL_ACCEPTANCE_CHECKLIST.md` contains no observations, evidence references, tester/date fields, or statuses for all 23 rows (7 keyboard, 3 zoom, 5 contrast, 8 VoiceOver). The report and checklist remain **PENDING / NOT EXECUTED**. Prior automated key events, Axe scans, CSS-only checks, and a ready local fixture environment do not establish manual results. No row has been changed to PASS and no manual defect is claimed as reproduced. The local environment remains prepared for the operator to record actual results.

### Confirmed disclosure path and correction

Migration 015 copies legacy `learning_rules.instruction` values into immutable rule versions. Before this correction, both `GET /api/learning/rules` and `GET /api/learning/rules/:id/versions` could return legacy instruction text without recognizing standalone system/developer/internal prompt labels. A synthetic authenticated HTTP probe reproduced a standalone `SYSTEM PROMPT` canary in the version response; no real database value was examined.

Public Learning instruction output now uses a dedicated mapper. It returns a redacted excerpt with `instructionStatus:"redacted"`, or `instruction:null` with `instructionStatus:"withheld"` when supported credential/contact checks or explicit system/developer/internal prompt-label checks fail. Empty legacy text is `instructionStatus:"unavailable"`, not mislabeled as withheld. The current rules list, candidate instruction display, and version history use this public mapping; the UI renders fixed Indonesian status copy through its text-node renderer. Internal retrieval mapping and stored bytes are unchanged. Marker checks are bounded and are not a general detector for arbitrary prompt contents. No schema migration was needed. Regression coverage exists at route, isolated MySQL, and browser-rendering levels.

### Synthetic secret/output review

The source review covered candidate, rule, version, review, feedback, metrics, and shadow response mappings; the Learning UI renderers; central HTTP error handling; and Learning runtime logging. The focused error test injected synthetic provider credential, session-token, internal-prompt, email, phone, database password, and private-host canaries. The HTTP response contained only `INTERNAL_ERROR`; the logger received only `request.failed` plus the safe code; the notifier received only `system_error`. The canaries were absent from each.

Candidate captions and fingerprints remain withheld. Email and phone-like data are redacted in supported text fields. Lifecycle mutations expose only identifiers/status/version, analytics expose aggregate/bounded values, and Learning text is rendered with `textContent`. The only `innerHTML` found in the dashboard is fixed eye-icon SVG markup outside Learning. Learning APIs do not return the HttpOnly session token. `/api/session` returns the separate CSRF token used by the client; it is kept in memory rather than local/session storage. Provider failures are normalized before central logging or response.

**Residual privacy limit:** the existing pattern filter is not a general PII detector. A synthetic arbitrary name and street address in administrator-authored feedback/reason text remains unchanged and may be visible to all workspace admins. This is not a cross-tenant or unauthenticated exposure, and no actual personal record was inspected. The working policy is administrator-only free text with data minimization; the owner must confirm the existing workspace-wide audience. The policy does not require structured-only fields and does not claim complete PII minimization. Production logs/traces were not inspected.

### Current-session regression results

| Command / environment | Result | Evidence boundary |
| --- | --- | --- |
| `node --test test/learning-security.test.js` | **6 passed, 0 failed, 0 skipped** | Local HTTP server and synthetic fake-pool rows; includes safe error/log/notification canaries and legacy version API redaction. |
| `npm test` | **389 total: 370 passed, 0 failed, 19 MySQL-gated skipped** | DB-free unit run. Skips are not passes. |
| `node --test test/learning.mysql.integration.test.js` with `DB_NAME=merzz_test`, `DB_HOST=127.0.0.1`, and root password read from the named disposable container into memory | **12 passed, 0 failed, 0 skipped** | Disposable MySQL 8.4.13 on loopback. Inserts and reads a synthetic legacy rule row. No production DB. |
| `npm run test:learning:browser` with `DB_NAME=merzz_browser_test`, explicit destructive-test opt-in, and local Chrome | **7 passed, 0 failed, 0 skipped** (16.60 s) | Disposable MySQL + headless Chrome; includes candidate/current-rule/version withheld rendering and unavailable legacy text. No provider credentials or publishing. |
| `npm run check`; `git diff --check` | Both completed after the documentation edits: JavaScript syntax checks passed; diff check produced no whitespace/error output. | PASS for these checks only; they do not establish manual accessibility. |

The first attempted MySQL command used the restricted manual test DB user against `merzz_test`; it failed access control and ran no successful integration assertions. The command was corrected to use only the disposable container's local test root credential, held in memory, and then passed 12/12. This did not change the manual schema.

### Remaining P1 requirements and production-only gates

| Scope | Requirement | Current status | Required evidence/action |
| --- | --- | --- | --- |
| P1 acceptance | Manual keyboard-only traversal and focus restoration | NOT EXECUTED | Fill MAN-KBD-01–07 with observed result, tester/date, and evidence. |
| P1 acceptance | Native 100%, 200%, and 400% browser zoom/reflow | NOT EXECUTED | Fill MAN-ZOOM rows using Chrome zoom, not viewport resizing. |
| P1 acceptance | Visual WCAG 2.2 AA text/non-text contrast | NOT EXECUTED | Record actual color pairs/ratios and states in MAN-CON rows. |
| P1 acceptance | macOS Safari VoiceOver | NOT EXECUTED | Fill MAN-VO-01–08 with actual announcements and focus observations; do not infer from Axe. |
| P1 security/privacy | Unstructured admin text may contain arbitrary names/addresses | PARTIAL | Decide/record whether free-form text remains permitted for P1, with operator guidance and retention appropriate to its audience; no generic sanitizer guarantee is claimed. |
| P1 security blocker | Model-facing adversarial cases | BLOCKED / NOT EXECUTED | Existing P1-06/P1-11 and SEC-PROMPT-02 acceptance entries classify this as mandatory. Merged Master §5 requires mocks by default and explicit authorization for paid provider calls. Provide non-production provider/account/model, window, scenarios, call ceiling, and provider-enforced per-run/aggregate USD caps before execution. |
| Production only | Ingress/proxy trust, provider spend limits, restored migration/backup expiry, production log traces, staged exposure/monitoring | NOT EXECUTED / BLOCKED pending deployment evidence | Complete the separate gates in `AI_LEARNING_PRODUCTION_READINESS.md`; none were exercised here. |

### Current decisions

- **Implementation status:** PARTIAL for acceptance closure; the specific legacy instruction disclosure path is fixed and tested. No unrelated P1 feature rebuild was performed.
- **P1 acceptance:** **NO-GO.** Manual accessibility evidence is absent, owner confirmation of workspace-wide admin visibility is pending, and the mandatory model-facing adversarial evaluation is blocked pending provider/spend authorization. No provider call may occur without that authorization.
- **Production readiness / activation:** **NO-GO.** Production-only topology, spend, backup/restore, monitoring, and production trace gates are still open. All production Learning flags and credentials were left untouched. No Threads publishing or deployment occurred.

## Output-mapping completion recheck — 2026-11-11

This addendum supersedes the earlier November 11 output-mapping wording and test counts above. No P1 feature was rebuilt and no database migration was added.

The public-output review found that standalone internal-prompt labels could also pass through free-text candidate explanations, feedback/review/version/action reasons, and persisted shadow captions. These paths are now mapped before JSON serialization: `sanitizePublicText()` applies bounded contact/credential redaction and withholds explicitly labelled system/developer/internal prompt material; rule-action details use a fixed structured-field allowlist; shadow output uses a fixed result schema and sanitized captions before persistence and when old rows are read. Shadow IDs, version/context metadata, ratings, outcomes, and failure codes are constrained to known fields and values. Credential-shaped model IDs fail before shadow work starts and are hidden from old shadow rows. Rule instructions that fail the same eligibility check are rejected on approval/activation, skipped by active retrieval, and rejected from shadow input; valid rule retrieval and prompt hierarchy are unchanged, and all execution flags remain default-off. Text remains rendered with `textContent`.

No manual accessibility defect was reproducible because the repository checklist still contains no observations. No manual result was fabricated or marked PASS. Automated browser tests continue to pass, but Axe, viewport resizing, and scripted keyboard operations are not equivalent to the missing physical keyboard, native zoom, visual contrast, and Safari VoiceOver observations.

| Requirement ID | Environment / exact command | Observed result | Status | Residual risk |
| --- | --- | --- | --- | --- |
| SEC-OUTPUT-API-02 | `node --test test/learning-security.test.js test/learning-shadow.test.js test/learning.test.js test/learning-shadow-execution.test.js` | **48 passed, 0 failed, 0 skipped.** Synthetic prompt/credential canaries in candidate/feedback/review/version/action text and shadow results/context are absent from public mappings; structured action/rating metadata is allowlisted. Prompt-labelled rule instructions are not accepted for activation, live retrieval, or shadow input. | PASS for tested fields and guard | Pattern filters cannot identify arbitrary unlabeled prompts, names, or street addresses. |
| SEC-OUTPUT-SHADOW-DB-02 | Isolated MySQL 8.4.13, `node --test test/learning-shadow.mysql.integration.test.js` | **1 passed, 0 failed, 0 skipped.** Persisted shadow mapping retains safe status/recovery code while rejecting malformed metadata and unsafe caption output. | PASS for tested persisted path | Synthetic values only; no production shadow row was read. |
| SEC-OUTPUT-ERROR-LOG-01 | Synthetic HTTP exception canaries in `test/learning-security.test.js` | Response is `INTERNAL_ERROR`; log is safe code only; notifier is `system_error`; provider key/session/prompt/contact/database canaries are absent. | PASS for central error path | Production logs/traces were not inspected. |
| REG-UNIT-01 | `npm test` | **392 total: 373 passed, 0 failed, 19 MySQL-gated skipped.** | PASS for DB-free suite | Skipped MySQL cases are not passes. |
| REG-LEARNING-MYSQL-01 | Disposable MySQL 8.4.13, `node --test test/learning.mysql.integration.test.js` | **12 passed, 0 failed, 0 skipped.** | PASS for suite | Local disposable database only. |
| REG-SHADOW-MYSQL-01 | Disposable MySQL 8.4.13, `node --test test/learning-shadow.mysql.integration.test.js` | **1 passed, 0 failed, 0 skipped.** | PASS for suite | Local disposable database only. |
| REG-CHROME-01 | `npm run test:learning:browser`, disposable MySQL + local headless Chrome | **7 passed, 0 failed, 0 skipped** in 15.77 seconds. | PASS for automated E2E | Does not cover native zoom, physical keyboard, or VoiceOver. |
| REG-CHECK-01 | `npm run check && git diff --check` | JavaScript syntax and diff checks passed. | PASS | Not a behavioral or manual accessibility test. |

MySQL commands used loopback `127.0.0.1:33345`, the named disposable container password read into a shell variable, and `DB_NAME=merzz_test` or `merzz_browser_test`; the password was neither printed nor placed in reports. Browser E2E supplied blank OpenRouter/Tebar/Telegram credentials and kept scheduler and Learning execution flags off, except the isolated explicit activation lifecycle test. No provider call, production database access, Threads request, deployment, or credential change occurred. `docs/featv1.md` remains an unrelated existing worktree modification and was not edited or reverted.

### Remaining P1 blockers vs production-only gates

| Scope | Open item | Status and required action |
| --- | --- | --- |
| P1 acceptance | Manual accessibility: 7 keyboard, 3 zoom/reflow, 5 contrast, 8 VoiceOver observations | **NOT EXECUTED.** Record actual browser/OS, observations, evidence, tester and date in `AI_LEARNING_MANUAL_ACCEPTANCE_CHECKLIST.md`. |
| P1 acceptance | Administrator-authored free text and workspace-wide visibility | **POLICY RECORDED; OWNER CONFIRMATION PENDING.** The working policy is administrator-only free text with data minimization. Confirm that all active workspace admins may read the text. This does not claim comprehensive PII detection and does not require structured-only fields under the current policy. |
| P1 security blocker | Model-facing behavior under adversarial approved lessons | **BLOCKED / NOT EXECUTED.** Existing P1-06/P1-11 and SEC-PROMPT-02 acceptance entries classify it as a P1 blocker. Merged Master §3 requires prompt-injection security tests, while §5 defaults to mock providers and requires explicit authorization for paid calls; neither is used here to downgrade the recorded model-facing criterion. Mock request-contract tests do not satisfy it. Obtain explicit provider/account/model/scenario/call authorization and provider-enforced USD caps before any call. |
| Production only | Proxy/ingress trust, provider hard spend limit/monitoring, migration restore and backup expiry, production log/trace review, staged exposure | **NOT EXECUTED.** Complete the separate gates in `AI_LEARNING_PRODUCTION_READINESS.md` before activation. |

### Separate decisions

- **Implementation status:** PARTIAL for acceptance closure. Confirmed supported-label disclosure paths are fixed and regression tested; no manual accessibility defect was evidenced.
- **P1 acceptance:** **NO-GO** pending manual observations, owner confirmation of workspace-wide admin visibility, and the mandatory model-facing adversarial evaluation blocked on provider/spend authorization. Production activation remains NO-GO as well.
- **Production readiness / activation:** **NO-GO** pending deployment-context, spend, backup/restore, production-log, monitoring, and rollout gates. No production execution occurred.

## Acceptance closure recheck — 2026-11-11 (latest workspace evidence)

This latest recheck supersedes older test counts and the earlier browser run timing above. It records the current repository state and does not invent manual observations.

### Manual accessibility evidence

The current `docs/AI_LEARNING_MANUAL_ACCEPTANCE_CHECKLIST.md` still has 23 unrecorded rows (keyboard 7, zoom/reflow 3, contrast 5, VoiceOver 8): no tester/date, browser/OS observation, evidence reference, or PASS/FAIL value is present. No physical user interaction was provided in this session. Therefore there are **no manual PASS results** and no confirmed manual accessibility defect. Axe, scripted keyboard events, and responsive viewport tests remain automated evidence only.

### Current automated evidence

| Requirement | Command / environment | Result | Evidence boundary |
| --- | --- | --- | --- |
| Unit/regression | `npm test` | **393 total: 374 passed, 0 failed, 19 MySQL-gated skipped** | Skips are not passes. |
| Targeted output/security | `node --test test/learning-security.test.js test/learning-shadow.test.js test/learning.test.js test/learning-shadow-execution.test.js` | **49 passed, 0 failed, 0 skipped** | Synthetic canaries and mocked provider/storage paths only. |
| MySQL lifecycle | `node --test test/learning.mysql.integration.test.js` with isolated MySQL 8.4.13 at `127.0.0.1:33345`, `DB_NAME=merzz_test` | **12 passed, 0 failed, 0 skipped** | Disposable local database; no production data. |
| MySQL shadow persistence | `node --test test/learning-shadow.mysql.integration.test.js` with the same disposable MySQL | **1 passed, 0 failed, 0 skipped** | No provider request or publication. |
| Admin text policy UI contract | `node --test test/learning-ui.contract.test.js` | **5 passed, 0 failed, 0 skipped** | Checks workspace-wide visibility warning and `aria-describedby` wiring for free-text inputs. |
| Browser E2E | `npm run test:learning:browser`, local headless Chrome and `DB_NAME=merzz_browser_test` | **7 passed, 0 failed, 0 skipped** in **16.28 s** | Learning execution flags default-off; isolated lifecycle test only; no live provider/Threads. |
| Syntax/diff | `npm run check && git diff --check` | **Passed** | Syntax and whitespace checks only. |

The first E2E rerun exposed a test timing race at the feedback XSS fixture: the application intentionally focuses the slot ID on the next animation frame, while the test immediately filled another field. No product defect was reproduced. The browser test now waits for the intended focus handoff before continuing and then passed 7/7 without weakening its XSS assertion. This is an E2E synchronization correction, not manual keyboard acceptance.

The synthetic diagnostics review exercised Learning API mappers, browser-visible text rendering, central HTTP error handling, and captured logger/notifier inputs with fake provider credentials, session tokens, internal-prompt text, contact details, a database password, and a private-host marker. Tested errors serialize only the safe error code; diagnostic logs and notifications do not contain those canaries. Rule/action/shadow outputs are bounded/allowlisted; prompt-labelled values are withheld, and invalid legacy active rules fail closed for retrieval and shadow input. No production logs, traces, or provider payloads were available or inspected. Pattern-based redaction is not general PII detection: arbitrary names and addresses can remain in workspace-admin free text.

### Remaining P1 acceptance blockers

- **Manual accessibility evidence:** record all 23 actual keyboard, browser zoom/reflow, visual contrast, and macOS Safari VoiceOver results in `AI_LEARNING_MANUAL_ACCEPTANCE_CHECKLIST.md`, including environment, tester/date, expected/observed behavior, and evidence references. This is the direct acceptance blocker.
- **Free-text data minimization:** the working policy is documented and shown in the UI; product owner must confirm workspace-wide administrator visibility is intentional. Do not claim that the current redactor eliminates arbitrary PII.
- **Real-model adversarial evaluation:** remains unexecuted and is mandatory for P1 under the existing P1-06/P1-11 and SEC-PROMPT-02 acceptance entries. It is blocked pending explicit non-production provider/account/model/scenario/call authorization and provider-enforced spending ceilings.

### Decisions

- **Implementation status:** PARTIAL for acceptance closure; the verified output paths have regression coverage and the automated suite passes, but human accessibility evidence and owner confirmation of workspace-wide admin visibility remain open.
- **P1 acceptance:** **NO-GO** pending mandatory manual observations, owner confirmation of workspace-wide admin visibility, and the model-facing adversarial evaluation, which is blocked pending explicit authorization and spend limits. The data-minimization policy is documented and UI guidance is implemented.
- **Production readiness / activation:** **NO-GO**, independently of P1. Production proxy topology, provider-side spending/monitoring, backup/restore and backup expiry, production log review, staged exposure and rollback evidence remain production-only gates.

No provider request, production DB/credential change, Threads publication, deployment, or commit occurred. Learning execution flags remain default-off. The existing unrelated `docs/featv1.md` worktree modification was preserved.

## Administrator text policy and model-evaluation decision — 2026-11-11

This latest section supersedes earlier report wording about the free-text policy as undecided. It preserves the explicit model-facing adversarial evaluation as a mandatory P1 security criterion.

### Policy adopted pending owner confirmation

The repository reports and route implementation describe one `admin` role: every active administrator has the same workspace-wide Learning access. No tenant or per-record ownership model is present, and the reviewed current requirements do not promise either. This proposed policy does not conflict with that architecture, and no permission model was changed. It is recorded as the working policy **pending the owner's confirmation that workspace-wide administrator access is intentional**:

- Feedback, review rationale, and lesson text are administrator-only. Existing Learning routes enforce an authenticated admin session; mutations also use the existing same-origin CSRF guard.
- All active admins can read this text. The Learning screen now displays that fact and warns admins not to enter personal data, passwords, access tokens, or secrets. Feedback explanation, candidate/revision lesson text and rationales, and shadow-review free-text controls reference the warning for assistive technology.
- Server-side type and length validation remains in place: feedback explanation is capped at 1,000 characters; lesson instructions at 500; candidate decision and lifecycle/revision rationales at 300; shadow-review notes at 300. UI `maxlength` values now match the stricter server limits. Output uses the existing text-node/JSON mappings. No general PII detector is claimed.
- Learning request text is not included in Learning logger or notification fields; unexpected errors remain normalized to safe error codes. Analytics retain bounded aggregates and attribution identifiers rather than copying free-form text. Review decisions and rule history remain auditable.
- The existing evidence retention policy applies to temporary evidence only. Administrator feedback and review/audit context have no application-enforced expiry; that is the documented lifecycle/audit behavior. Database backups can retain deleted evidence until their operator-managed expiry. This task adds no migration and does not erase history.

Owner confirmation is still required before acceptance sign-off. If a narrower audience is intended, stop and obtain an explicit authorization-model change; do not infer tenant isolation or change permissions here.

### Real-provider evaluation is a mandatory P1 security gate

The source wording separates the security invariant from how to verify it. Merged Master §3 requires prompt-injection security testing, and §5 says to use mock providers/fixtures by default, prohibit paid calls without explicit authorization, and document behavior unverified against the live provider. The current P1 acceptance rows P1-06 and P1-11 and security criterion SEC-PROMPT-02 nevertheless classify model-facing adversarial behavior as a P1 blocker. This closure preserves that previously recorded mandatory criterion; mock request-contract tests do not satisfy the model-facing portion. It remains **BLOCKED / NOT EXECUTED** until the user explicitly authorizes the non-production provider/account/model/scenarios/call ceiling and provider-enforced per-run and aggregate spend caps. No provider call is authorized or made here.

The actual provider behavior remains unverified. Production learning activation remains NO-GO until the controlled evaluation is authorized and reviewed with provider-side spend limits. No provider request was made in this task.

### Latest affected-test evidence

The administrator-text guidance and UI/server length-limit alignment have UI contract and browser regressions. Only the directly affected UI contract and browser suites were rerun; this does not justify repeating the full regression suite. `node --test test/learning-ui.contract.test.js` passed **5/5**. The browser E2E verifies notice/field descriptions and max lengths, and passed **7/7**, 0 failed/skipped in **16.28 s**. The previous full results remain: 374 passed, 0 failed, 19 skipped of 393; focused security 49/49; MySQL lifecycle 12/12; shadow persistence 1/1. Manual outcomes remain blank and unexecuted.

**Current decision:** core P1 implementation is **COMPLETE**; acceptance closure is **PARTIAL**. Automated verification is PASS for the tested scope. Manual accessibility is NOT EXECUTED. Security controls pass for tested paths, with general PII detection not claimed. Model-facing adversarial evaluation is a mandatory P1 blocker marked BLOCKED/NOT EXECUTED. P1 acceptance remains **NO-GO** pending owner confirmation, all 23 manual observations, and explicit evaluation authorization plus passing results. Production activation remains **NO-GO**.

## Risk-based functional and release disposition — 2026-11-11

This current section supersedes earlier blanket acceptance classifications where this task explicitly changes the release threshold. It does not erase their historical evidence or mark deferred checks as passed. The user confirmed that all active authorized administrators have workspace-wide access to feedback and rule text; no authorization model change is required.

### Explicit acceptance requirement changes

| Previous acceptance entry | Current disposition | Rationale and residual risk | Owner and follow-up condition |
| --- | --- | --- | --- |
| P1-12: manual accessibility rows were a P1 acceptance blocker. | Reclassified as **IMPORTANT / DEFERRED**, not executed. Automated Axe/Playwright evidence is recorded separately and is not a manual pass. | This task explicitly permits progressing without unavailable manual accessibility equipment. Zoom/reflow, visual contrast, physical keyboard, and VoiceOver behavior remain unverified; no manual defect is asserted. | Accessibility QA owner records all 23 rows before broad administrator rollout; remediate any high-impact defect before release. The current deferral authorizes code progression/deployment with Learning flags off. |
| P1-06/P1-11 and SEC-PROMPT-02: real-model response was recorded as a P1 blocker. | Reclassified as **IMPORTANT / CONTROLLED ROLLOUT FOLLOW-UP**. Deterministic safeguards and mocked provider-request tests remain required and are covered by automated tests; no real provider was called. | The current task explicitly makes paid-provider testing optional at this stage and does not authorize calls. Mock coverage does not establish model behavior; novel malicious wording can still be followed by a real model. | AI Learning rollout owner schedules the evaluation before enabling shadow against a paid provider or enabling learning prompt integration. Any provider call requires separate provider/account/model, call-limit, and spend authorization. |
| Workspace-wide admin visibility was awaiting owner confirmation. | **CONFIRMED** by the user's current instruction. | All active authorized admins may read feedback/rule text. Bounded free text can still contain arbitrary names or addresses; no comprehensive PII detector is claimed. | Keep the UI minimization warning, server-side admin/CSRF checks, size limits, text encoding, audit trail, and no-raw-text logging. Revisit only if the product access model changes. |

These are risk-based release changes explicitly directed by the current user task; no additional approval is needed to defer those noncritical checks for an application-code deployment with all Learning execution flags off. Separate explicit authorization is still required for real provider calls and every Learning activation stage.

### Fresh verification for the current repository

| Area | Command / environment | Result |
| --- | --- | --- |
| Unit and service regression | `npm test` | **394 total: 375 passed, 0 failed, 19 MySQL-gated skipped.** Skips are not passes. |
| Core/MySQL publishing integration | `npm run test:integration`, isolated MySQL 8.4.13 | **75 passed** plus `test/configuration.mysql.js` **1 passed**, 0 failed/skipped. |
| Learning lifecycle, attempts, validation, analytics, retention, quota, shutdown and failure cases | Serial `node --test` runs for `generation-attempts`, `validation-outcomes`, `learning`, `learning-failure`, `learning-analytics`, `learning-retention`, `learning-pool1`, `learning-shadow`, and `learning-shutdown` MySQL integration files; disposable `merzz_test` | **25 passed, 0 failed, 0 skipped.** Includes worker kill/replay, rollback, lost-ack simulation, real InnoDB deadlock/lock wait, and stalled optional-query shutdown tests. |
| Browser E2E | `npm run test:learning:browser`, isolated MySQL and local Chrome 157 | **7 passed, 0 failed, 0 skipped** in **15.99 s**; no provider credentials or publishing integration. |
| Compose and deployment scripts | `docker compose -f compose.yaml config --quiet` using the local Compose environment; VPS Compose `config --quiet` with explicit non-secret test placeholders; `bash -n scripts/deploy-staging.sh scripts/retry-command.sh` | Passed. No deployment was executed. |
| Static/diff checks | `npm run check && git diff --check` | Passed. |

The MySQL integration runner initially lacked privileges on the dedicated `merzz_test` schema. After confirming it is a disposable schema, a temporary schema-scoped grant was added, the tests passed, and the grant was revoked; `SHOW GRANTS` confirmed the manual fixture user again has only its original manual/browser schema grants. The local MySQL container was loopback-bound. No production database, paid provider, Threads request, or production credential was accessed.

### Current release decisions

- **Core implementation:** **COMPLETE** for the requested P0/P1 functionality.
- **Functional acceptance:** **GO** for the deterministic, mocked, database-backed, and browser-tested workflows and critical invariants listed above. This does not mean manual accessibility or live-model evaluation passed.
- **Production deployment readiness:** **NO-GO for the actual target-specific preflight** because the target configuration, schema, proxy and verified production backup/restore are unavailable. The application template remains conditionally deployable with all Learning flags off only after the target-specific prerequisites in `AI_LEARNING_PRODUCTION_READINESS.md` pass. No production deployment occurred or is authorized here.
- **Learning activation readiness:** **NO-GO**. Keep all Learning execution flags default-off. Before enabling paid shadow calls or prompt integration, complete the controlled model evaluation with separate provider/spend authorization, verify provider-side budget controls, and conduct the staged approval/monitoring process.

### Deployment conditions and operational response

Before a production deployment, the deployment operator must verify: (1) public HTTPS `BASE_URL` and the actual reverse-proxy hop/forwarded-header behavior before setting `TRUST_PROXY=true`; (2) an encrypted offsite database backup and a successful restore rehearsal—the existing staging pre-deploy dump is same-host and unencrypted; (3) host MySQL resource limits and Docker log rotation/retention; (4) the exact digest-pinned app image and a controlled MySQL image-upgrade plan; and (5) `/health/live`, `/health/ready`, administrator login, and `/api/learning/capabilities` reporting all Learning execution flags false. The current deployment template is staging-only; no production topology or backup service was inspected. Application restart may immediately tick an enabled scheduler, so coordinate the window with existing due slots and do not run smoke checks against a live publisher.

Operator response: disable all Learning flags and recreate only the application service; verify capabilities remain false and readiness returns. For a problematic lesson, open AI Learning → Rules, verify its exact version/scope, then deactivate it or roll back to the last approved version; preserve audit history and do not rewrite ready slots. Retrieval errors fail closed to baseline generation. For a provider/publishing error, inspect the safe status code and durable slot activity; never retry an `unknown` publishing outcome blindly—use the existing reconciliation workflow. Learning attempt/outcome and candidate records provide capture-completeness evidence; `learning.capture`, `learning.execution_degraded`, `learning.retention_failed`, `scheduler.run_failed`, and publication state logs use bounded safe fields. The application has no metrics exporter, host MySQL pressure monitor, or Docker log-retention policy; configure these at the host/operations layer before deployment.
