# AI Learning Center — P0 Gap Audit and Resolution

## Current status (P1 implementation follow-through)

The P1 lifecycle, scoped retrieval/prompt integration, immutable execution snapshots, isolated shadow evaluation, and three-pillar analytics are implemented and exercised. The local Chrome browser matrix now passes for the exercised flows. P1 acceptance remains **NO-GO** because the complete security matrix and manual accessibility evidence are incomplete. P0 remains a **CONDITIONAL GO for isolated P1 development only**. Production learning activation remains **NO-GO**. See [AI_LEARNING_IMPLEMENTATION_STATUS.md](AI_LEARNING_IMPLEMENTATION_STATUS.md) and [AI_LEARNING_P1_ACCEPTANCE.md](AI_LEARNING_P1_ACCEPTANCE.md) for current evidence and decisions.

## Root cause

The previous P0 work represented generation attempts and validation results as optional observations. `generatePost` assigned random IDs and local loop ordinals. `recordOutcome` was called without awaiting; it only existed when learning capture was enabled. Migration 013 persisted an observation only after delivery. This made the same slot's ordinal 1 repeat after a new invocation and made both the attempt population and missing-outcome population unknowable. Shutdown could also wait on optional pool shutdown even though JavaScript timeout did not cancel the MySQL query.

The common cause was a lifecycle boundary placed in telemetry. The repair moves identity reservation and mandatory stage outcomes into operational state before ready-slot persistence. Optional candidate capture remains a separate, best-effort path.

## Source-of-truth dependency map

| Concern | Repository evidence | Authority / interaction |
| --- | --- | --- |
| Slot creation and claim | `src/repository.js`: `ensureNextDueSlot`, `claimDueSlot` | Durable slot is claimed `pending → generating`; 10-minute stale generation handling is in `ensureNextDueSlot`. |
| Generation retry | `src/content-service.js`: `generatePost` loop | Two model-generation iterations; the new reservation precedes each model call. |
| Deterministic validation | `src/content-service.js` calls `validateFullCaption` from `src/content-validation.js` | Stage outcome is written before proceeding to semantic audit. |
| Semantic validation | `src/content-service.js`: `AUDIT_SYSTEM` request and audit JSON handling | A valid negative audit is contextual failure; malformed or unavailable audit is unknown/technical, never pass. |
| Attempt/outcome persistence | `src/generation-attempts.js`; migration 014 | Authoritative main-DB attempt ledger, stable operation key, unique slot ordinal, state transitions and reconciliation. |
| Optional findings | `src/learning-capture.js`, `src/learning.js`, migrations 011–012 | Detached single-operation capture; does not gate generation or publishing. |
| Legacy observations | `src/validation-outcomes.js`, migration 013 | Kept for compatibility/telemetry; run ordinal is not used as authoritative slot ordinal. |
| Ready payload and publish | `src/dispatcher.js`; `src/repository.js`: `savePreparedSlot`, `startPublishing` | Ready payload and existing idempotency key persist after content returns ready; unknown provider outcome remains fail-closed. |
| Reconciliation | `src/dispatcher.js`: `reconcileUnsettled` | Existing provider ID and status reconciliation; no blind publish retry introduced. |
| Shutdown | `src/cli.js`, `src/scheduler.js`, `src/db.js` | Critical dispatch is awaited; optional capture/retention stop accepting work and use bounded close. |
| Metrics | `src/generation-attempts.js`: `completenessReport`; `src/learning-metrics.js` | First pass derives from ledger ordinals after migration cutover; older claimed slots stay legacy/unverifiable. |
| Retention | `src/learning-retention.js`, migration 014 | Bounded evidence-field cleanup; backlog count and oldest age are observable. |

## Resolution classification

### P0 — resolved and verified

- Durable UUID attempt identity with slot FK, unique database-assigned ordinal, operation identity, timestamps, state, model/config reference, and telemetry expectation flag.
- Operation identity is derived from the immutable slot UUID plus the existing attempt position (`slot:gen:1`, `slot:gen:2`). Duplicate reservation retries return the prior row. The slot lock serializes concurrent reservations; unique constraints remain the final collision guard.
- Mandatory deterministic and semantic validation outcomes commit synchronously. `PASSED` requires both stages. Terminal states reject contradictory writes. Unknown and incomplete conditions remain distinct from contextual and technical failures.
- Reservation/outcome database errors prevent `ready` persistence and provider publishing. Existing ready-payload replay and provider idempotency keys are unchanged.
- Stale generation is reconciled after the existing 10-minute bound: incomplete attempts become `unknown`, slot becomes failed, and generation/publishing are not repeated.
- Ambiguous commits query by stable operation/attempt identity before retry; retry uses the same operation. Review/candidate uniqueness and transaction guards remain unchanged.
- Legacy data is not backfilled. Pre-014 claimed slots are shown separately as unverifiable.
- Optional capture shutdown no longer waits indefinitely for an optional mysql2 pool: acceptance stops, a one-second grace expires, then optional sockets are destroyed. Main operational pool and active dispatch are not force-canceled by this helper.
- Cleanup reports expired backlog counts, oldest expired age, processed rows, and duration. It reuses existing event-time and candidate-status/created indexes, remains batch-limited, and reports overdue data instead of claiming a strict deletion deadline.

