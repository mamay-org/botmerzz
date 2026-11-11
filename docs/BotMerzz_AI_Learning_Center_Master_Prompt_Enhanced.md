# MASTER IMPLEMENTATION PROMPT
## BotMerzz AI Learning Center — Human-in-the-Loop Learning, Content Quality Feedback, Three-Pillar Performance Measurement & Continuous Improvement

**Enhanced master prompt (additional implementation safeguards integrated):** reviewer scoring rubric, lifecycle state machine, rule selection and prompt budgets, safe degraded mode, attribution integrity, lesson health, shadow rollout, observability, and cost control.

### ROLE AND OBJECTIVE

Act as a senior software engineer, AI systems architect, database engineer, security reviewer, and quality assurance engineer working on the existing **BotMerzz** application.

Your task is to design, implement, integrate, and verify a new **AI Learning Center** that improves AI-generated Threads content through explicitly administrator-approved feedback.

The system must support three complementary capabilities:

1. **Contextual Failure Learning:** Learn from content validation failures, but only after administrator approval.
2. **Human Content Quality Feedback:** Allow administrators to identify both desirable and undesirable writing characteristics, including in successfully published captions.
3. **Learning Effectiveness Evaluation:** Measure whether approved lessons are associated with meaningful improvements in future content.

The dashboard must also provide three independent performance indicators:

- **Content Compliance**
- **Content Quality**
- **Learning Effectiveness**

These indicators must remain separate and independently interpretable.

**Core invariant: No historical failure, human feedback, AI-generated suggestion, or inferred lesson may influence future content generation until an authorized administrator explicitly approves the corresponding learning rule.**

Use **Human-in-the-Loop (HITL) Learning**, not unrestricted autonomous learning.

Do not introduce fine-tuning, unnecessary vector databases, autonomous prompt rewriting, or an independent AI agent framework.

Preserve all existing BotMerzz functionality and operational safety guarantees.

### IMPLEMENTATION PRIORITIES

1. Correctness and data integrity.
2. Explicit human approval.
3. Security and content safety.
4. Backward compatibility.
5. Publishing reliability.
6. Measurable content improvement.
7. Maintainable architecture.
8. User experience and accessibility.

### PROJECT CONTEXT

BotMerzz is a Node.js and MySQL application that generates and publishes Threads content for Kedai Merzz.

Its existing components may include:

- OpenRouter-powered AI Content Generator.
- Semantic Auditor.
- Deterministic content validators.
- AI Content Guidelines.
- Brand Content Direction.
- Verified product facts and service whitelist.
- Topic rotation.
- Content history.
- Generation retry mechanisms.
- Scheduler and dispatcher.
- Tebar API publishing integration.
- Publishing reconciliation and idempotency.
- Dynamic AI model configuration.
- Configuration versioning.
- Administration dashboard.
- Docker-based infrastructure.

Verify all implementation details against the actual repository before making assumptions.

**Language requirements:**

- Application UI: Bahasa Indonesia.
- Threads content: natural Bahasa Melayu Malaysia.
- Code and technical documentation: English, following repository conventions.

---

## ADDITIONAL DELIVERY CONTRACT — MANDATORY

- Treat the existing repository, verified runtime behavior, migrations, and tests as the source of truth; this specification defines desired behavior, not assumed file paths or existing APIs.
- Preserve current publishing and scheduler contracts. Feature work must not silently change business rules, automation OFF/ON behavior, account routing, or the definition of a successful publish.
- Prefer incremental, additive, reversible changes; avoid inventing a parallel content-generation pipeline or a second source of truth for configuration.
- Distinguish **implemented and verified**, **implemented but not verified**, **deferred**, and **blocked** in the final report. Do not claim an acceptance criterion passed without evidence.
- If a proposed enhancement conflicts with an established safety invariant, retain the safer invariant and document the conflict rather than silently rewriting the existing system.

---

# PHASE 1 — EXISTING ARCHITECTURE AUDIT

Before changing code, inspect the repository thoroughly.

Identify:

1. Content generation pipeline.
2. Deterministic validation pipeline.
3. Semantic Auditor integration.
4. Retry behavior.
5. Content guidelines and brand rules.
6. Product facts and whitelists.
7. Topic rotation.
8. Content history and operational history.
9. Scheduler and publishing dispatcher.
10. Slot lifecycle.
11. Tebar integration.
12. OpenRouter configuration and model switching.
13. Configuration snapshots.
14. MySQL schema.
15. Authentication and administrator authorization.
16. Dashboard routing and component architecture.
17. Existing analytics.
18. Existing test infrastructure.

Map the current execution flow:

`Scheduler → Generation → Deterministic Validation → Semantic Audit → Publishing → History`

Identify the safest integration points for:

- Capturing content failures.
- Recording administrator feedback.
- Creating learning candidates.
- Reviewing and approving lessons.
- Retrieving approved lessons.
- Recording learning attribution.
- Measuring compliance, quality, and effectiveness.

Reuse existing components wherever practical.

Do not duplicate existing services, database structures, or business logic.

Preserve the repository's operational invariants.

Proceed with implementation after the audit rather than stopping with an analysis report.

---

# PHASE 2 — FAILURE CLASSIFICATION

Separate contextual content failures from technical failures.

## 2.1 Contextual Content Failures

Eligible examples:

- Unsupported claims.
- Unsupported guarantees.
- Incorrect product information.
- Brand guideline violations.
- Inappropriate tone.
- Unnatural Malaysian language.
- Repetitive hooks.
- Excessive similarity.
- Irrelevant topics.
- Product or service misrepresentation.
- Inconsistent contextual assertions.

Sources may include:

- Deterministic validators.
- Semantic Auditor.
- Existing verified content-quality checks.

Eligible contextual failures must be recorded as **pending review candidates**.

They must not become active lessons automatically.

## 2.2 Technical Failures

Examples:

- OpenRouter timeout.
- Model unavailable.
- API rate limit.
- Tebar API error.
- Network error.
- Database error.
- Provider authentication error.
- Webhook failure.
- Unknown publishing outcome.

Keep these in operational logs and existing history.

