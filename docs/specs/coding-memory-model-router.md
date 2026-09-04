# Adaptive Coding Memory and Model Router

**Date:** 2026-09-03

**Description:** A local-first learning system that helps coding agents retain confirmed lessons, retrieve relevant context, and select suitable models without repeating past mistakes.

## Product Scope

- **Decision:** The first milestone includes both durable memory and model routing. **Reasoning:** The desired feedback loop is incomplete if the system remembers working methods but cannot use accumulated task outcomes to improve model selection.
- **Decision:** The first operator is one local user. **Reasoning:** Team identity, synchronization, and access control would add substantial infrastructure before the personal workflow is validated.
- **Decision:** The learning and routing core is tool-neutral, with OpenCode as the only V1 adapter. **Reasoning:** A year of accumulated knowledge should not be inseparable from one host, but building multiple adapters before validating the core would expand scope unnecessarily.
- **Decision:** Success means that a relevant approved correction is surfaced, followed, and traceable on a similar future task. **Reasoning:** Preventing repeated corrections is the primary user outcome; storage volume or autonomous behavior is not.

## Learning Authority

- **Decision:** Only human-confirmed lessons become durable. **Reasoning:** Automatic persistence could turn misunderstandings, one-off preferences, or agent speculation into long-lived guidance.
- **Decision:** Clear lesson candidates are proposed inline, while ambiguous candidates can be reviewed at the end of a session. **Reasoning:** Immediate review preserves context, while batching uncertain candidates limits interruption fatigue.
- **Decision:** The agent presents a compact candidate containing the proposed rule, rationale, provenance, and inferred scope, with approve, edit, reject, and defer actions. **Reasoning:** OpenCode plugins can provide tools and prompt instructions but do not expose a documented custom approval modal; an agent-mediated confirmation flow fits the available interface and keeps the human in control.
- **Decision:** The system infers project or global scope, but the human approves or edits that scope. **Reasoning:** Requiring manual classification every time is tedious, while silent inference risks applying repository-specific conventions everywhere.
- **Decision:** Successful methods are proposed only after explicit praise, an unusually effective verified result, or repeated success on comparable tasks. **Reasoning:** Treating routine completion as a lesson would create noise and approval fatigue.
- **Decision:** Silence is neutral rather than positive evidence. **Reasoning:** A missing correction does not reliably mean the result was good.
- **Decision:** Retrieved lessons are advisory context. Changes to instructions, skills, code, or durable records still require review. **Reasoning:** Automatic mutation would permit instruction drift and make failures difficult to audit.

## Lesson Lifecycle

- **Decision:** Lessons are structured records containing concise guidance, applicability conditions, scope, rationale, provenance, confirmation metadata, and version information. **Reasoning:** Structured records support precise retrieval and maintenance better than raw transcripts or unannotated directives.
- **Decision:** Corrections append a new version and mark the previous version superseded. **Reasoning:** The active guidance stays current without losing the history needed to understand prior behavior.
- **Decision:** Similar or conflicting candidates trigger a human-reviewed choice to merge, supersede, keep separate, or reject. **Reasoning:** Automatic merging could change meaning, while unchecked duplicates would degrade retrieval over time.
- **Decision:** Time-sensitive lessons record relevant conditions and versions and are flagged for reconfirmation when stale or conflicting. **Reasoning:** Fixed expiration can discard valid knowledge, but permanent unqualified guidance can become wrong as dependencies change.
- **Decision:** The user can inspect, search, supersede, export, back up, restore, and irreversibly hard-delete records. **Reasoning:** Normal corrections benefit from an audit trail, while privacy and severe errors require complete removal.
- **Decision:** A configurable periodic or threshold-triggered digest surfaces stale, unused, duplicate, and contradictory records without changing them automatically. **Reasoning:** Long-lived memory needs maintenance, but cleanup remains a human-authorized action.

## Memory Boundaries