### P1 — implementation and acceptance boundary

- The three-pillar reports are connected to the authenticated administrator dashboard. Definitions and small-sample/missing-data behavior are described in the implementation status report.
- The administrator rule lifecycle, conflict checks, scoped retrieval, prompt integration, attempt snapshots, and isolated shadow mode are implemented and covered by unit tests; lifecycle and analytics SQL were exercised on isolated MySQL.
- Runtime flags are independent and default off. Approval does not activate a rule. Activation, retrieval, prompt integration, and shadow routes are enforced server-side.
- Actual browser E2E ran with a local server, isolated MySQL 8.4.13, and Chrome 157.0.8103. Seven tests passed with no failures or skips in 20.3 seconds in the final concurrent run. Coverage includes admin login, Learning navigation, candidate search/filter/pagination/empty state/details, evidence-unavailable display, review decisions, lifecycle and audit, positive/negative posting-history feedback, rendered quality feedback coverage/counts, analytics detail disclosures and exact 90-day range/API echo, cross-origin CSRF, SQLi search, keyboard navigation, seven viewport widths, and automated Axe scans. Axe used WCAG 2.0/2.1/2.2 A/AA tags at 1280×900. No screenshots or traces were captured. Manual screen-reader, zoom, contrast, complete keyboard-only, focus-trap, direct-route, and back/forward checks remain open.
- The full security matrix is not complete. Tests cover anonymous/expired/admin auth, missing/invalid/foreign-origin CSRF before storage, malformed and oversized input, SQLi-shaped search, candidate stored-XSS rendering, selected secret/error redaction, lifecycle transaction/concurrency cases, deterministic prompt rules, and shadow-start rate limiting. A non-admin/tenant role fixture does not exist in the admin-only single-tenant model; cross-role and horizontal IDOR evidence is therefore not established. Exhaustive secret exposure, all field output variants, and model/provider adversarial prompt injection remain open. The shadow rate limit is process-local.
- Actual MySQL restart during a committed `validating` attempt and real stalled `SELECT SLEEP(30)` cancellation during optional-pool shutdown are verified. Before-commit connection destruction and controlled lost-ack recovery after a real commit are verified. A packet-level connection failure during the MySQL `COMMIT` response was not injected.
- Define an operator-owned backup expiration period and assess its relationship to evidence deletion. No backup implementation is added. Admin feedback/explanations and audit records currently have no app-enforced expiry; the existing policy preserves audit relationships.

### P2 — useful follow-up

- Measure production-like latency, write load, index growth, storage, and scheduler overhead before any activation scale-up. No production benchmark was run.
- Improve historical before/after evaluation and dashboard interpretation after the source population is integrated. Do not infer causal effectiveness from association alone.
- Optimize cleanup cadence/batch size only from measured backlog and DB load. Cleanup currently has a hard maximum of two batches per invocation and is isolated from publishing.

## Recovery and outcome semantics

Lifecycle state machine:

```text
reserved → generating → validating → passed
                                  ↘ contextual_failed
                                  ↘ technical_failed
                                  ↘ unknown
```

`validating` can be written more than once to persist deterministic stage result followed by semantic stage result. The store allows only the explicit transitions in `src/generation-attempts.js`; terminal outcomes are immutable. A process that dies after reservation leaves a durable row. If the slot remains generating beyond ten minutes, recovery marks unfinished attempts unknown and fails the slot. The same slot is not regenerated. This policy sacrifices a slot after an ambiguous generation interruption rather than risk duplicate or untracked execution.

A generated caption is not publishable until `passed` commits. If that commit acknowledgment is lost, the store re-reads the authoritative attempt row. If persistence cannot be resolved, the dispatcher does not store the slot as ready and does not call the publisher. The existing provider unknown outcome path remains separate and unchanged.

## Metric population and limitations

`compliance-v3` uses `generation_slot_claims`, inserted atomically with the first pending-to-generating claim. This remains stable if a ready legacy slot's mutable claim timestamp is refreshed. The first row by durable ordinal is the actual first attempt. Its population output includes eligible claimed slots, evaluated first attempts, first-pass successes, contextual failures, technical exclusions, unknown outcomes, incomplete attempts, missing attempts, and pre-cutover legacy records split into partially reconstructable or unverifiable. The primary denominator is eligible claimed first attempts minus technical exclusions; unknown, incomplete, missing, contextual, and successful records remain in that disclosed population. Unknown, incomplete, or missing outcomes make the report incomplete, while truncation withholds the rate. No historical outcome was fabricated.