Technical failures must never automatically generate content-learning rules.

## 2.3 Ambiguous Failures

If classification is uncertain:

- Preserve the original event.
- Mark the classification as unresolved.
- Do not infer unsupported causes.
- Do not activate a lesson.
- Allow investigation where appropriate.

## 2.4 Classification Integrity

Maintain references to:

- Posting slot.
- Generation attempt.
- Validation stage.
- Failure category.
- Source.
- Supporting evidence.

Do not count multiple generation retries as independent failed publishing slots.

## 2.5 Failure Taxonomy and Cardinality

- Define stable, machine-readable contextual failure codes separate from localized display labels and raw model explanations.
- Preserve the difference between **generation attempt**, **validation result**, **publishing slot**, and **published caption** in all APIs, storage, and metrics.
- An attempt may contain multiple validation findings; deduplicate repeated delivery of the same finding while retaining all distinct reasons.
- Treat warnings as distinct from blocking violations; do not silently convert a warning into a rejection or vice versa.
- Unknown or incomplete evaluation outcomes must not be counted as validation passes.
- The same content issue detected by deterministic and semantic checks should preserve both evidence sources without inflating the number of failed attempts.

---

# PHASE 3 — ADMINISTRATOR QUALITY FEEDBACK

Add the ability for authorized administrators to evaluate generated or published captions.

This must include captions that passed validation.

**Passing validation is not equivalent to producing high-quality content.**

Support:

- Positive feedback.
- Negative feedback.
- Structured quality ratings.
- Optional written explanations.

Suggested evaluation dimensions:

1. Hook strength.
2. Creativity.
3. Bahasa Melayu Malaysia naturalness.
4. Audience relevance.
5. Brand voice consistency.
6. Narrative clarity.
7. Content diversity.
8. Call-to-action appropriateness.

Do not require every dimension to be rated for every feedback submission unless technically justified.

Use explicit handling for missing ratings.

Do not interpret missing feedback as positive feedback.

## 3.1 Positive Feedback

Examples:

- Strong conversational hook.
- Natural Malaysian gaming vocabulary.
- Engaging storytelling.
- Creative topic angle.
- Clear brand positioning.

Positive feedback may generate a learning proposal describing effective writing characteristics.

However, it must not cause excessive repetition of the same style.

## 3.2 Negative Feedback

Examples:

- Generic opening.
- Repetitive writing.
- Excessively formal tone.
- Weak storytelling.
- Unnatural expressions.
- Overly aggressive selling.
- Poor audience relevance.

Negative feedback may generate a proposed lesson describing an actionable improvement.

## 3.3 Feedback Isolation

Saving positive or negative feedback must not modify active learning memory.

Feedback becomes eligible for learning only after conversion into a proposed rule and subsequent administrator approval.

## 3.4 Quality Rating Rubric and Reviewer Consistency

- If no compatible rubric exists, use a documented **1–5 scale** for each quality dimension, with meaningful anchors: **1 = poor, 3 = acceptable, 5 = excellent** and an explicit **Not rated / Not applicable** option.
- Provide brief dimension-specific descriptions, especially for natural Malaysian language, creative hooks, and appropriate calls to action. Do not reward empty hype or unsupported promises.
- Store ratings in a structured form with the caption/version, reviewer, rating timestamp, and rubric version. Never backfill missing scores with defaults.
- Define whether editing feedback creates a new version or a new record; maintain traceability and avoid counting repeated edits as independent reviews.
- If multiple reviewers rate the same caption, preserve individual ratings and show disagreement when meaningful instead of silently overwriting them.
- Distinguish feedback about **writing quality** from reports of **factual or safety violations**; a high writing score cannot override a failed validator.
- Provide a quick-review workflow, but never require administrators to invent a justification for every ordinary positive rating.

---

# PHASE 4 — STRUCTURED DATA CAPTURE

Inspect the current database before introducing new tables.

Persist or reference sufficient information for traceability.

## Contextual Failure Records

Include:

- Unique failure ID.
- Related slot ID.
- Generation attempt ID.
- Caption version.
- Failure stage.
- Failure category.
- Validation explanation.
- Evidence.
- Product/content scope.
- Model ID.
- Configuration version.
- Timestamp.
- Review status.

## Human Feedback Records

Include:

- Feedback ID.
- Caption or generation reference.
- Reviewer ID.
- Positive/negative feedback type.
- Quality dimensions.
- Optional explanation.
- Timestamp.
- Review or learning-conversion status.

## Learning Records

Include:

- Learning rule ID.
- Source reference.
- Category.
- Scope.
- Approved instruction.
- Approval identity.
- Approval timestamp.
- Activation status.
- Version.
- Revision history.

## Data Integrity

Ensure correct behavior under:

- Application restart.
- Database restart.
- Worker crash.
- Duplicate event delivery.
- Concurrent administrator actions.
- Partial database failure.
- Repeated API requests.

Use database transactions, constraints, and idempotency mechanisms where appropriate.

Do not store provider secrets or unnecessary sensitive information.

## Data Retention, Evidence Hygiene and Query Design

- Reuse existing identifiers and history references where possible; avoid unnecessary copies of full captions, provider responses, or payloads.
- Define foreign keys, unique constraints, indexes, and cascade behavior for attempts, feedback, candidates, rules, versions, and rule application records.
- Preserve required evidence during normal deactivation while supporting an explicit, documented archival/retention policy for nonessential data.
- Redact credentials, private tokens, and unnecessary personal data from stored evidence, UI responses, analytics exports, and debugging logs.
- Design pagination and time-window queries to remain bounded as history grows; prevent large full-table scans on every dashboard load.
- For concurrent reviewer edits and approvals, use transactions and optimistic version checks or equivalent locking to avoid lost updates.

---

# PHASE 5 — AI LEARNING CENTER DASHBOARD

Create a dedicated administrator-only sidebar tab:

**AI Learning**

Maintain the existing design system:

- Navy blue sidebar.
- Off-white page background.
- White cards.
- Dark navy text.
- Subtle blue-gray borders.
- Yellow accents.
- Minimal shadows.