- **Decision:** The system can retrieve useful project context beyond confirmed lessons, but existing project files remain authoritative. **Reasoning:** Project facts, task state, architecture decisions, and plans already have durable homes; copying them into the database would create competing sources of truth.
- **Decision:** A federated index stores references, summaries, metadata, and embeddings for authoritative project documents. **Reasoning:** This allows unified retrieval without taking ownership away from the source files.
- **Decision:** V1 automatically indexes curated context paths such as `AGENTS.md`, `CLEANCODE.md`, `TODO.md`, journals, decisions, specs, designs, and user-configured documentation. Source code is not indexed by default. **Reasoning:** Curated context carries durable intent, while whole-repository indexing duplicates existing code-search tools and adds noise.
- **Decision:** Raw prompts and responses are not retained by default. **Reasoning:** Structured summaries and metrics provide the needed signal with lower privacy risk and less retrieval noise.
- **Decision:** Likely credentials and secrets are blocked from storage, sensitive fragments are redacted, and warnings appear before confirmation or export. **Reasoning:** Human review alone is not a reliable secret-scanning mechanism.

## Storage And Retrieval

- **Decision:** A plugin-owned SQLite database is the source of truth for lessons, indexes, observations, routing evidence, and provenance. **Reasoning:** A year of versioned records and metrics requires transactions, migrations, and indexed queries that a growing Markdown file cannot provide.
- **Decision:** The store lives in the operating system's per-user application-data directory, with a configurable override; repositories do not contain the database. **Reasoning:** This supports cross-project personal memory and avoids accidental commits.
- **Decision:** Project identity prefers normalized VCS remote identity plus an explicit local project ID, falls back to path, and supports relinking or merging. **Reasoning:** Absolute paths break when repositories move, while names alone can collide.
- **Decision:** Retrieval combines lexical and tag filtering with semantic similarity and reranking under a strict context budget. **Reasoning:** Exact search is precise, but semantic matching is needed when a future task describes the same problem differently.
- **Decision:** Embeddings are computed locally by default; a remote embedding provider is an explicit opt-in. **Reasoning:** Even summarized project context can be sensitive, and local inference provides predictable privacy and cost.
- **Decision:** Retrieval runs at the start of each task and at meaningful phase transitions, without changing models mid-task. **Reasoning:** This catches newly relevant guidance while avoiding continuous latency and context churn.
- **Decision:** Automatic versioned SQLite backups and portable JSONL exports run on a configurable schedule. **Reasoning:** A year-long local knowledge base must survive corruption, machine failures, and future migrations.

## Task And Outcome Representation

- **Decision:** Each top-level user request and delegated subtask is a routable task. Phase changes can trigger retrieval but not rerouting within the active task. **Reasoning:** These are explicit OpenCode boundaries and avoid unreliable arbitrary task splitting.
- **Decision:** Tasks use an extensible, versioned, multi-dimensional profile covering activity, domain or stack, complexity, risk, and required capabilities. Humans can correct classifications. **Reasoning:** A single category loses important distinctions, while free-form labels fragment evidence.
- **Decision:** Outcomes are attributed to an execution profile containing model, variant, agent, tool profile, relevant software versions, and task profile. **Reasoning:** Prompting, tools, and environment materially affect results; attributing everything to a model alone would produce misleading rankings.
- **Decision:** Quality, reliability, cost, and latency are tracked separately. Infrastructure and provider failures are classified separately from model-quality failures. **Reasoning:** A single score could blame a model for outages and obscure why one option is preferred.
- **Decision:** Quality evidence combines explicit acceptance, feedback, corrections, rework, tests, lint or typecheck results, and review findings using source-specific weights. Model self-assessment is excluded. **Reasoning:** No single signal captures software quality, and models are not impartial evaluators of their own work.

## Model Routing

- **Decision:** The router considers only explicitly allowlisted model and variant combinations. **Reasoning:** OpenCode exposes a large changing catalog with different credentials, prices, capabilities, and privacy properties; unconstrained exploration is unsafe and statistically sparse.
- **Decision:** Routing occurs per top-level task or delegated subtask. **Reasoning:** Session-wide selection is too coarse, while per-call routing adds inconsistency and complexity.
- **Decision:** Explicit model selection always wins. Automatic routing is a visible mode that can be restored after a manual override. **Reasoning:** Learned preferences must not remove direct user control.
- **Decision:** Cold start uses user preferences and model capabilities as conservative priors. The system recommends models until evidence is sufficient, then may route automatically with an explanation and override. **Reasoning:** Sparse local evidence does not justify confident automation.
- **Decision:** Performance is version-specific and older observations are gradually downweighted. Scores do not transfer to a new model version without an explicit prior. **Reasoning:** Providers and model behavior change over time, so permanent pooled history would become misleading.
- **Decision:** Controlled exploration is limited to low-risk, reversible, objectively verifiable tasks within configured cost limits, and can be disabled. **Reasoning:** Some exploration is necessary to detect improved alternatives, but production or sensitive work should not be used casually for experiments.
- **Decision:** Routing uses a quality-dominant weighted utility across expected quality, reliability, cost, and latency, subject to hard capability, privacy, budget, and latency constraints. **Reasoning:** A much cheaper or faster model can be preferable when its expected quality is only slightly lower, but unacceptable quality cannot be traded away.
- **Decision:** The default policy is balanced and quality-led, with quality-focused and economy presets plus advanced configurable weights. **Reasoning:** Presets make the router usable immediately while preserving control for tasks with different economics.

