# BotMerzz AI Learning Center — P1 Final Closure & Controlled Evaluation Readiness

## ROLE AND MISSION

Act as a Principal Software Engineer, AI Security Architect, SRE, Accessibility Engineer, Database Reliability Engineer, and QA Lead.

Continue the existing BotMerzz AI Learning Center implementation.

The core P1 implementation is reported COMPLETE, but P1 acceptance and production activation remain NO-GO.

Your objective is to close all remaining P1 acceptance blockers, verify the implemented learning pipeline end-to-end, remediate confirmed defects, and prepare an evidence-based controlled rollout plan.

**This is a final verification and targeted remediation task. Do not rebuild P0/P1 or introduce unnecessary new features.**

Implement and verify corrections rather than stopping after analysis.

## 1. SOURCE OF TRUTH

Inspect the actual repository and the following documents:

- `docs/AI_LEARNING_IMPLEMENTATION_STATUS.md`
- `docs/AI_LEARNING_P0_GAP_AUDIT.md`
- `docs/AI_LEARNING_P1_ACCEPTANCE.md`
- `docs/AI_LEARNING_SECURITY_TEST_MATRIX.md`
- `docs/AI_LEARNING_BROWSER_ACCEPTANCE.md`
- `docs/AI_LEARNING_PRODUCTION_READINESS.md`
- `BOTMERZZ_AI_LEARNING_P1_MASTER_MERGED.md`, if available.

Verify all documented claims against the current codebase.

Preserve the existing migrations through 018.

Do not modify the unrelated pre-existing deletion of `docs/featv1.md`, restore it, stage it, or include it in a task-specific commit without explicit authorization.

## 2. CURRENT VERIFIED BASELINE

The latest agent report states:

- Core P1 functionality implemented.
- Learning lifecycle, scoped retrieval, prompt integration, snapshots, and shadow evaluation implemented.
- Three independent analytics pillars implemented.
- Compliance contract updated to `compliance-v3`.
- IP limiter capacity behavior corrected.
- Browser E2E: 7 passed.
- Serial MySQL: 386 passed, 1 skipped.
- Existing integration tests: 75 passed.
- Dependency audit: zero reported vulnerabilities.
- Learning execution flags remain disabled by default.
- No production deployment or live Threads publishing occurred.

Treat this as a reported baseline. Do not blindly repeat all testing if relevant unchanged results can be reliably established, but rerun tests affected by modifications and the final required acceptance suites.

## 3. COMPLETE SECURITY VERIFICATION MATRIX

Audit all remaining unchecked or unverified items in `docs/AI_LEARNING_SECURITY_TEST_MATRIX.md`.

For each item:

1. Identify the requirement.
2. Locate its implementation.
3. Define the expected security invariant.
4. Execute an appropriate test.
5. Record exact evidence.
6. Fix confirmed defects.
7. Add regression tests.

### Mandatory security areas

- Authentication and administrator authorization.
- IDOR and cross-record access.
- CSRF, where applicable.
- Stored and reflected XSS.
- SQL injection resistance.
- Input validation and payload limits.
- Session and cookie security.
- Concurrent approval and activation.
- Rule version integrity.
- Rollback authorization.
- Prompt injection resistance.
- Sensitive information exposure.
- Feature-flag enforcement.
- Rate limiting and abuse prevention.
- Safe error responses.
- Audit logging.

Test malicious learning rule instructions attempting to override verified product facts, disable validation, expose credentials, change provider configuration, or trigger publishing.

Treat approved lesson text as lower-priority guidance rather than unrestricted system instructions.

Do not mark any security item PASS without actual verification evidence.

## 4. MANUAL ACCESSIBILITY COMPLETION

Use the existing browser testing infrastructure and Chrome 157 environment where available.

Complete the remaining checks:

### Keyboard

- Tab navigation.
- Reverse tab navigation.
- Focus visibility.
- Modal focus trapping.
- Focus restoration.
- Escape handling.
- Keyboard operation of review and lifecycle controls.

### Zoom and responsive behavior

- 200% zoom.
- 400% zoom where applicable.
- Reflow and horizontal overflow.
- Form usability at narrow viewports.

### Contrast

Verify text, controls, status indicators, focus rings, and relevant non-text interface elements against the applicable WCAG 2.2 AA requirements.

### Screen reader

Test major workflows using an available supported screen reader.

Verify accessible labels, status announcements, validation errors, tables, dialogs, and dynamic content.

Automated Axe results must remain separate from manual verification.

If actual assistive-technology testing is unavailable, explicitly mark it unverified and supply reproducible test steps.

Do not fabricate manual testing evidence.

## 5. PROVIDER CONTRACT AND PROMPT INTEGRATION VERIFICATION

Verify that approved learning retrieval and prompt integration work correctly with the application's OpenRouter-facing generation adapter.

Use mock providers, recorded fixtures, and isolated environments by default.