Use Bahasa Indonesia for all UI copy.

Implement four sections.

## 5.1 Menunggu Review

Display:

- Contextual failure candidates.
- Quality feedback candidates.
- Source.
- Original caption.
- Category.
- Explanation.
- Timestamp.
- Product scope.
- Similar occurrences.
- Review status.

Provide filtering, searching, sorting, and pagination as appropriate.

## 5.2 Pembelajaran Aktif

Display:

- Approved lesson text.
- Category.
- Scope.
- Source references.
- Approval date.
- Rule version.
- Activation status.
- Effectiveness summary.

Allow revision and deactivation.

## 5.3 Riwayat Review

Display historical decisions:

- Approved.
- Rejected.
- False positive.
- Disabled.
- Revised.
- Superseded.

Include reviewer identity, timestamp, and decision reason.

## 5.4 Efektivitas Pembelajaran

Display learning evaluations and historical trends.

This section must include the **Three-Pillar Performance Dashboard** defined in Phase 12.

---

# PHASE 6 — LEARNING CANDIDATE GENERATION

Convert eligible contextual failures or administrator feedback into proposed learning rules.

Examples:

**Contextual failure**

Original caption:

"Confirm akaun ML ini 100% selamat dan takkan kena tarik balik."

Finding:

"Unsupported account safety guarantee."

Proposed lesson:

"For Mobile Legends account content, avoid unsupported ownership or safety guarantees. Use only verified product facts."

**Negative feedback**

Finding:

"Captions repeatedly begin with generic sales invitations."

Proposed lesson:

"Vary opening structures through questions, gamer observations, short stories, and relevant gaming situations."

**Positive feedback**

Finding:

"Conversational storytelling receives favorable administrator evaluations."

Proposed lesson:

"When appropriate, use conversational storytelling to introduce products naturally without forcing every caption into the same structure."

Every proposal must contain:

- Suggested instruction.
- Category.
- Scope.
- Supporting rationale.
- Source references.

Allow administrators to edit the proposed instruction.

AI-generated suggestions are untrusted proposals, not verified rules.

A failure to generate a suggestion must not delete the underlying review candidate.

Use bounded prompts, timeouts, and appropriate cost limits.

## 6.1 Proposal Quality Contract

Each candidate should be concise and human-reviewable, with:

- **Problem or positive pattern:** what was observed, without exaggerating certainty.
- **Actionable instruction:** clear behavior the generator should adopt or avoid.
- **Scope:** global, category, product/service, or topic as supported by the current data model.
- **Evidence quality:** linked attempts, feedback, and whether the observation is a verified violation or a subjective preference.
- **Potential overgeneralization risk:** how the proposed rule might harm creativity or relevance if applied too broadly.
- **Optional examples:** only when safe and clearly labeled; never copy unsupported claims as authoritative guidance.

Avoid rules like "always make every caption funny" or "guarantee customer safety." Prefer bounded instructions describing when a style is appropriate.

A model-produced confidence label is not evidence of factual correctness. No proposal may automatically override existing brand or fact validation. Suggestion generation must be bounded and idempotent; duplicate background requests must not produce duplicate active rules.

---

# PHASE 7 — HUMAN APPROVAL WORKFLOW

Use an explicit, auditable approval process.

Conceptual states:

`PENDING → APPROVED / REJECTED / FALSE_POSITIVE`

Separate review decisions from activation status.

## Approve

The administrator must be able to:

1. Inspect the caption.
2. Inspect the evidence.
3. Review the explanation.
4. Edit the proposed instruction.
5. Select a scope.
6. Explicitly approve the lesson.

Before activation, validate:

- Authorization.
- Required fields.
- Scope.
- Duplicate rules.
- Conflicting instructions.
- Concurrent modifications.
- Database integrity.
- Audit logging.

Do not report success until the transaction commits.

## Reject

Rejected candidates must remain historically traceable.

They must not influence future generation.

## False Positive

Allow administrators to mark incorrect validator or auditor findings as false positives.

Preserve those cases for validator evaluation.

Do not automatically change validation rules.

## Critical Approval Invariant

Pending, rejected, false-positive, disabled, and superseded candidates must never enter the generation prompt as active learning guidance.

Enforce this server-side.

## 7.1 Explicit Rule State Machine

Represent **review disposition** and **activation state** separately. Define legal transitions, valid actors, and required audit information for each transition.

- A candidate can be approved without immediately being activated.
- Activation is permitted only for an approved rule version and requires an explicit authorized action. Approval and activation may occur in one transaction **only when the administrator explicitly selected that combined action**.
- Revision creates a new immutable version. Decide and document whether it requires a fresh approval; default to fresh approval for material instruction or scope changes.
- Only one intended active version per logical lesson and applicable scope may be selected according to a documented policy.
- A rejected or false-positive candidate cannot be activated through a separate endpoint or race condition.
- Concurrent reviewers must not both activate conflicting versions; return a clear conflict response and refresh the visible state.
- Audit entries must include actor, action, entity version, timestamp, and a short decision reason where the action materially changes learning behavior.

Do not confuse **approved**, **active**, **evaluated**, and **effective** in API fields or dashboard labels.

---

# PHASE 8 — APPROVED LEARNING MEMORY

Use the existing MySQL infrastructure.

Avoid external memory databases unless demonstrably required.

Approved rules must support:

- Versioning.
- Scope.
- Activation/deactivation.
- Audit history.
- Source references.
- Safe rollback.

A rule is eligible for retrieval only when:

1. It has valid administrator approval.
2. Its activation state is active.
3. Its scope matches the generation context.
4. Its version is applicable.
5. It does not conflict with higher-priority instructions.

Do not retrieve raw failure records as learning instructions.

Do not retrieve unapproved human feedback as guidance.

---

# PHASE 9 — GENERATOR INTEGRATION

Integrate approved lessons into new generation requests.

Preserve this instruction hierarchy:

1. System safety guardrails.
2. Verified product facts and hard business constraints.
3. Administrator AI Content Guidelines.
4. Approved Learning Memory.
5. Generation-specific context.