## OpenCode Integration

- **Decision:** V1 is a publishable npm-compatible TypeScript plugin package running on Bun, backed by a tool-neutral core library and CLI. No application framework is required. **Reasoning:** OpenCode natively loads TypeScript plugins with Bun and exposes typed hooks; a core and CLI preserve portability and administrative access outside a session.
- **Decision:** The OpenCode adapter uses message and system hooks for context and routing, event and tool hooks for observations, and custom tools or commands for approval and administration. **Reasoning:** OpenCode 1.18.27 exposes these capabilities without requiring a fork or wrapper.
- **Decision:** The normal receipt is compact: applied lesson IDs or titles, selected model, and a short reason. Full provenance and scoring are available on demand. **Reasoning:** Traceability is required, but printing every detail on each task would overwhelm the coding flow.
- **Decision:** Storage, embedding, retrieval, or routing failures fail open to ordinary OpenCode behavior with a visible warning and local diagnostic; lexical retrieval is used as a fallback where possible. **Reasoning:** An improvement plugin must not prevent coding work when an optional subsystem fails.
- **Decision:** Separate per-task and per-project controls exist for retrieval, recording, model telemetry, and routing, plus a private mode that disables all four. **Reasoning:** Sensitive work and clean experiments need finer control than a single global switch.
- **Decision:** The package emits no external product telemetry. **Reasoning:** The system handles private development behavior and should keep diagnostics local unless the user explicitly exports them.

## V1 Acceptance

- **Decision:** Acceptance is an end-to-end scenario suite rather than only unit-level storage checks. **Reasoning:** The value depends on complete behavior across sessions and task boundaries.
- A confirmed correction is retrieved and applied during a paraphrased similar task in a later session.
- Project-scoped lessons remain isolated, while approved global lessons can apply across projects.
- A superseding correction prevents obsolete guidance from being served while preserving its audit history.
- Hybrid retrieval finds relevant guidance that does not share exact wording with the task.
- Synthetic and live outcome evidence changes a model recommendation or automatic route as expected.
- Explicit model selection bypasses the router.
- Storage, embedding, and routing failures do not block ordinary OpenCode work.
- Export, backup, and restore preserve active records, provenance, and supersession relationships.
- Private mode produces no new memory or model-performance records and performs no retrieval or routing.

## V1 Exclusions

- Team sharing, multi-user identity, and access control.
- Cloud storage or service operation.
- Cross-device synchronization.
- Autonomous lesson approval or silent persistent-instruction mutation.
- Raw transcript retention by default.
- Whole-repository source-code indexing.
- Historical OpenCode session import; V1 begins collecting structured data after installation.
- Coding-tool adapters other than OpenCode.

## Open And Ungrillable Items

- **Local embedding model and vector index:** Benchmark candidate local models and storage integrations for relevance, size, startup cost, and platform support.
- **Retrieval ranking:** Build a small paraphrase and conflict corpus to tune lexical versus semantic weights, reranking, context limits, and stale-record behavior.
- **Phase-change detection:** Prototype against real sessions to determine which explicit events or classifications justify a second retrieval.
- **Routing coefficients:** Tune quality evidence weights, utility coefficients, and preset defaults using controlled task outcomes rather than arbitrary values.
- **Automation confidence:** Determine minimum evidence and confidence margins through simulation and live trials before automatic routing is enabled.
- **Exploration rate:** Measure regret, cost, and learning speed on low-risk tasks before choosing a default frequency.
- **Approval interaction quality:** Prototype the candidate card, end-of-session review, and compact receipt to measure interruption fatigue and comprehension.
- **Latency targets:** Measure the local SQLite, embedding, and reranking path on representative hardware before setting service-level objectives.