Test:

- Approved active lessons being selected correctly when isolated execution flags permit.
- Unapproved and inactive lessons being excluded.
- Correct scope matching.
- Deterministic ordering.
- Prompt token budget.
- Model selection compatibility.
- Existing AI Content Guidelines priority.
- Verified product-fact protection.
- Semantic Auditor independence.
- Provider error handling.
- Timeout and malformed response behavior.
- Generation snapshot consistency.
- Retry and concurrency behavior.

Validate actual provider request construction, not only the internal lesson-selection service.

Do not use a real paid provider without explicit authorization.

Do not publish to Threads.

Document any behavior that remains unverified against the live provider.

## 6. SHADOW MODE RESOURCE AND ISOLATION AUDIT

The current shadow limiter reportedly uses process-local quotas.

Determine whether the deployed architecture can operate multiple application processes or replicas.

### If single-instance operation is guaranteed

Document the guarantee and verify that process-local quotas are sufficient for the currently supported deployment.

### If multiple instances are supported or planned

Evaluate whether a shared limiter is needed to enforce a global budget.

Prefer existing MySQL infrastructure or another already deployed mechanism where appropriate.

Do not introduce Redis or a new distributed service merely for theoretical scaling.

### Required invariants

- Shadow evaluation cannot publish.
- No Tebar calls are made.
- No active schedules are mutated.
- No ready slots are changed.
- No production idempotency keys are reused.
- Limits apply consistently under concurrent requests.
- Cost and token budgets are bounded.
- Failed or canceled evaluations release capacity correctly.
- Worker restarts do not silently bypass safety guarantees.
- Resource saturation cannot starve publishing.

Test concurrent shadow requests, cancellation, timeouts, limiter exhaustion, and restart behavior.

## 7. COMPLIANCE-V3 METRIC INTEGRITY

Audit `compliance-v3` using authoritative generation attempt and validation outcome records.

Verify:

- Eligible first attempts.
- Technical exclusions.
- Contextual failures.
- Passed attempts.
- Unknown outcomes.
- Incomplete outcomes.
- Missing outcomes.
- Retry handling.
- Legacy-data classifications.
- Report completeness flags.

Ensure `evaluatedFirstAttempts` consistently represents the documented evaluated population.

Where the denominator includes unknown, incomplete, or missing outcomes, the UI must not misleadingly present the result as a fully observed approval rate.

Clearly distinguish an observed rate from an incomplete or provisional report.

Do not silently exclude uncertain outcomes.

Preserve historical metric versions and avoid fabricating backfilled results.

Add regression tests for small samples, empty populations, and incomplete observation periods.

## 8. CONTENT QUALITY AND LEARNING EFFECTIVENESS VERIFICATION

Verify that Content Quality calculations are based on actual human feedback, not assumed content quality.

Check:

- Feedback coverage.
- Positive/negative classifications.
- Per-dimension ratings.
- Missing ratings.
- Multiple reviewers.
- Edited reviews.
- Sample-size disclosure.

Verify Learning Effectiveness calculations using actual applied rule version attribution.

Check:

- Baseline windows.
- Observation windows.
- Rule versions.
- Model/configuration changes.
- Insufficient-data states.
- Concurrent rule application.
- Non-causal interpretation.

Do not label a lesson effective merely because a failure percentage decreases in an uncontrolled comparison.

Do not invent quality ratings, Threads engagement, or conversion data.

## 9. OPERATIONAL FAILURE AND RECOVERY TESTS

Perform targeted verification of:

- Feature-flag misconfiguration.
- Learning database errors.
- Rule retrieval timeouts.
- Concurrent activation and deactivation.
- Stale execution snapshots.
- Provider failures.
- Shadow worker cancellation.
- Resource exhaustion.
- Database reconnection.
- Restart during shadow evaluation.
- Stalled cleanup operations.
- Safe shutdown behavior.

Preserve all authoritative P0 attempt and validation guarantees.

Ensure optional learning functionality cannot cause duplicate or unexpected publishing.

## 10. PRODUCTION ROLLOUT DESIGN — DOCUMENTATION ONLY

Create a controlled rollout plan without deploying or activating anything.

The plan must define:

### Stage A — Inactive deployment verification

- All execution flags off.
- No active lesson injected.
- Configuration validation.
- Database migration readiness.
- Basic health verification.

### Stage B — Capture-only observation

- Learning capture enabled only after explicit approval.
- No lesson prompt integration.
- Capture completeness monitoring.
- Database and application performance monitoring.

### Stage C — Isolated shadow evaluation

- No publishing.
- Budget-controlled evaluations.
- Explicit provider authorization if real API calls are required.
- Security and quality regression review.

### Stage D — Limited learning integration

- Explicit administrator approval.
- Narrow scope and limited exposure.
- Safety validation remains authoritative.
- Monitoring and rapid disablement.