Learning memory must never override verified facts or safety rules.

## Scoped Retrieval

Select relevant rules based on:

- Content category.
- Product or service.
- Topic.
- Global or specific scope.
- Active status.
- Applicable version.

Keep retrieval bounded.

Avoid unbounded prompt growth.

Use deterministic filtering first.

Do not introduce embeddings or vector search without a demonstrated need.

## Preserve Creativity

Positive lessons should encourage useful patterns, not mandate identical wording.

Negative lessons should reduce recurring problems, not create excessive restrictions.

Maintain variation in:

- Hooks.
- Topic angles.
- Narrative structures.
- Tone.
- Calls to action.
- Gamer terminology.

## 9.1 Deterministic Rule Selection and Prompt Budget

- Retrieve approved active rules with one centralized server-side selector; never let the frontend construct privileged generator instructions.
- Define deterministic scope precedence and a stable tie-breaker so identical generation context plus identical configuration yields the same selected rule set.
- Prefer relevant, specific rules over unrelated generic rules; do not apply product-specific rules to unrelated services.
- Apply a configurable maximum number of rules and maximum instruction-token budget determined from the existing generator's measured prompt constraints.
- Deduplicate overlapping rules and enforce conflict resolution before prompt assembly. If a conflict cannot be resolved safely, omit the conflicting learning rules and surface an actionable alert; never drop higher-priority safety rules.
- Log **which approved rule versions were actually injected**, not merely which rules were retrieved, and capture omission reasons such as budget, scope, or conflict.
- Preserve positive learning as style guidance rather than as verbatim reusable captions; do not encourage near-duplicate hooks or copy-paste output.

## 9.2 Safe Degraded Operation

- Learning is an enhancement, not a prerequisite for publishing. If optional learning retrieval fails, do not block the existing generator or change the schedule solely because of the Learning Center.
- Fall back to the established guidelines and all existing required validators; never fail open on mandatory content safety checks.
- Record the learning subsystem failure in operational monitoring and do not falsely mark a rule as applied.
- Ensure learning-related AI requests, analytics calculations, and database writes cannot hold publishing-critical locks or cause unbounded delay.

---

# PHASE 10 — SEMANTIC AUDITOR INDEPENDENCE

Keep the Semantic Auditor independent.

Approved lessons must never be treated as proof of content correctness.

The auditor must continue to validate:

- Factual claims.
- Product constraints.
- Brand compliance.
- Unsupported guarantees.
- Content relevance.
- Existing safety requirements.

Do not reduce validation strictness to improve approval statistics.

Keep auditor false-positive evaluation separate from generator learning.

---

# PHASE 11 — VERSIONING AND EXECUTION SNAPSHOTS

Preserve existing immutable execution context.

At generation start, associate the execution with:

- Model ID.
- Configuration version.
- Guidelines version, if applicable.
- Relevant product facts snapshot.
- Applied learning rule IDs.
- Applied learning rule versions.

When learning rules change:

- Future generations may use the new state.
- In-flight generations preserve their existing snapshots.
- Existing ready slots remain unchanged.
- Publishing payloads remain unchanged.
- Idempotency keys remain unchanged.
- Tebar reconciliation behavior remains unchanged.

Do not silently modify already-generated or published content.

---

# PHASE 12 — THREE-PILLAR PERFORMANCE DASHBOARD

**This phase is mandatory, not an optional analytics enhancement.**

Implement three clearly separated performance indicators inside the AI Learning Center:

1. **Content Compliance**
2. **Content Quality**
3. **Learning Effectiveness**

These represent different dimensions of performance.

**Do not merge them into a single opaque AI Success Score.**

Each indicator must have:

- An explicit definition.
- A reliable data source.
- A clear denominator when expressed as a rate.
- A time range.
- A sample size.
- Appropriate missing-data handling.
- A documented interpretation.
- Automated tests validating its calculation.

## 12.1 Pillar A — Content Compliance

### Objective

Measure how consistently the AI Content Generator satisfies required validation and content safety constraints.

### Primary Metric: First-Pass Content Approval Rate

Formula:

`First-Pass Approval Rate = Eligible first generation attempts passing all required validation / Total eligible first generation attempts × 100`

The denominator must include eligible first attempts that failed contextual validation.

Exclude technical failures that prevented meaningful content evaluation; disclose exclusions.

### Supporting Metrics

- Deterministic validation pass rate.
- Semantic Auditor pass rate.
- Contextual failure rate.
- Unsupported claim frequency.
- Brand guideline violation frequency.
- Repetitive-content rejection frequency.

Use consistent event definitions.

Do not double-count the same attempt in mutually exclusive primary outcome categories.

### Dashboard Example

**Content Compliance**

- First-Pass Approval: 84%.
- Contextual Rejection: 16%.
- Most Common Finding: Repetitive Hook.

These numbers are illustrative only.

Do not hardcode them.

### Important Interpretation

Content Compliance measures whether content meets required rules.

It does **not** establish that the content is creative, engaging, or commercially effective.

---

## 12.2 Pillar B — Content Quality

### Objective

Measure perceived caption quality through structured human evaluation.

### Evaluation Dimensions

Include:

1. Hook strength.
2. Creativity.
3. Malaysian language naturalness.
4. Audience relevance.
5. Brand voice.
6. Narrative clarity.
7. Content diversity.
8. CTA appropriateness.

Use dimensions already represented by existing feedback, or introduce the smallest necessary structured schema.

### Primary Metrics

Where data supports them:

- Positive feedback proportion among reviewed captions.
- Negative feedback proportion among reviewed captions.
- Mean rating per dimension.
- Feedback coverage rate.
- Quality trend across evaluation periods.

Clearly disclose how feedback is collected.

### Data Rules

- Unrated content must not be treated as positive.
- Different dimensions must not be silently combined.
- Review coverage must be shown.
- Small samples must be identified.
- Admin ratings must not override factual validators.
- Subjective feedback must remain distinguishable from objectively verified violations.

### Dashboard Example

**Content Quality**