The v2-to-v3 change repairs a verified denominator inconsistency: v2 calculated successes divided by successes plus contextual failures while the UI showed eligible first attempts. Technical exclusions now have an explicit subtraction from the population, while unresolved attempts remain represented instead of silently disappearing. The implementation, population report, UI disclosure, and mixed-outcome unit/MySQL cases use v3 consistently. Historical metric contract v1 remains unchanged.

Capture completeness compares attempts explicitly marked `learning_capture_expected` at reservation against optional validation observations. It does not treat missing candidates as missing outcomes. Candidate-event completeness remains unavailable because candidate events exist only for certain findings and may be dropped while optional capture is disabled or busy.

On the isolated MySQL fixture, an empty report returned unavailable/null rate. Adding and completing one authoritative passing first attempt changed the report to 1 eligible, 1 evaluated, 1 pass, 0 contextual failures, no missing/unknown records, and rate 1.0/complete. This demonstrates query behavior only; it is not a production performance or quality result.

## Migration, security, and retention notes

- Migration 014 creates the generation-population marker and attempt table with `CREATE TABLE IF NOT EXISTS`, so retry after partial DDL is safe. It preserves existing slots, candidates, review rows, and observations. Retention queries reuse existing event-time and candidate-status/created indexes.
- Fresh installation through 014 and upgrade from 011 records were tested on isolated MySQL 8.4.13. Migration failures remain forward-repair territory because MySQL DDL may commit implicitly.
- Administrator-provided text has server size checks and sanitizer checks, and UI insertion uses text nodes. Approval creates only inactive rules. Activation endpoints exist but are gated by server-side flags that default off; live prompt insertion additionally requires retrieval and prompt-integration flags, also default off. No production activation occurred.
- Unsafe caption evidence remains withheld. Retention does not delete candidates, rules, reviews, slots, or backups. The configured evidence age is not a maximum age while backlog persists; oldest backlog age makes that visible.
- The repository has no backup scheduler or backup-retention configuration. Existing backups may contain already-deleted evidence until external backup expiry.

## Fault-test classification

| Scenario | Evidence | Classification |
| --- | --- | --- |
| Concurrent reservation and duplicate operation | MySQL integration test asserts same attempt ID and unique ordinal | Real concurrent MySQL test |
| Worker interruption after reservation | Child Node process is SIGKILLed after reservation is committed; parent observes row and reconciles it unknown | Real process-kill test |
| Connection loss before commit | Existing MySQL failure suite destroys the transaction connection before commit and verifies rollback | Real connection destruction |
| Commit succeeds, response is lost | Proxy waits for real commit, then throws `ECONNRESET`; store reads row and returns it | Controlled simulation on real MySQL, not physical network loss during commit |
| Duplicate client retry after ambiguous reserve | Same operation is replayed after simulated lost acknowledgment; existing ID is returned | Real MySQL state with simulated acknowledgment fault |
| InnoDB deadlock / lock wait timeout | Existing failure-injection suite | Real MySQL engine failures |
| Main pool vs saturated optional pool | Separate one-connection capture pool is saturated while main-pool query completes | Real MySQL pool isolation |
| MySQL restart mid-validation | A worker held a committed attempt in `validating`; the disposable MySQL container was restarted, then the worker reconnected and committed `passed` | Real database restart and worker recovery |
| Stalled real query during shutdown | The MySQL shutdown integration test ran `SELECT SLEEP(30)` and observed cancellation with `PROTOCOL_CONNECTION_LOST` after the optional-pool grace | Real MySQL query cancellation |
| Cleanup interruption and retry | Injected an update failure in the cleanup operation, confirmed evidence remained intact, then reran bounded cleanup batches to drain the backlog | Controlled interruption plus real MySQL cleanup/retry; no process restart simulated |
| Network failure during `COMMIT` | Not injected at the packet/transport layer; same-operation lost-ack recovery is tested with a wrapper that performs a real commit then throws, and pre-commit connection destruction is tested separately | Controlled lost-ack simulation; physical commit-window fault remains open before activation |

## Readiness

- **P0 → isolated P1 development: CONDITIONAL GO (prior decision).** The core lifecycle invariants are implemented and MySQL-verified. Browser/security and packet-level commit-window conditions remain open as described above.
- **P1 implementation completeness: COMPLETE** for the implemented lifecycle, retrieval/prompt, snapshot, shadow, and analytics functionality; this does not imply acceptance.
- **P1 acceptance: NO-GO.** Browser E2E passed for its documented workflows, but full security and manual accessibility evidence is still missing under the merged master gate.
- **Production activation: NO-GO.** All learning execution flags default off. No lesson injection, production shadow run, production deployment, or live Threads publishing occurred.
