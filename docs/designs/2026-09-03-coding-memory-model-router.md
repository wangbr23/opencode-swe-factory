# Coding Memory and Model Router Design

**Date:** 2026-09-03

## Problem

OpenCode sessions do not reliably carry corrections, proven working methods, or model-performance knowledge into future work. Repeating all prior guidance in global Markdown instructions would eventually create an unbounded, mostly irrelevant prompt, while retaining raw sessions would add privacy risk without guaranteeing useful recall. The system needs a durable, human-controlled learning loop that retrieves only relevant context and gradually improves model selection without making the coding workflow depend on the learning subsystem.

## Grounding

- The repository currently has no package manifest, source files, test suite, or executable commands. `AGENTS.md` records the selected TypeScript/Bun stack and this design's high-level package shape, while commands remain unset until package scaffolding exists; this design establishes the first implementation rather than adapting existing code ([`AGENTS.md`](../../AGENTS.md)).
- Project-wide quality constraints require simple, focused changes, explicit domain types, validated external input, deliberate error handling, and behavior-focused tests ([`CLEANCODE.md`](../../CLEANCODE.md)).
- The confirmed product specification requires human-confirmed learning, project/global scope, federated retrieval of curated context files, local-first hybrid search, a SQLite source of truth, a tool-neutral core, an OpenCode V1 adapter, evidence-based model routing, and fail-open behavior ([product spec](../specs/coding-memory-model-router.md)).
- Existing architecture decisions require a TypeScript/Bun core and CLI, a publishable OpenCode plugin, plugin-owned local SQLite, authoritative project files indexed by reference, exact model/variant evidence, and configurable quality-led routing ([`docs/decisions.md`](../decisions.md)).
- `TODO.md` decomposes this design's rollout into dependency-linked implementation and verification tasks; none are implemented yet ([`TODO.md`](../../TODO.md)).
- OpenCode 1.18.27 exposes typed plugin hooks for incoming messages, system-context transformation, tool execution, commands, and events. Its SDK exposes sessions, configured providers/models, assistant cost and token data, and custom tools. Current source shows that mutating the message model in the `chat.message` output affects the immediate request, but this behavior is undocumented and the session-level model pointer is updated before the hook runs. TUI clients commonly send a selected model with prompts, but the adapter cannot treat that as a stable cross-client intent signal without contract tests; it needs an explicit routing mode ([OpenCode plugin types](https://github.com/anomalyco/opencode/blob/dev/packages/plugin/src/index.ts), [OpenCode prompt flow](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/prompt.ts), [OpenCode SDK documentation](https://opencode.ai/docs/sdk/)).
- Transformers.js supports local feature-extraction models, including the 384-dimensional `Xenova/all-MiniLM-L6-v2`. Its runtime can be configured to disallow remote models after an explicit first-run artifact installation ([Transformers.js documentation](https://huggingface.co/docs/transformers.js), [model card](https://huggingface.co/Xenova/all-MiniLM-L6-v2)).
- `sqlite-vec` supports Bun but is pre-1.0 and may require a custom SQLite library on macOS. The expected V1 corpus is curated documentation and confirmed lessons, so exact application-side similarity is the smaller initial choice; a native vector extension is not justified before measurement ([sqlite-vec Bun documentation](https://alexgarcia.xyz/sqlite-vec/js.html)).

## Goals

- Preserve human-confirmed corrections and successful methods as structured, versioned lessons.
- Retrieve concise, relevant project and global context at task boundaries without growing the permanent prompt.
- Keep project files authoritative while making their relevant content searchable with lessons.
- Record privacy-bounded task outcomes and use them to recommend, then safely route among allowlisted model variants.
- Keep every persistent behavior auditable, reversible through supersession, and hard-deletable on explicit request.
- Continue normal OpenCode work when any memory, embedding, indexing, or routing operation fails.
- Expose the same store and core operations through a CLI so long-lived knowledge is not locked to OpenCode.

## Non-goals

- Team accounts, shared memory, cloud services, or cross-device synchronization.
- Adapters for coding tools other than OpenCode.
- Autonomous lesson approval, silent mutation of instruction files, or model self-evaluation.
- Raw prompt, response, or tool-output retention by default.
- Whole-repository source indexing or replacement of existing project context files.
- Importing historical OpenCode sessions.
- Mid-task model switching, arbitrary task decomposition, or routing across models outside an explicit allowlist.
- App-level database encryption in V1. Owner-only filesystem permissions and the host operating system's disk encryption are the at-rest boundary; likely secrets are blocked before persistence.
- A daemon, remote API, web dashboard, monorepo, or independent service process.

## Design

### Package Shape

Build one publishable TypeScript package running on Bun. Keep three entry points in the same package:

- A host-neutral core containing domain types, SQLite repositories, lesson lifecycle, indexing, retrieval, task profiling, outcome aggregation, routing, backup, and redaction.
- An OpenCode adapter translating plugin hooks and custom tools into core operations.
- A CLI for configuration, inspection, correction, export, backup, restore, relinking projects, and diagnostics.

The core must not import OpenCode types. The adapter passes normalized task, tool-result, feedback, and session-boundary records into direct core service calls; no generic event bus or plugin framework is needed inside the package. This boundary is sufficient for a future adapter without paying for a multi-package architecture now.

Use `bun:sqlite` directly rather than adding an ORM. The schema is small, migrations are explicit, and direct SQL keeps backup, FTS5, and transaction behavior visible. Validate configuration and all adapter input at the boundary before domain operations run.

### Runtime And Configuration

Resolve config, data, cache, and backup paths with OS-appropriate per-user directories. Keep a versioned, human-readable package configuration file outside OpenCode configuration; the OpenCode plugin entry only loads the package. Store mutable per-project controls in SQLite so a repository does not need generated configuration files.

Configuration covers the model/variant allowlist, routing mode and preset, hard privacy/budget/latency limits, curated document paths, embedding artifact location, backup schedule and retention, maintenance thresholds, and feature toggles. Retrieval, recording, model telemetry, and routing are independently controllable at global, project, and session scope. Private mode resolves all four to disabled before any task text reaches the core.

The default routing state is recommendation-only. Automatic routing is enabled explicitly for a session or project after the router reports sufficient evidence. The adapter keeps the host-selected model distinct from its last routed model. A changed host selection pins the session, and dedicated CLI/plugin controls provide explicit pin, one-shot override, and return-to-auto operations. On a new or ambiguous session, explicit host choice wins and auto-routing requires an explicit enable action.

### Storage Model

Use one SQLite database with WAL mode, foreign keys, `secure_delete` enabled from database creation, owner-only file permissions, a bounded busy timeout, and short transactions so concurrent OpenCode processes can share it. Serialize schema migrations under an application lock and refuse writes on an unknown newer schema while allowing a safe diagnostic/export path. Verify FTS5 availability during initialization; if unavailable, disable retrieval and report the failed prerequisite rather than creating a partially functional index.

The durable entities are:

- Projects and path/remote aliases. Project identity uses a hashed normalized VCS remote plus an internal local ID; credentials and query fragments are removed before normalization. Path is the fallback, and relink/merge operations are explicit.
- Lessons and immutable lesson versions. A stable lesson points to one active confirmed version; newer versions can supersede older versions without deleting provenance.
- Pending lesson candidates. These contain only a structured draft, are excluded from retrieval, expire automatically after a short review window, and are deleted on rejection. They are not durable approved lessons.
- Document sources and disposable index chunks. Each chunk records source path, heading, content hash, scope, timestamps, extracted text for FTS, and embedding version. Source files remain authoritative, and every indexed row can be rebuilt.
- Tasks and execution profiles. These store structured classifications and environment identifiers, not raw prompts.
- Outcome signals. Each immutable signal records kind, source, confidence, value, task/execution association, and whether it reflects quality, reliability, cost, or latency.
- Managed backup/export metadata and maintenance state.

Use stable opaque IDs in receipts and exports. JSONL export includes schema version, relationships, provenance, and tombstones needed to preserve supersession. Restore is transactional into a new database, validated there, and swapped into place only after integrity checks pass.

### Lesson Capture And Approval

Inject a short protocol telling the active agent when to propose a lesson: an explicit correction, explicit praise, an unusually effective verified method, or repeated comparable success. The agent calls a custom proposal tool with structured text, rationale, applicability, provenance, and inferred scope. The tool validates and secret-scans the candidate but cannot activate it.

The agent presents the validated candidate through OpenCode's normal question interaction with approve, edit, reject, and defer choices. Approval calls a separate commit tool. Edit creates a replacement candidate for approval rather than modifying an approved row. Deferred candidates remain pending only until their configured expiry and appear in an optional session-end review reminder. Rejected candidate content is removed. High-confidence live credential matches cannot become candidates; lower-confidence matches require an explicit acknowledgment recorded in provenance before approval can proceed.

Before approval, retrieve semantically and lexically nearby lessons. If overlap or conflict exists, the confirmation includes merge, supersede, keep-separate, and reject choices. Merge and supersede always create a new immutable version; they never rewrite prior confirmed content. Project/global scope is inferred but displayed as part of the approval.

Do not infer positive learning from user silence. Automated outcomes may trigger a successful-method proposal only after repeated strong evidence, and that proposal still requires approval.

### Federated Indexing

On project activation, resolve only the curated paths confirmed by the product spec plus user-configured documentation paths. Canonicalize each path, reject traversal and symlink escapes outside the project unless the path was explicitly approved, impose file-size and total-index limits, and ignore binary content.

Chunk Markdown by heading boundaries with a bounded fallback for oversized sections. Preserve source type, heading path, and line range so every result can cite its origin. Reindex only when the content hash changes. Delete stale chunks when a source disappears, but never modify the source document.

Treat indexed context as two trust classes:

- Confirmed lessons are approved guidance and can be injected as instructions within their scope.
- Project documents are attributed reference material. Existing instruction files keep their normal OpenCode authority, while retrieved journal, TODO, design, and decision excerpts are clearly delimited as data rather than elevated to global instructions.

Project-scoped records outrank global records when applicability is otherwise equal. If two active confirmed lessons conflict, do not choose silently: omit the conflicting directives from automatic injection, show the conflict in the receipt, and request resolution.

### Hybrid Retrieval

Use SQLite FTS5 for lexical retrieval and `Xenova/all-MiniLM-L6-v2` through Transformers.js for semantic retrieval. Pin the model revision and artifact checksums. The first-run setup command downloads model and runtime artifacts with explicit notice, verifies them, and stores them in the package cache. Normal operation disables remote model loading; private mode never initiates downloads.

Store normalized 384-dimensional vectors as ordinary SQLite blobs with the embedding model/revision attached. For V1, load vectors only for active project/global records that pass scope, status, applicability, source-type, and staleness filters, then compute exact cosine similarity in-process. The curated corpus makes this adequate initially and avoids a pre-1.0 native extension. A measured latency or corpus-size breach is the sole trigger for introducing a vector index later.

Lexical and semantic searches each produce a bounded candidate list. Fuse them with reciprocal-rank fusion so incompatible BM25 and cosine score scales do not require premature hand-tuned normalization. Apply deterministic boosts for exact task dimensions, project scope, confirmed lessons, source authority, and recency where the source is time-sensitive. Remove superseded, expired, unresolved-conflict, disabled, and inapplicable records before final ranking.

Pack results into a fixed token budget in ranked order. Inject concise lesson text directly, but summarize document chunks with their citation and trust class. The receipt reports included and omitted result counts, stable IDs/titles, source scope, and whether semantic retrieval was unavailable. If the embedding model is cold or fails, lexical retrieval proceeds immediately rather than blocking the task.

### Task Profiling And Evidence

Create one task record for each top-level request and delegated subtask. Build a multi-dimensional profile from deterministic repository metadata, declared project stack, task boundary type, lexical features, and similarity to a versioned taxonomy. Do not make a separate generative-model call before routing. Record only the selected dimensions and a short redacted summary; discard the raw classifier input. The receipt exposes the profile, and a correction command appends a corrected classification.

The OpenCode adapter converts observable events into evidence:

- Assistant completion supplies exact provider/model/variant, agent, timing, token use, cost, finish state, and provider errors.
- Tool completion supplies transient command/tool status. Derive configured test, lint, typecheck, build, review, and generic tool success/failure signals in memory, then discard raw output.
- Explicit feedback, acceptance, correction, and rework controls supply high-confidence quality signals.
- Confirmed correction lessons link back to the affected execution as strong negative quality evidence without retaining the conversation.

Do not treat every tool success as task success, and classify provider, authentication, cancellation, and local-tool failures separately from model quality. Each signal remains inspectable so aggregation can be recomputed after scoring changes.

### Routing Policy

Filter the allowlist first by model availability, required modalities/capabilities, privacy policy, and hard per-task cost/latency limits. Never route to an unconfigured model or silently weaken a hard constraint.

For each eligible exact model/variant, aggregate exponentially decayed evidence across progressively broader compatible task profiles. Prefer exact activity/domain/complexity matches; back off to coarser dimensions only when necessary and reduce confidence accordingly. Keep quality, reliability, observed cost, and observed latency as separate estimates with effective sample size and uncertainty.

Cold-start priors come only from user configuration and OpenCode model capabilities/pricing. Recommendation mode displays the best eligible option and why, but does not mutate the message model. Automatic routing requires configured minimum evidence, a confidence floor, and a utility margin over the current model. The balanced preset maximizes a quality-dominant weighted utility after hard constraints; quality-focused and economy presets alter weights, not safety floors.

Controlled exploration is eligible only when the task is classified low-risk, changes are reversible, objective verification exists, the candidate remains above the quality floor, and the exploration budget is not exhausted. The receipt labels exploratory choices. Exploration and all automated routing remain disabled until benchmark-derived defaults are accepted.

### OpenCode Adapter Flow

At plugin initialization, validate configuration, open/migrate the database, schedule non-blocking index refresh and backup checks, register custom tools, and run a compatibility check. OpenCode 1.18.27 is the minimum version, but automatic injection and routing are enabled only for releases covered by the package's passing contract-test manifest and a runtime probe. An initialization or compatibility failure records a local diagnostic and returns hooks that leave normal OpenCode behavior unchanged; safe CLI and memory-administration operations remain available.

At an incoming top-level message or subtask boundary:

1. Resolve private mode and feature toggles before processing content.
2. Resolve project identity and refresh changed curated documents without blocking on embeddings.
3. Build the task profile.
4. Retrieve applicable context if enabled.
5. Compute a recommendation or route if enabled and eligible.
6. Attach the selected model to the current user message only when auto-routing is active, no pin/override applies, and the compatibility probe has demonstrated that message-model mutation changes the immediate request.
7. Merge retrieved context into the existing primary system block in place and emit a compact receipt. Never append additional system messages, because some provider-compatible backends accept only one leading system message and prompt caching depends on stable system-message shape.

Maintain only pending per-session injection state between the message and system hooks, keyed by session and message identity where available, and clear it after use or abort. The adapter must never carry retrieved context into another concurrent session. Because the system-transform hook does not expose a message ID, suppress injection and routing whenever queued same-session work cannot be correlated unambiguously; emitting a warning is safer than attaching plausible but incorrect context.

At tool and message completion events, derive and persist allowed metrics asynchronously in short transactions. At session idle, offer a deferred-candidate reminder and flush pending metrics; do not equate idle with success.

Model mutation and system transformation depend on OpenCode hook behavior, including an experimental system hook. Message-model mutation is observed behavior rather than a documented plugin guarantee, and it can leave OpenCode's session-level model pointer behind the model used for the immediate request. The adapter therefore tracks host-selected and routed models separately, tests both the immediate request and following turn, and supports only versions in its passing compatibility manifest. If a probe fails, it disables automatic injection/routing, retains CLI access, and shows a warning rather than guessing.

### Privacy, Deletion, And Recovery

Run a maintained secret-scanning library plus conservative credential-pattern and entropy checks before persisting lesson text, task summaries, document chunks, diagnostics, or exports. Hard-block high-confidence live credential values. For lower-confidence token-shaped examples, hashes, and entropy matches, show the exact flagged region and require an explicit acknowledgment recorded in provenance. Blocked or skipped document chunks remain visible in diagnostics and receipts. Store only redacted paths and summaries in diagnostics.

Set owner-only permissions on data, config, cache, and backup files. Do not implement custom cryptography or claim protection from a compromised user account. Document that initial model artifact installation contacts the configured artifact host and that normal local inference does not send indexed text externally.

Hard deletion is privacy-first and requires a warning that all managed historical recovery points will be lost. After confirmation, it removes active rows, FTS entries, embeddings, pending candidates, and associated derived evidence; checkpoints and truncates WAL state; vacuums the main database to clear freelist residue; purges all managed backups; and creates a clean baseline backup. The CLI must state that it cannot retract user-copied exports or guarantee physical erasure from SSD snapshots and external backups.

Backups use a SQLite-consistent snapshot, integrity check, versioned retention, and atomic rename. Corruption or migration failure leaves the original database untouched and starts OpenCode in fail-open mode. Restore never overwrites the live database until validation succeeds.

## Risks

- **OpenCode hook compatibility:** Model mutation is observed but undocumented, system-context transformation is experimental, and the immediate routed model can differ from OpenCode's session pointer. A tested-version manifest, runtime probes, following-turn checks, and fail-open disablement limit impact, but upgrades can temporarily reduce the system to CLI and recommendation-only behavior.
- **Manual model intent detection:** Client behavior differs, and a model present on a prompt does not intrinsically distinguish inherited and deliberate selection. Explicit router modes, tracked host-model changes where supported, and pin/override controls reduce ambiguity; first contact defaults to user control.
- **Same-session queue correlation:** The system-transform hook lacks a message ID, so queued work can make task-to-injection correlation ambiguous. The adapter suppresses automatic injection and routing in that state, which preserves correctness at the cost of temporarily missing relevant context.
- **System-message compatibility:** Adding system-message blocks can cause provider rejection and cache misses. The adapter mutates the primary block in place and contract-tests a backend that accepts only one leading system message.
- **Approval fatigue:** Too many lesson proposals would train the user to approve mechanically. Strong proposal triggers, deferral, deduplication, and digest thresholds need usability testing.
- **Retrieval poisoning:** Cloned project documents can contain misleading instructions. Curated paths, scope boundaries, source trust classes, citation, and conflict handling reduce but do not eliminate this risk.
- **Embedding supply chain and footprint:** Transformers.js, ONNX runtime artifacts, and model weights add download size and executable dependencies. Pinning, checksum verification, explicit installation, and offline runtime reduce exposure.
- **Semantic quality:** MiniLM may miss coding-specific equivalence or over-rank generic guidance. The lexical path, benchmark corpus, receipts, and easy disablement keep failure visible.
- **Exact vector-search growth:** Application-side cosine search may become slow after sustained use. Measure scoped corpus size and retrieval latency; introduce a vector extension only after a documented threshold is exceeded.
- **Sparse and biased routing evidence:** Tasks differ, models change, and stronger models may receive harder work. Shadow recommendations, uncertainty, profile backoff penalties, decay, and controlled exploration reduce false confidence but cannot make observational data equivalent to randomized evaluation.
- **False outcome attribution:** Tool failures, environment problems, or agent prompts may be blamed on a model. Separate signal dimensions and execution profiles allow reclassification and recomputation.
- **Sensitive derived data:** Even summaries, task labels, and embeddings can reveal project information. Private mode, minimization, local inference, owner-only permissions, redaction, and hard delete reduce exposure; V1 does not protect against compromise of the local account.
- **Concurrent process contention:** Multiple OpenCode processes can race on indexing, migrations, or backup. WAL, unique content hashes, short transactions, migration locking, and atomic snapshots constrain the failure modes without adding a daemon.
- **Backup deletion limits:** Privacy-first hard deletion intentionally destroys managed backup history before creating a new baseline. Copied exports, filesystem snapshots, and SSD remanence remain outside application control and must be disclosed.

## Rollout

1. Establish the single TypeScript/Bun package, schema-validated configuration, OS paths, SQLite migrations, domain types, CLI diagnostics, and OpenCode compatibility harness.
2. Deliver the lesson vertical slice: propose, secret-scan, approve, inspect, retrieve lexically, supersede, conflict-check, hard-delete, export, and restore. Keep all routing disabled.
3. Add curated document indexing, FTS5 citations, project identity/relinking, source trust classes, and context-budgeted OpenCode injection. Validate cross-session and project/global behavior before semantic search.
4. Add explicit local embedding artifact installation, asynchronous embedding, exact semantic search, reciprocal-rank fusion, and retrieval benchmarks. Keep lexical fallback and remove semantic search from the critical path when cold or unavailable.
5. Add task profiles, execution records, objective tool/message signals, explicit feedback, evidence inspection, and model statistics. Keep the router in shadow/recommendation mode.
6. Add allowlist filtering, decayed evidence aggregation, uncertainty, presets, hard constraints, compact routing receipts, and pin/override controls. Validate recommendations on synthetic and live tasks.
7. Implement automatic routing behind an explicit opt-in and prove it with synthetic evidence after confidence thresholds and utility weights pass the benchmark. Normal V1 use may remain recommendation-only until live evidence genuinely crosses those thresholds. Add bounded low-risk exploration last.
8. Add scheduled maintenance digests, managed backup retention, stale-lesson review, and operational recovery exercises before declaring V1 complete.

Each rollout step is independently usable and must preserve fail-open OpenCode behavior. A later step does not justify speculative infrastructure in an earlier one.

## Verification

- Unit-test lesson state transitions, immutable supersession, scope resolution, project identity normalization, path containment, secret redaction, task-profile validation, evidence decay, utility scoring, hard constraints, and private-mode short-circuiting.
- Run migration tests from every released schema version, an FTS5 availability smoke test, concurrent writer tests under WAL, corruption/failure injection, transactional restore tests, and database integrity checks.
- Build a versioned retrieval corpus containing paraphrases, exact matches, stale records, conflicting lessons, project/global collisions, malicious document instructions, and irrelevant near-neighbors. Measure recall, incorrect-injection rate, conflict suppression, context-budget compliance, and warm/cold latency. Record accepted thresholds in `docs/decisions.md` before enabling gates that depend on them.
- Verify the pinned embedding artifacts by checksum, run installation without executing remote code, and prove that normal retrieval works with network access disabled.
- Contract-test the adapter against each supported OpenCode version: task-boundary detection, immediate and following-turn model behavior, in-place primary-system-block injection, a single-system-message backend, queued same-session correlation, concurrent-session isolation, custom lesson tools, tool/message telemetry, manual pin/override, provider rejection, and fail-open compatibility behavior.
- Exercise the confirmed end-to-end scenarios across separate OpenCode processes: correction recall after paraphrasing, project isolation, approved global reuse, supersession, conflict review, and traceable receipts.
- Replay synthetic execution histories with known preferred models to verify profile backoff, confidence gating, version decay, quality/cost/latency tradeoffs, hard floors, and deterministic recommendation output.
- Run shadow routing on real work before automation. Compare recommendations to explicit outcomes, user choices, and corrections; do not enable automatic routing until agreed confidence, utility, latency, and regret thresholds are met. V1 remains valid in recommendation mode if live evidence is insufficient.
- Verify that provider/auth/tool failures affect the correct reliability dimension and do not become negative model-quality evidence.
- Verify private mode through database snapshots and hook instrumentation: no retrieval, persisted task summary, outcome signal, embedding, or routing decision may be created.
- Verify lower-confidence secret false-positive acknowledgment, high-confidence credential blocking, and visibility of skipped document chunks.
- Verify hard deletion across active rows, the main-database freelist after vacuum, FTS, embeddings, WAL, and every managed backup, while confirming the loss of historical recovery points and documenting the external-copy limitation.
- Complete backup/restore and rollback drills, including failed migration and corrupt latest-backup cases, without losing the last known-good database.