- Reviewed Captions: 40.
- Feedback Coverage: 32%.
- Average Hook Rating: 4.2/5.
- Average Language Naturalness: 4.5/5.
- Most Common Criticism: Generic Opening.

Illustrative only; actual values must come from stored feedback.

### Important Interpretation

A caption can be:

- Compliant but low quality.
- High quality in style but factually invalid.
- Both compliant and high quality.
- Neither.

Display these outcomes honestly.

Do not infer Threads engagement or conversion performance from human ratings alone.

## Quality Data Sampling and Interpretation

- Clearly distinguish **captions eligible for review**, **unique captions reviewed**, **total feedback submissions**, and **reviewer ratings by dimension**.
- Compute coverage over the stated eligible population, not over only already-reviewed captions.
- Make bias visible: feedback from unusually good or bad posts, a single reviewer, or a selected content category does not represent the full population.
- Where feasible, offer a lightweight, reproducible random-review queue or stratified sampling by topic/category to improve coverage without obligating the admin to review every caption.
- Random review selection must not alter publishing. If sampling is implemented, record its selection method and time window.
- Do not use AI self-scoring as a substitute for human quality ratings. If any automated quality estimate is shown later, label and report it separately.

---

## 12.3 Pillar C — Learning Effectiveness

### Objective

Evaluate whether administrator-approved lessons are associated with improvements in future generation outcomes.

### Required Attribution

Each evaluated generation must retain references to applied:

- Learning rule IDs.
- Learning rule versions.
- Model ID.
- Configuration version.
- Relevant content category.
- Evaluation timestamp.

### Primary Measures

For a learning rule, where sufficient observations exist:

- Number of evaluated generations using the lesson.
- Relevant contextual failure rate before activation.
- Relevant failure rate after activation.
- Change in failure frequency.
- Relevant quality ratings before/after.
- Evaluation sample sizes.

### Evaluation Integrity

Do not claim causal improvement from a simple before/after comparison.

Changes in:

- AI model.
- Prompt configuration.
- Brand guidelines.
- Product facts.
- Content category distribution.
- Validator behavior.

may also affect outcomes.

Where feasible, compare equivalent conditions or use controlled offline evaluations.

### Dashboard States

Support clear states such as:

- **Belum cukup data**
- **Sedang dievaluasi**
- **Indikasi membaik**
- **Tidak ada perubahan yang jelas**
- **Indikasi memburuk**

These must be driven by documented evaluation criteria, not arbitrary model-generated judgments.

For MVP, avoid claiming statistical certainty when sample sizes or experimental controls are insufficient.

### Example

**Learning Effectiveness**

Lesson: Reduce Repetitive Hooks.

- Generations Using Lesson: 60.
- Baseline Repetition Rate: 24%.
- Observed Rate: 10%.
- Change: -14 percentage points.
- Evaluation Status: Indication of Improvement.

These numbers are illustrative only.

Do not automatically state that the lesson caused the reduction.

## Attribution and Baseline Integrity

- Attribute outcomes to the **exact applied lesson version** and distinguish candidate eligibility from actual prompt inclusion.
- Define baseline windows, observation windows, category filters, and outcome eligibility before computing comparisons; store these definitions with the evaluation.
- Avoid comparing different models, major guideline revisions, product-fact states, or validator configurations as if conditions were identical.
- If multiple lessons were used together, show co-applied rules and avoid attributing the entire improvement to one lesson.
- Prevent denominator inflation from retries, duplicate reports, or already-published content counted more than once.
- Track changes in failure-category frequency as well as overall approval rate so a rule cannot appear effective by merely shifting errors to another category.
- Make thresholds for **Indikasi membaik**, **Tidak ada perubahan yang jelas**, and **Indikasi memburuk** explicit, configurable or documented, and testable; fall back to **Belum cukup data** if evidence is too weak.
- A decrease in contextual rejection can coexist with worse creativity. Keep all three pillars visible, even if their directions disagree.

### Important Interpretation

Learning Effectiveness measures the observed value of applied lessons.

It must not be inferred simply from the number of approved rules.

---

# PHASE 13 — METRIC PRESENTATION AND ANALYTICS UX

Present the three pillars as clearly separated dashboard sections or cards.

Suggested structure:

**AI Learning Overview**

| Indicator | Primary Display | Supporting Information |
|---|---|---|
| Content Compliance | First-pass approval rate | Rejection categories and trends |
| Content Quality | Human evaluation summary | Ratings, feedback coverage, and trends |
| Learning Effectiveness | Observed lesson impact | Sample size, version, and evaluation status |

Use visual hierarchy consistent with the existing light theme.

Provide:

- Time-range filters.
- Trend indicators.
- Contextual tooltips.
- Clearly defined metric labels.
- Drill-down to supporting records.
- Insufficient-data states.
- Loading and error states.

Do not use green status indicators merely because a percentage has increased.

Interpret improvement based on the direction and meaning of each metric.

For example:

- A higher first-pass approval rate may be beneficial.
- A lower contextual rejection rate may be beneficial.
- A higher human quality rating may be beneficial.
- An increasing number of approved lessons is not necessarily beneficial.

Avoid unnecessary complex charting libraries if the existing stack can present the information adequately.

---

# PHASE 14 — LEARNING EFFECTIVENESS REVIEW WORKFLOW

Add a workflow that helps administrators evaluate active lessons.

Administrators should be able to:

1. Open an active learning rule.
2. View related source failures or feedback.
3. Inspect the number of generations that used it.
4. Review relevant evaluation metrics.
5. Compare supported baseline and observation periods.
6. View quality feedback trends.
7. Decide whether to retain, revise, or disable the rule.

Do not automatically disable a rule merely because its observed effectiveness is low.

Do not automatically rewrite learning rules based on analytics.

For MVP, the system may provide recommendations, but the administrator must decide whether to change the rule.

Use a lightweight evaluation job or existing scheduling infrastructure if necessary.

Evaluation must never trigger live publishing.

---

# PHASE 15 — CONTROLLED OFFLINE EVALUATION

Where feasible, implement or prepare a controlled evaluation capability.

Compare caption generation:

- Without a selected lesson.
- With the selected lesson.

