# BotMerzz AI Learning Center — Implementation Status

## Current risk-based release decision — 2026-11-11

- **Core implementation:** COMPLETE for the P0/P1 lifecycle, learning, attribution, analytics, and shadow features.
- **Functional acceptance:** GO for tested critical workflows. Fresh runs: unit **375/394 passed, 0 failed, 19 MySQL-gated skips**; publishing/config integration **76/76**; Learning MySQL lifecycle/failure/analytics/retention/shadow/shutdown **25/25**; browser E2E **7/7**; syntax, Compose, deployment-script, and diff checks passed. Skips are not passes. Earlier migration upgrade evidence remains 1/1; no new migration was added in this task.
- **Production deployment readiness:** **NO-GO for the actual target-specific preflight** because the production host/config/schema, proxy and tested offsite restore are unavailable. The repo-level app template remains conditionally deployable only after the target prerequisites in `AI_LEARNING_PRODUCTION_READINESS.md` are verified. No production target was inspected or deployed.
- **Learning activation readiness:** NO-GO. Real-model behavior remains unverified and no paid call is authorized. Keep all Learning flags default-off; model evaluation and provider spend authorization are required before real-provider shadow or prompt integration.
- **Provider control residual:** the application does not enforce a provider allowlist or USD spend cap. Enabling shadow and starting an admin evaluation can call the configured provider; keep shadow off until exact provider/model/call authorization and external hard spend limits are established.
- **Accessibility:** 23 manual checklist rows remain NOT EXECUTED. This is an explicitly deferred important risk for code deployment, not a PASS and not a confirmed defect. Complete it before broad administrator rollout; fix any high-impact issue discovered.
- **Administrator access:** the user confirmed that all active authorized admins have workspace-wide access. Keep bounded free text, data-minimization warnings, server auth/CSRF, and audit history. No comprehensive PII detection is claimed.

The current user's risk-based acceptance instruction supersedes older blanket NO-GO statements for missing manual accessibility and real-model tests. It does not weaken any critical publishing, data-integrity, authorization, validation, or feature-flag invariant. The exact requirement changes and residual risks are recorded in `AI_LEARNING_P1_ACCEPTANCE.md` and `AI_LEARNING_SECURITY_TEST_MATRIX.md`.

**Decision A — P1 implementation completeness: COMPLETE for implemented P1 functionality.** The lifecycle, scoped retrieval and prompt integration, immutable attribution snapshots, isolated shadow evaluation, and three independent analytics pillars are implemented and exercised. This does not imply that the P1 acceptance gate is met.

**Historical strict P1 checklist status — NOT FULLY CLOSED.** Manual VoiceOver, actual Chrome 200%/400% zoom, and full manual contrast remain unverified; automated checks are not manual passes. Under the current task's risk-based gate, these are important deferred checks for a code deployment with Learning disabled. The current **functional acceptance is GO only for the tested critical workflows**; this does not claim every historical P1 checklist item passed.

**Decision C — Production learning activation: NO-GO.** No production activation, production migration, deployment, paid provider evaluation, or live Threads publishing occurred. All execution-affecting Learning flags default off.

**P0 → isolated P1 development: CONDITIONAL GO remains limited to isolated development.** The P0 attempt/outcome foundation was exercised on isolated MySQL. It does not authorize production changes.

## P0 lifecycle foundation

The original blocker was a lifecycle boundary placed in optional telemetry. Attempt identifiers and retry ordinals were local to a single generation call, while outcome capture could be dropped. This prevented reliable first-pass denominators and recovery.

Migration 014 and src/generation-attempts.js established durable operational attempt records. A slot-scoped logical operation is reserved before each model call. Slot locks and unique constraints protect ordinal assignment. Deterministic and semantic stage outcomes are persisted before a result can become ready. Unknown, incomplete, technical, and contextual outcomes remain distinct. Required persistence failures block ready-slot persistence. Stale interrupted attempts become unknown and the slot fails; generation and publishing are not blindly repeated. Optional Learning capture remains a separate, best-effort path.

The generation and publishing sequence is:

```text
Publishing slot → durable attempt reservation → generation
                 → deterministic validation → Semantic Auditor
                 → authoritative terminal outcome → ready payload
                 → existing dispatcher, provider idempotency, reconciliation
```

The existing publishing idempotency key, ready payload replay, scheduler semantics, and provider reconciliation remain unchanged by learning prompt integration.

## P1 functionality

### Rule lifecycle and conflict checks

Migration 015 adds immutable rule versions, per-version approvals, action audit, an active-version ledger, supersession state, and activation serialization. Approval does not activate a rule. Explicit administrator actions control activation, deactivation, revision approval, rollback, and supersession. Transactions and expected versions reject stale or conflicting operations. New/revised rules are inactive until explicitly activated.