### Stage E — Expanded activation

- Only after evidence supports expansion.
- No automatic progression between stages.
- Separate authorization required.

Define measurable exit criteria for each stage.

Do not automatically enable any stage.

## 11. KILL SWITCH AND ROLLBACK VERIFICATION

Verify that disabling learning execution prevents new lesson application without:

- Deleting approved rules.
- Rewriting historical snapshots.
- Mutating ready slots.
- Changing posting schedules.
- Resetting provider settings.
- Triggering additional publishing.

Define expected behavior for in-flight generations and new generations after the switch is disabled.

Test rollback or disablement under concurrent execution.

Do not confuse feature deactivation with rollback of historical data.

## 12. OBSERVABILITY AND RELEASE MONITORING

Review existing instrumentation for:

- Learning retrieval errors.
- Rule activation failures.
- Prompt budget overruns.
- Shadow request counts.
- Shadow budget consumption.
- Provider timeout rates.
- Validation pass/failure rates.
- Capture completeness.
- Database pressure.
- Publishing regression indicators.

Reuse existing logging and monitoring mechanisms.

Avoid sensitive prompt or credential logging.

Do not introduce unnecessary infrastructure.

## 13. FINAL TEST MATRIX

Execute all relevant:

- Unit tests.
- MySQL integration tests.
- Migration upgrade tests.
- API authorization tests.
- Prompt injection tests.
- Rule lifecycle tests.
- Prompt integration contract tests.
- Three-pillar metric tests.
- Browser E2E tests.
- Automated accessibility tests.
- Available manual accessibility tests.
- Shadow isolation tests.
- Publishing regression tests.

Report PASS, FAIL, SKIP, BLOCKED, and NOT EXECUTED separately.

Do not count skipped tests as passed.

Document test environment, exact commands, and meaningful verification evidence.

## 14. ACCEPTANCE CLASSIFICATION

For every remaining finding, assign:

- P0 — Critical security, data integrity, or publishing correctness risk.
- P1 — Required P1 acceptance behavior.
- P2 — Non-blocking improvement or future optimization.

Do not invent blockers or continuously expand the acceptance scope without evidence.

A confirmed critical risk requires NO-GO.

Unavailable manual testing must be explicitly disclosed. Determine whether it blocks the required acceptance gate based on the documented requirements; do not silently waive it.

## 15. FINAL ACCEPTANCE GATE

P1 acceptance can be GO only when:

- All mandatory security invariants are verified.
- Browser workflows pass.
- Required accessibility acceptance is completed.
- Rule lifecycle and authorization pass.
- Scoped retrieval and prompt integration pass.
- Shadow isolation and resource protection pass.
- Compliance-v3 calculations pass.
- Content Quality calculations pass.
- Learning Effectiveness calculations pass.
- Feature-flag safety passes.
- Publishing regression tests pass.
- No critical unresolved defects remain.

A CONDITIONAL GO may only be reported for explicitly documented noncritical conditions that do not compromise the safety of continued isolated development.

Production activation must remain NO-GO during this task.

## 16. FINAL REPORTING

Update:

- `docs/AI_LEARNING_IMPLEMENTATION_STATUS.md`
- `docs/AI_LEARNING_P1_ACCEPTANCE.md`
- `docs/AI_LEARNING_SECURITY_TEST_MATRIX.md`
- `docs/AI_LEARNING_BROWSER_ACCEPTANCE.md`
- `docs/AI_LEARNING_PRODUCTION_READINESS.md`

Update the P0 gap audit only if new evidence changes an existing P0 finding.

Provide:

1. Remaining acceptance gaps discovered.
2. Root causes and remediation.
3. Security verification matrix.
4. Accessibility verification results.
5. Provider contract verification.
6. Shadow limiter architecture decision.
7. Compliance-v3 validation.
8. Content Quality verification.
9. Learning Effectiveness verification.
10. Publishing regression results.
11. Modified files.
12. Exact test commands and results.
13. Remaining risks and limitations.
14. P1 acceptance GO/CONDITIONAL GO/NO-GO.
15. Production activation NO-GO.
16. Recommended next release-readiness actions.

Preserve unrelated working-tree modifications.

Do not commit or deploy unless separately authorized.

---

# FINAL EXECUTION INSTRUCTION

Begin final P1 verification and remediation immediately.

Use the existing repository as the authoritative implementation source.

Do not stop after planning.

Fix confirmed defects, add focused regression tests, and complete the remaining acceptance checks.

Do not rebuild working P0/P1 systems.

Do not introduce unnecessary infrastructure or new AI frameworks.

Do not enable production learning execution.

Do not run paid provider calls without permission.

Do not publish to Threads.

Do not deploy to production.

**The goal is to establish a fully verified P1 learning system and a trustworthy controlled rollout plan, while keeping all production execution capabilities disabled until separately authorized.**