Use comparable:

- Model configuration.
- Prompt settings.
- Product facts.
- Content categories.
- Evaluation scenarios.

Measure:

- Validation results.
- Creativity.
- Hook variation.
- Language naturalness.
- Brand compliance.
- Human preference, where available.

Do not post evaluation captions to Threads.

Do not modify live schedules.

Do not change active production configuration.

If controlled evaluation cannot be safely implemented within MVP scope, document the blocker and preserve architecture hooks for future implementation.

Do not fake evaluation results.

## 15.1 Controlled Test Design

- When practical, use a paired offline evaluation set with the same content scenarios, facts, model configuration, and input constraints, comparing **rule off** versus **rule on**.
- Separate generation from evaluation: do not let the generating model's unverified self-assessment be the sole basis for a quality claim.
- If human evaluation is feasible, anonymize/shuffle paired outputs before review to reduce expectation bias; preserve stable labels for reproducibility.
- Store the evaluation set/version, rule versions, scoring rubric, sample size, and limitations.
- Clearly label offline validation gains as **offline observations**, not as guaranteed production engagement or conversion improvement.
- Enforce hard technical separation from Tebar publishing endpoints, scheduler state, and live dispatch credentials.

---

# PHASE 16 — DUPLICATE, CONFLICT AND FEEDBACK-BIAS PROTECTION

## Duplicate Detection

Identify overlapping lesson proposals.

Allow administrators to link repeated failures to an existing lesson.

Do not automatically create multiple identical rules.

## Conflict Detection

Validate new rules against:

- System guardrails.
- Verified product facts.
- Brand guidelines.
- Active lessons.
- Applicable scope.

Do not activate conflicting rules.

## Feedback Bias

Prevent overgeneralization from:

- One negative rating.
- One unusually successful caption.
- A small number of observations.
- Stale product facts.
- Changes in AI models.
- Changes in reviewer preferences.

Distinguish:

- Confirmed rule violations.
- Subjective human preferences.
- Hypotheses requiring evaluation.

Keep learning instructions specific, actionable, and appropriately scoped.

---

# PHASE 17 — LEARNING LIFECYCLE AND ROLLBACK

Learning rules must support:

- Activation.
- Deactivation.
- Revision.
- Immutable version history.
- Approval history.
- Rollback.

Disabling a lesson must:

- Prevent its use in future generations.
- Preserve historical evidence.
- Preserve in-flight execution snapshots.
- Preserve evaluation records.
- Avoid changing previously published content.

Do not delete historical learning data during ordinary deactivation.

Use safe, auditable state transitions.

## 17.1 Learning Rule Health and Staleness

- Allow administrators to inspect last applied timestamp, recent use count, current applicability, rule version, and evaluation status.
- Flag lessons for review when product facts, guidelines, supported products, or validator behavior have changed materially; do not silently keep an obsolete claim-related lesson active without appropriate checks.
- Detect rules that are consistently omitted for scope, conflict, or prompt-budget reasons, and explain why they are ineffective operationally.
- Prefer review reminders or visible warnings to silent automatic deletion or deactivation.
- Provide a safe pre-activation preview of eligible scope, likely conflicts, and projected prompt budget; label previews as estimates.
- A rollback must restore an explicitly selected, previously approved immutable version; never implicitly republish or alter an existing slot.

---

# PHASE 18 — SECURITY AND AUTHORIZATION

All Learning Center APIs must enforce server-side authorization.

Implement:

- Authentication.
- Admin role verification.
- CSRF protection.
- Input validation.
- Safe output encoding.
- Request size limits.
- Secure database access.
- Transactional approval.
- Concurrency protection.
- Rate limiting where appropriate.
- Audit logging.
- Safe error responses.

Treat historical captions, external messages, auditor explanations, human feedback, and AI-generated lesson suggestions as untrusted data.

Protect against prompt injection.

Do not allow historical content to redefine the generator's system instructions.

Do not expose API keys, session secrets, provider credentials, or sensitive configuration.

Approved learning rules remain lower-priority than safety guardrails and verified facts.

## 18.1 Threat Modeling for Learning Data

- Treat model outputs, stored captions, reviewer explanations, imported records, and candidate rationale as potentially malicious text, even if presented inside trusted UI.
- Keep evidence fields and quoted captions as **data**, not executable or high-priority prompt instructions. Build the generator prompt from validated structured rule fields only.
- Prevent unauthorized scope escalation through crafted API payloads, version IDs, role changes, or direct requests to activation endpoints.
- Escape all historical content on display; apply CSRF protection as relevant to the current authentication model.
- Test prompt-injection attempts such as "ignore brand guidelines", attempts to exfiltrate secrets, and malicious text embedded in a failed caption.
- Where content is sent to a provider for a suggestion, minimize/redact sensitive fields and preserve existing provider data-handling policies.

---

# PHASE 19 — PUBLISHING SAFETY AND NON-REGRESSION

Preserve all existing operational guarantees.

Do not modify:

- Scheduler behavior.
- Automation ON/OFF semantics.
- Tebar account-switching safety.
- Existing ready slots.
- Publishing idempotency.
- Reconciliation behavior.
- Unknown outcome handling.
- Provider credentials.
- Live publishing settings.

Learning updates must never trigger unexpected publishing.

No blind retries are permitted for unknown publishing outcomes.

Use feature flags if needed for safe rollout.

Any new learning-related background process must remain separate from publishing control.

## 19.1 Feature Flags, Shadow Mode and Safe Rollout

Implement independent controls, using the repository's current configuration approach:

1. **Capture / review:** collect contextual failures and admin feedback without changing generation.
2. **Approved-memory shadow mode:** select approved rules, record expected applicability and conflicts, but do not inject them into live prompts.
3. **Injection enabled:** apply approved active rules to future generations only after tests and explicit authorization for the rollout.

Defaults for newly deployed environments must be safe and documented. Never automatically enable prompt injection merely because a migration or dashboard release succeeded.

Shadow mode must not treat unapproved evidence as guidance and must not publish extra content. Disabling injection must restore previous generator behavior while leaving review history and analytics intact.