Activation preview and transaction checks validate instruction content and scope against safety requirements, verified facts, Brand Content Direction, administrator guidelines, and active rules. Deterministic checks block known conflicts; AI conflict suggestions are non-authoritative.

Active rules have a transactional ceiling of 500 versions. Conflict evaluation reads the count and ordered rows from one database statement; activation adding rule 501 is rejected. If historical or out-of-band data exceeds the ceiling, retrieval returns no lesson instructions and an explicit over-limit result, and activation/revision operations fail closed. Operators must deactivate rules to return below the ceiling; no migration or historical rewriting was needed.

### Scoped retrieval and prompt integration

Retrieval selects approved active versions that match global or applicable product/topic scope. It excludes pending, rejected, false-positive, inactive, and superseded rules. Ordering and rule count/token estimate are bounded. The prompt treats approved memory as lower-trust data, below safety guardrails, verified facts/business constraints, and administrator guidelines. Lessons cannot change provider settings, publishing settings, or application controls.

Generation-time use requires activation, retrieval, and prompt-integration server flags. All default off. The database active bit cannot bypass disabled flags.

### Immutable attribution snapshots

Migration 017 stores one snapshot per generation attempt, including slot and attempt IDs, model/config references, fact versions, applied rule IDs/versions, omitted rules, flags, retrieval context, guideline fingerprints, validation contract, and timestamp. An in-flight attempt uses a frozen result. Replay is idempotent; a conflicting replay is rejected. A definite snapshot failure falls back to baseline generation; unresolved commit ambiguity prevents proceeding with potentially misattributed lessons.

### Shadow evaluation

Migration 016 stores shadow runs and paired reviews separately from live attempts and slots. Baseline and treatment use the same read-only scenario, model/configuration, guidelines, facts, and sampling settings where feasible. Shadow execution has no scheduler, slot, dispatcher, publisher, or Tebar reconciliation dependency.

Bounds include at most five rules, three sample pairs, 12 provider calls, 30,000 estimated tokens, 180 seconds per evaluation, and 15 seconds per provider call. Migration 019 adds a durable per-admin limit of three start requests per 15 minutes. A MySQL named lock scoped to the database allows one active evaluation across app processes. The lock uses one optional-pool connection; the second shadow-pool connection serves bounded queries. A restart releases the lock but leaves the run row; a recent `running` row blocks new work until the 300-second recovery threshold marks it `SHADOW_WORKER_INTERRUPTED`. The provider abort signal fires when the lock connection is lost. Shutdown also aborts in-flight provider work. Token usage is estimated, not a dollar-cost guarantee. No external provider or production shadow run occurred.

### Three independent analytics pillars

Migration 018 adds analytics query indexes. Reports do not combine indicators into a single score.

- **Content Compliance (compliance-v3):** first durable attempt for each eligible claimed slot; first-pass successes divided by eligible claimed first attempts minus technical exclusions. Contextual failures, unknown/incomplete outcomes, and missing attempts remain in the declared denominator and are disclosed; unresolved outcomes make the report incomplete, and truncated populations withhold rates. Legacy records with unverifiable identity are separately classified.
- **Content Quality (rubric-v1):** actual administrator ratings for hook, creativity, Bahasa Melayu Malaysia naturalness, audience relevance, brand voice, narrative clarity, diversity, and CTA appropriateness. Feedback coverage, positive/negative submissions, unrated feedback, per-dimension samples, and small-sample state remain explicit. Missing ratings are not positive.
- **Learning Effectiveness (effectiveness-v1):** exact rule version exposure from immutable snapshots, baseline and observed windows, first-attempt outcomes, relevant failure categories, human ratings, sample sizes, co-applied rules, and model/config/fact/guideline/validator confounders. Minimum sample and compatible validator requirements apply. The result is observational, not causal; insufficient data displays “Belum cukup data”.

## Migrations and implementation inventory

Migrations 011–019 extend the existing Node.js/MySQL stack:

| Migration | Purpose |
| --- | --- |
| 011_learning_center.sql | Candidates, review and evidence foundation. |
| 012_learning_events.sql | Optional learning event capture. |
| 013_validation_outcome_observations.sql | Legacy-compatible validation observations. |
| 014_generation_attempts.sql | Durable attempts, slot claim population, retention support. |
| 015_learning_lifecycle.sql | Immutable rules, approval, activation, version/action history, supersession. |
| 016_learning_shadow_evaluation.sql | Isolated shadow evaluations and reviews. |
| 017_generation_learning_snapshots.sql | Immutable generation attribution snapshots. |
| 018_learning_quality_analytics_index.sql | Analytics indexes. |
| 019_learning_shadow_admission.sql | Durable per-admin shadow start quotas; active evaluation concurrency uses a database-scoped MySQL named lock. |