## 19.2 Performance and Operational Visibility

- Monitor proposal-generation errors, failure-capture errors, approval conflicts, rule-selection failures, rule omissions, and evaluation-job failures.
- Monitor incremental latency and AI/token cost from the feature, not only overall publishing success.
- Put bounded timeouts, retries, concurrency, pagination, and cost controls around optional Learning Center operations.
- Reuse existing logging and alerting infrastructure. Avoid high-cardinality or personally sensitive metric labels.
- Establish a documented plan for safe additive migrations, backup/recovery verification where applicable, and rapid feature-flag rollback.
- Never run unbounded historical backfills or provider-side evaluations in the publishing hot path.

---

# PHASE 20 — AUTOMATED TESTING

Build tests covering the following.

## A. Failure Classification

- Contextual failures become review candidates.
- Technical failures are excluded.
- Ambiguous failures remain unresolved.
- Repeated attempts preserve correct relationships.

## B. Administrator Feedback

- Positive feedback is persisted.
- Negative feedback is persisted.
- Feedback references the correct caption.
- Unauthorized feedback submission is rejected.
- Feedback does not activate lessons automatically.

## C. Approval Isolation

- Pending lessons are not retrieved.
- Rejected lessons are not retrieved.
- False positives are not retrieved.
- Disabled lessons are not retrieved.
- Superseded lessons are not retrieved.
- Approved active lessons are eligible for retrieval.

These are mandatory tests.

## D. Learning Retrieval

- Correct scope matching.
- Correct category matching.
- Correct rule versions.
- Bounded retrieval.
- No unapproved data leakage.
- No prompt injection execution.
- Higher-priority guardrails remain authoritative.

## E. Learning Lifecycle

- Approval.
- Rejection.
- Revision.
- Deactivation.
- Rollback.
- Concurrent administration.
- Transaction rollback.
- Audit history.
- Execution snapshot consistency.

## F. Three-Pillar Metrics

Test the three indicators independently.

### Content Compliance

- Correct first-pass numerator.
- Correct eligible-attempt denominator.
- Correct handling of technical failures.
- Correct handling of repeated retries.
- Correct contextual failure categorization.

### Content Quality

- Correct calculation from reviewed captions.
- Unrated captions are not positive.
- Correct feedback coverage.
- Correct dimension-specific averages.
- Correct treatment of incomplete ratings.
- Correct small-sample handling.

### Learning Effectiveness

- Correct attribution to active rule versions.
- Correct baseline windows.
- Correct observation periods.
- Correct sample sizes.
- Correct handling of concurrent model changes.
- Insufficient-data state.
- No unsupported causal claims.

## G. Publishing Safety

- No duplicate posting.
- No schedule regression.
- No changes to ready slots.
- No idempotency regression.
- No blind retries.
- No unauthorized live publishing.

## H. UI/UX

- Sidebar navigation.
- Review workflows.
- Feedback forms.
- Learning management.
- Three-pillar metrics.
- Filtering.
- Error feedback.
- Responsive behavior.
- Keyboard accessibility.

Run the existing relevant test suite.

## I. Additional Safety and Evidence Tests

- Approval without activation does not inject a lesson.
- A revised but unapproved version does not replace the prior authorized version.
- Simultaneous reviewers cannot activate conflicting rule versions.
- Generator selects the same approved rules deterministically for the same context and configuration.
- Rule count/token budget is enforced and omission reasons are auditable.
- Learning database or suggestion-provider outages do not disrupt publishing-critical behavior.
- Required validators remain authoritative during degraded operation.
- Shadow mode does not inject lessons, create posting slots, or call Tebar.
- Feedback edits do not inflate reviewed-caption coverage.
- Multiple reviewer ratings remain distinguishable and missing values remain missing.
- Changes in models/validators are flagged as evaluation confounders.
- Malicious caption text and feedback cannot become prompt instructions without approval.
- Stale or conflicting approved lessons are detectable without destructive automatic changes.

Run the existing relevant test suite.

Use mock providers and isolated databases.

Do not perform live Threads publishing.

Document the exact commands and results.

---

# PHASE 21 — IMPLEMENTATION STRATEGY

Implement incrementally:

1. Audit the existing architecture.
2. Define failure and feedback classification.
3. Design additive database changes.
4. Implement contextual failure recording.
5. Implement human quality feedback.
6. Implement learning candidate generation.
7. Implement approval APIs.
8. Implement approved learning storage.
9. Implement scoped lesson retrieval.
10. Integrate lessons into future generation.
11. Implement snapshot and version tracking.
12. Implement conflict and duplicate detection.
13. Implement learning lifecycle controls.
14. Build the AI Learning Center UI.
15. Implement Content Compliance metrics.
16. Implement Content Quality metrics.
17. Implement Learning Effectiveness metrics.
18. Implement administrator effectiveness review.
19. Implement safe offline evaluation where practical.
20. Complete security and regression testing.
21. Update technical documentation.
22. Produce the final implementation report.

23. Verify quality-rubric and reviewed-caption denominator semantics.
24. Implement deterministic rule selection with prompt-budget accounting and safe fallback.
25. Add independent capture, shadow-mode, and injection controls.
26. Add learning-rule health, evidence lineage, and operational monitoring.
27. Verify controlled offline evaluation isolation and rollout/recovery behavior.

Avoid unnecessary rewrites.

Prefer cohesive, testable changes.

If a critical invariant cannot be verified, keep the affected functionality disabled and report the blocker.

---

# PHASE 22 — NON-NEGOTIABLE CONSTRAINTS

Do not:

- Fine-tune models.
- Introduce unnecessary vector databases.
- Build an autonomous self-modifying agent.
- Automatically rewrite system prompts.
- Automatically modify administrator guidelines.
- Use technical failures as content-learning rules.
- Use pending or rejected feedback in generation prompts.
- Treat auditor findings as infallible.
- Treat subjective ratings as factual guarantees.
- Combine the three performance indicators into an opaque score.
- Fabricate quality ratings or effectiveness measurements.
- Infer causality without supporting evaluation.
- Change publishing frequency.
- Change Tebar accounts.
- Change production model settings.
- Bypass semantic validation.
- Weaken safety rules to inflate metrics.
- Perform live Threads publishing.
- Modify production credentials.
- Deploy to production without separate authorization.