P0/P1 services include src/generation-attempts.js, src/validation-outcomes.js, src/learning.js, src/learning-capture.js, src/learning-evidence.js, src/learning-attribution.js, src/learning-metrics.js, src/learning-analytics.js, src/learning-retention.js, src/learning-shadow.js, src/learning-shadow-execution.js, src/http/routes/learning.js, and src/http/routes/learning-evaluation.js. Integration points include src/cli.js, src/config.js, src/content-service.js, src/db.js, src/providers/openrouter.js, src/repository.js, src/scheduler.js, and src/server.js. Administrator UI is in public/index.html, public/app.js, and public/styles.css. Full test coverage inventory appears in the acceptance report and repository.

The documentation reports are:

- AI_LEARNING_P1_ACCEPTANCE.md
- AI_LEARNING_SECURITY_TEST_MATRIX.md
- AI_LEARNING_BROWSER_ACCEPTANCE.md
- AI_LEARNING_PRODUCTION_READINESS.md
- AI_LEARNING_P0_GAP_AUDIT.md

## Security, retention, and operational limits

- Learning APIs use administrator authentication, existing CSRF checks, schema and size validation, parameterized queries, and transactional lifecycle checks. The automated matrix is partial; it is not a penetration-test report.
- Candidate evidence remains conservatively withheld when unsafe or unavailable. The UI says evidence is unavailable and does not substitute unrelated captions. Admin text is length-bounded and rendered as text. Human review context is retained independently from temporary evidence cleanup.
- Cleanup is bounded and reports expired count, oldest age, throughput, and failures. It cannot guarantee a strict maximum age under persistent backlog. Admin feedback/explanations and audit history do not have application-enforced expiry. Backup expiration is operator-managed; deleted evidence may remain in backups until those backups expire.
- Optional capture and shadow have separate pools/lifecycle controls. A stalled optional query is isolated from publishing and bounded shutdown. Main publishing work is not force-canceled by optional-pool cleanup.
- No production-like latency, database write, index growth, storage, scheduler, or monetary-cost benchmark was run. Per-admin quotas and active shadow evaluation admission are shared across app processes that use the same MySQL database. Separate databases have separate limits.

## Verification evidence

Tests ran on local disposable MySQL 8.4.13 and a dedicated test schema. Substitute a local test-only password for the placeholder; never put a real credential in documentation.

| Command | Result |
| --- | --- |
| npm test | 388 tests: 369 passed, 0 failed, 19 intentionally MySQL-gated skips in the DB-free run. |
| env NODE_ENV=test ALLOW_DESTRUCTIVE_DB_TESTS=true DB_HOST=127.0.0.1 DB_PORT=33345 DB_USER=root DB_PASSWORD='replace-with-local-test-password' DB_NAME=merzz_test node --test --test-concurrency=1 test/*.test.js | 403 tests: 401 passed, 0 failed, 2 gated skips. Fresh-schema upgrade and actual database-restart tests ran separately. |
| env NODE_ENV=test DB_HOST=127.0.0.1 DB_PORT=33345 DB_USER=root DB_PASSWORD='replace-with-local-test-password' DB_NAME=merzz_test_upgrade ALLOW_DESTRUCTIVE_DB_TESTS=true node --test test/learning-upgrade.mysql.integration.test.js | 1 passed, 0 failed, 0 skipped; upgrade from migration 011 to current schema on a recreated isolated schema. |
| env NODE_ENV=test ALLOW_DESTRUCTIVE_DB_TESTS=true DB_HOST=127.0.0.1 DB_PORT=33345 DB_USER=root DB_PASSWORD='replace-with-local-test-password' DB_NAME=merzz_test BOTMERZZ_TEST_MYSQL_CONTAINER=botmerzz-p1-final-mysql node --test test/learning-shadow.database-restart.test.js | 1 passed, 0 failed, 0 skipped; restarted only the named disposable MySQL container, verified lock-loss cancellation and restart recovery. |
| env NODE_ENV=test DB_HOST=127.0.0.1 DB_PORT=33345 DB_USER=root DB_PASSWORD='replace-with-local-test-password' DB_NAME=merzz_test ALLOW_DESTRUCTIVE_DB_TESTS=true npm run test:integration | 75 passed, then test/configuration.mysql.js: 1 passed. |
| env NODE_ENV=test ALLOW_DESTRUCTIVE_DB_TESTS=true DB_HOST=127.0.0.1 DB_PORT=33345 DB_USER=root DB_PASSWORD='replace-with-local-test-password' DB_NAME=merzz_browser_test BOTMERZZ_CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:learning:browser | 7 passed, 0 failed, 0 skipped in 16.78 seconds; local server, disposable MySQL, headless local Chrome, no provider credentials. |
| npm run check | JavaScript syntax checks passed. |
| git diff --check | Passed. |
| npm audit --audit-level=low | 0 reported vulnerabilities. |

The test counts overlap and are not a unique aggregate. `npm run test:integration` separately passed 75 tests plus the MySQL configuration test (1 pass). The browser test ran admin login, candidate search/filter/pagination/empty state/details/decisions, lifecycle revision/rollback/audit, both feedback polarities, analytics disclosure and 90-day range with exact interval/API echo checks, rendered feedback counts (`2/4`, positive 1, negative 1), security probes, keyboard navigation, seven viewport widths, and Axe scans. Axe covered WCAG 2.0, 2.1, and 2.2 A/AA tags on dashboard and Learning surfaces at 1280×900. It captured no screenshot or trace.

An independent review found that the former `compliance-v2` calculation used successes plus contextual failures as the denominator while the UI disclosed the broader eligible first-attempt population. This material semantic mismatch is fixed as `compliance-v3` in the analytics service, population report, UI, and tests. Technical failures that prevented evaluation are excluded; unknown, incomplete, and missing records remain visible in the rate denominator, prevent a complete interpretation, and are not backfilled. A truncated population withholds the rate. Historical contract v1 remains unchanged.

The general bounded in-process IP limiter still fails closed at capacity. Shadow starts use a separate durable three-per-15-minute quota per authenticated administrator and a database-wide named lock. A targeted MySQL test now has a real child Node process attempt to consume an exhausted administrator quota and confirm that the persisted limit is shared across processes. A real restart of the named disposable MySQL container verifies lock-connection loss aborts the provider signal and a new worker remains blocked while a recent `running` row is unresolved. Compliance-v3 labels incomplete observed rates `Sementara · <rate>` and withholds the headline rate when the sample is too small or the population is truncated.

The final serial MySQL run exposed a stale test cleanup assumption: `database.integration.test.js` globally deleted administrator rows even though Learning shadow history intentionally has a restrictive actor foreign key. The test now temporarily isolates active-admin state, restores pre-existing active values, and retains audit-linked admin rows. The corrected test passes in the full serial suite; the schema's audit retention constraint remains unchanged.

A deterministic lesson conflict-check gap was reproduced: direct instructions to call the Tebar API were not rejected as external-service actions. Bounded checks and regression cases now reject direct Tebar/publishing API requests and explicit prohibited hate/personal-data instructions. The mocked generation test confirms such text is only placed in lower-trust user memory, absent from the privileged system prompt and independent semantic audit, and cannot call Tebar. This does not establish how a real model responds. No real or paid provider was called.

Security routes now have browser XSS checks for candidate/search text, approved rule instructions, administrator feedback, analytics labels and an API error; malformed/oversized JSON and invalid JSON types/scopes/IDs are covered by route/service tests. Browser route probes verify invalid IDs return 400, nonexistent candidates return safe 404, anonymous reads return 401, and foreign-origin mutation returns 403 without state change. Current authorization is workspace-wide for all active administrator accounts; it does not implement tenant or per-record ownership. Manual VoiceOver, true browser zoom, full contrast, and full keyboard walkthrough have not been performed because the interactive browser host was unavailable and VoiceOver was off. See the checklist and security matrix; these remain P1 acceptance blockers.

The active-rule query truncation risk is closed by the documented 500-rule ceiling and fail-closed over-limit behavior. The targeted unit test confirms retrieval avoids both truncated rule selection and unnecessary policy reads after detecting over-limit state; the transaction test confirms cap enforcement without mutation.

## Remaining acceptance blockers

- The current admin-only security boundary is explicit: all active admin accounts share workspace-wide access, with no tenant or per-record ownership model. Invalid and nonexistent IDs and unauthenticated direct access are tested. Future role/tenant isolation is out of scope until such a boundary exists. An exhaustive Learning-specific secret/log-output review remains not executed.
- Manual keyboard-only review, macOS Safari VoiceOver, actual Chrome 200%/400% zoom, and full visual contrast review remain unverified. Automated Playwright checks include Enter, Space, Tab, Shift+Tab, Escape, dialog focus containment/restoration, desktop tab arrows, and responsive widths; Axe is not a substitute for manual or assistive-technology review.
- The enabled retrieval-to-generation path and exact OpenRouter request construction were verified with a mocked transport, including compound adversarial lesson text. No live model behavior test was run; no paid provider call was authorized.
- No production-scale performance or dollar-cost benchmark.
- The successful-commit/lost-ack test uses a wrapper after real MySQL commit. It is not a packet-level failure during the COMMIT response.
- Backup expiry remains an external operator policy; feedback and audit retention is not application-expiring.
- The per-admin limit is durable, but a process-level or database-level monetary spend cap is not implemented. Provider dollar spend is not measured; an operator-managed spend cap is required before real shadow calls.

## Readiness

- **P0 → isolated P1 development: CONDITIONAL GO**, limited to isolated development.
- **P1 implementation completeness: COMPLETE**, for the implementation scope above.
- **P1 acceptance: NO-GO**, because security and manual accessibility evidence is incomplete.
- **Production learning activation: NO-GO.**
- **Production deployment or live Threads publishing:** not performed or authorized.

Decision A is intentionally separate from Decision B: implementation completeness does not establish acceptance or production readiness.

## Final P1 acceptance handoff — 2026-11-10

Core P1 implementation remains complete; acceptance remains partial. This handoff adds one focused assertion in the existing `test/learning-security.test.js`: when shadow evaluation is disabled, an authenticated, same-origin request returns 503 before durable quota or evaluation/provider work. No feature, migration, provider integration, or production behavior was added in this acceptance-only pass.

### Handoff verification

| Command / procedure | Observed result |
| --- | --- |
| `node --test test/learning-security.test.js` | 5 passed, 0 failed, 0 skipped. |
| `node --test test/learning-security.test.js test/server.test.js` | 18 passed, 0 failed, 0 skipped. |
| `npm test` | 388 total, 369 passed, 0 failed, 19 MySQL-gated skips. The skips are not passes. |
| `DB_NAME=merzz_browser_test ALLOW_DESTRUCTIVE_DB_TESTS=true BOTMERZZ_CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:learning:browser` | Latest rerun after MySQL was rebound to `127.0.0.1:33345`: 7 passed, 0 failed, 0 skipped in 16.09 seconds. |
| Manual environment recreation | Existing `npm run migrate` applied 0 migrations on the already-migrated isolated schema; `npm start` reported `environment: test` and `schedulerEnabled: false`; `curl --fail --silent --show-error http://localhost:3000/health/ready` returned `{"status":"ready"}`. |

The previous full isolated MySQL, upgrade, actual disposable MySQL restart, and integration results remain the last full DB-backed results. They were not rerun in this handoff because no database/application implementation code changed. Exact prior commands and results remain in the P1 acceptance report. The latest browser E2E rerun supersedes the earlier 16.78- and 16.51-second results; it passed 7/7 in 16.09 seconds after the loopback port correction. No screenshots or traces were captured.

### Manual environment status

The application is running at `http://localhost:3000/` against disposable schema `merzz_manual_test`. The MySQL container port is bound to host loopback `127.0.0.1:33345`; the existing named volume was preserved during rebind. There are no provider credentials, scheduler is disabled, and all Learning execution flags are off. It has one synthetic admin, four synthetic published slots, and three pending synthetic validation candidates; there were no rules before review. After rebind, migrations reported zero new migrations, fixture counts were preserved, test-account login returned 200, and `/health/ready` returned ready. Setup, new admin, isolated activation-confirmation, browser E2E, and cleanup commands are in `AI_LEARNING_MANUAL_ACCEPTANCE_CHECKLIST.md`. No physical keyboard, native zoom, contrast, or VoiceOver checks were performed; every manual row remains unrecorded.

### Acceptance disposition

- **Implementation:** COMPLETE for implemented P1 functionality.
- **P1 acceptance:** **NO-GO**. Mandatory manual accessibility evidence remains absent. The Learning-specific output/log review is targeted but not exhaustive. Real-model adversarial evaluation remains NOT EXECUTED and requires separate explicit authorization and provider-enforced spend limits.
- **Production activation:** **NO-GO**. A conditional medium login-throttle risk depending on the real reverse-proxy topology must be resolved as a production-only gate. No production database, account, schedule, API quota, Threads publisher, or deployment was used.
- **Next artifact:** [Controlled model evaluation plan](AI_LEARNING_CONTROLLED_MODEL_EVALUATION_PLAN.md), prepared but not executed; allowed provider spend remains US$0 pending explicit authorization.

Cross-role or tenant IDOR remains not applicable to the one-role workspace-wide admin specification. Do not treat the absence of tenant isolation as a defect unless the product authorization model changes.