- Activate learning injection in production merely because code was merged.
- Treat a rule approved for one product/category as a global instruction without explicit scope approval.
- Turn optional learning-service failures into skipped mandatory validators.
- Use automatic AI-generated quality ratings as though they were human reviewer scores.
- Claim engagement, conversion, or revenue uplift without valid external measurement data.
- Reveal secrets or private data in lesson evidence, traces, metric labels, or admin exports.

---

# PHASE 23 — ACCEPTANCE CRITERIA

Implementation is complete when:

- [ ] AI Learning Center exists as an admin-only dashboard tab.
- [ ] Contextual failures are recorded automatically.
- [ ] Technical failures are excluded from learning.
- [ ] Administrators can review original captions and findings.
- [ ] Positive quality feedback is supported.
- [ ] Negative quality feedback is supported.
- [ ] Feedback can produce reviewable learning candidates.
- [ ] No candidate becomes active without approval.
- [ ] Administrators can edit, approve, reject, and mark false positives.
- [ ] Approved lessons have scope and versioning.
- [ ] Pending, rejected, and disabled rules cannot influence generation.
- [ ] Conflict and duplicate detection work.
- [ ] Generator uses only relevant active lessons.
- [ ] Semantic Auditor remains independent.
- [ ] In-flight execution snapshots remain stable.
- [ ] Administrators can revise and disable learning rules.
- [ ] **Content Compliance** is displayed independently with valid metrics.
- [ ] **Content Quality** is displayed independently with human feedback data.
- [ ] **Learning Effectiveness** is displayed independently with meaningful evidence.
- [ ] Each metric has a clear denominator, time range, and sample size.
- [ ] Insufficient-data states are supported.
- [ ] No opaque AI Success Score is introduced.
- [ ] Learning effectiveness can be reviewed by administrators.
- [ ] No unsupported causal claims appear in analytics.
- [ ] Existing security and publishing guarantees remain intact.
- [ ] Automated tests pass.
- [ ] Browser verification is documented.
- [ ] No production deployment occurs.

- [ ] Review disposition and activation are distinct and protected by valid state transitions.
- [ ] The quality rubric, missing-value behavior, and feedback coverage denominator are documented and tested.
- [ ] Rule selection is deterministic, scoped, bounded, and auditable per generation.
- [ ] Approval/version races cannot introduce unapproved or conflicting rules.
- [ ] Learning retrieval or suggestion outages cannot bypass validators or trigger extra publishing.
- [ ] Capture-only and shadow-mode behavior are implemented or explicitly blocked with evidence.
- [ ] Evaluations expose baseline definitions, actual applied rule versions, confounders, and co-applied lessons.
- [ ] Rule health/staleness and safe rollback are available to administrators.
- [ ] Performance, token/cost overhead, and feature-flag recovery are measured or explicitly reported as unverified.

---

# PHASE 24 — FINAL IMPLEMENTATION REPORT

After implementation, provide:

1. **Architecture Overview:** how AI Learning Center integrates with BotMerzz.
2. **Existing Components Reused:** relevant existing services.
3. **Modified Files:** complete change inventory.
4. **Database Changes:** tables, indexes, constraints, migrations.
5. **Failure Classification:** contextual, technical, and unresolved events.
6. **Human Feedback Workflow:** positive and negative quality evaluation.
7. **Approval Workflow:** authorization, states, and transactions.
8. **Learning Memory:** approved rule storage and retrieval.
9. **Prompt Integration:** instruction priority and safety.
10. **Versioning:** snapshots, revisions, and rollback.
11. **Content Compliance Metrics:** formulas, data sources, and results.
12. **Content Quality Metrics:** feedback dimensions, coverage, and results.
13. **Learning Effectiveness Metrics:** attribution, evaluation windows, and limitations.
14. **Security Assessment:** findings and mitigations.
15. **Test Results:** exact commands, passed, failed, and skipped tests.
16. **Browser Verification:** actual pages and interactions tested.
17. **Operational Safety:** publishing and scheduler regression results.
18. **Known Limitations:** unfinished or unverified capabilities.
19. **Production Readiness:** GO/NO-GO with supporting evidence.

20. **Rating Rubric and Bias:** scoring anchors, review population, coverage, reviewer agreement limits, and sampling approach.
21. **Rule Selection and Budget:** selection order, scope precedence, token/rule limits, omission reasons, and degraded behavior.
22. **Lifecycle and Health:** distinct approval/activation states, stale/conflicting lessons, and version-safe rollback.
23. **Rollout and Recovery:** capture/shadow/injection flags, defaults, migration strategy, and rollback verification.
24. **Observability and Cost:** latency, token usage, extra model calls, capture errors, and operational monitoring.
25. **Evidence Matrix:** each acceptance criterion marked verified, unverified, deferred, or blocked with the exact test, log, screen, or code evidence.

Do not claim production readiness without sufficient verification.

---

# FINAL EXECUTION INSTRUCTION

**Begin implementing this feature now, using the existing repository as the source of truth. Do not stop after planning or documentation.**

Build an administrator-controlled AI Learning Center that:

- Captures contextual content failures.
- Collects positive and negative human quality feedback.
- Creates structured learning candidates.
- Requires explicit administrator approval.
- Stores approved lessons with scope and versioning.
- Uses only active approved lessons in future generations.
- Maintains independent content validation.
- Preserves operational and publishing safety.
- Supports revision, deactivation, and rollback.
- Evaluates whether lessons actually improve content.
- Separately measures **Content Compliance, Content Quality, and Learning Effectiveness**.

**The desired outcome is not simply a higher content validation pass rate. BotMerzz must become better at producing safe, factually accurate, natural, varied, and engaging Bahasa Melayu Malaysia Threads content while preserving administrator control and measurable evidence of improvement.**

Implement, test, verify, and report actual findings. Do not substitute assumptions for evidence.
