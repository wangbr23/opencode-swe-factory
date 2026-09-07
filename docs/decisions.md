# Decisions

Append-only log of architecture decisions. One entry per decision, newest at the bottom. Do not edit past entries; a reversed decision gets a new entry that supersedes the old one.

## 2026-09-03 — Record architecture decisions

**Status:** Accepted

**Context:** We need a lightweight way to record why significant technical decisions were made, so future work by any contributor, model, or tool does not rediscover or accidentally reverse them.

**Decision:** Keep architecture decisions in `docs/decisions.md`, one entry per decision, appended chronologically. A changed decision gets a new entry that supersedes the old one.

**Consequences:** Decisions and their reasoning survive context resets, model changes, tool switches, and contributor turnover.

## 2026-09-03 — Build a tool-neutral core with an OpenCode adapter

**Status:** Accepted

**Context:** The system must integrate deeply enough with OpenCode to observe tasks, inject relevant guidance, and select models, while keeping long-lived knowledge usable if the host coding tool changes.

**Decision:** Build a TypeScript/Bun core library and CLI with a publishable OpenCode plugin as the first and only V1 adapter. Use OpenCode's typed plugin hooks and SDK rather than a wrapper or fork. See the [coding memory and model router spec](specs/coding-memory-model-router.md).

**Consequences:** V1 fits OpenCode's native extension model and avoids fork maintenance. Core domain logic must remain separate from OpenCode-specific hooks, but additional coding-tool adapters remain out of scope.

## 2026-09-03 — Use local SQLite with federated project context

**Status:** Accepted

**Context:** The system must retain versioned lessons and performance evidence for a year or more without relying on an ever-growing Markdown file or creating duplicate authorities for existing project context.

**Decision:** Keep lessons, observations, indexes, and provenance in a plugin-owned SQLite database in the user's application-data directory. Index curated authoritative project files by reference using local-first hybrid lexical and semantic retrieval. See the [coding memory and model router spec](specs/coding-memory-model-router.md).

**Consequences:** The store supports migrations, indexing, project/global scope, backups, and cross-project personal memory. Existing context files remain authoritative, local embedding support is required, and database failure must not block OpenCode.

## 2026-09-03 — Route models from versioned execution evidence

**Status:** Accepted

**Context:** Model suitability varies by task, cost, latency, agent setup, tools, and model version. A single permanent model score would conceal these factors and become stale.

**Decision:** Route top-level requests and delegated subtasks among explicitly allowlisted models using versioned task and execution profiles. Track quality, reliability, cost, and latency separately, then apply a configurable quality-led weighted utility. Explicit model choices always win, and automatic routing begins only after sufficient evidence. See the [coding memory and model router spec](specs/coding-memory-model-router.md).

**Consequences:** The router requires structured task classification, outcome attribution, evidence decay, conservative cold-start behavior, controlled exploration, and transparent routing receipts. Thresholds and weights must be benchmarked before automation is trusted.

## 2026-09-03 — Use one package with dependency-light hybrid retrieval

**Status:** Accepted

**Context:** The initial implementation needs a tool-neutral core, CLI, OpenCode adapter, and local hybrid retrieval, but there is no current codebase or scale evidence that justifies a monorepo, ORM, service process, or native vector extension.

**Decision:** Build one TypeScript/Bun package with three entry points, use `bun:sqlite` and FTS5 directly, generate pinned local MiniLM embeddings with Transformers.js, compute exact cosine similarity over the scoped curated corpus, and combine lexical and semantic ranks with reciprocal-rank fusion. Introduce a vector extension only after a recorded scale or latency threshold is exceeded. See the [reviewed design](designs/2026-09-03-coding-memory-model-router.md).

**Consequences:** V1 has fewer packaging and native-extension failure modes and keeps host-neutral logic separate without a workspace. Semantic retrieval cost must be measured over long-lived corpora, and changing embedding models requires versioned re-embedding.

## 2026-09-03 — Gate OpenCode automation to verified hook behavior

**Status:** Accepted

**Context:** OpenCode 1.18.27 currently permits immediate model routing by mutating a message in the `chat.message` hook and context injection through an experimental system hook, but those behaviors are not stable documented contracts and can leave session model state behind the immediate request.

**Decision:** Require OpenCode 1.18.27 or newer, but enable automatic injection and routing only for versions covered by passing contract tests and a runtime compatibility probe. Merge context into the primary system block, suppress automation when queued-message correlation is ambiguous, and fall back to recommendation-only or ordinary OpenCode behavior on incompatibility. See the [reviewed design](designs/2026-09-03-coding-memory-model-router.md).

**Consequences:** OpenCode upgrades cannot silently receive unverified automatic behavior. Some versions or queued states may temporarily lose injection/routing while CLI and safe memory operations continue.

## 2026-09-03 — Make deletion privacy-first and secret handling confidence-based

**Status:** Accepted

**Context:** Long-lived memory needs both recoverable backups and complete user-requested deletion, while secret scanners can mistake hashes or examples for live credentials.

**Decision:** Hard deletion warns, vacuums the live database, purges all managed historical backups, and creates a clean baseline. High-confidence live credentials are always blocked; lower-confidence matches may proceed only after explicit acknowledgment recorded in provenance. See the [reviewed design](designs/2026-09-03-coding-memory-model-router.md).

**Consequences:** A hard delete intentionally sacrifices managed recovery history and cannot retract copied exports or filesystem snapshots. Lower-confidence false positives remain usable without weakening protection for likely live credentials.

## 2026-09-05 — Narrow V1 to governed lessons and model recommendations

**Status:** Accepted; supersedes the V1 scope portions of the 2026-09-03 architecture decisions where they require curated-document retrieval, phase-transition retrieval, or automatic model routing.

**Context:** Claude-Mem is a mature Apache-2.0 product that already supports OpenCode and provides automatic session capture, AI compression, history search, context injection, a viewer, and multi-host integrations. Its documented extension surface is a worker HTTP API, not an importable memory library, and its episodic observation model stores broad session content and sends it to a configured compression provider. It does not provide the human-approved lesson lifecycle or structured model-outcome evidence required here.

**Decision:** Keep an independent, dependency-light package focused on normative memory and measured recommendations. V1 proves cross-process recall of a human-approved correction and an evidence-driven change in model recommendation. Defer curated-document retrieval, phase-transition retrieval, automatic model mutation, and controlled exploration behind a manual post-V1 evidence review. Do not make Claude-Mem a dependency or write to its database; consider only an optional read-only HTTP bridge after V1.

**Consequences:** Existing document admission and schema work remains dormant rather than removed. Approved-lesson semantic retrieval remains in V1 because paraphrased correction recall is a core outcome. Generic session memory is left to Claude-Mem or similar tools, while this package preserves its stricter no-raw-transcript and no-compression-provider privacy boundary.

## 2026-09-06 — Pin the embedding model revision and artifact checksums

**Status:** Accepted

**Context:** The design requires local semantic retrieval through Transformers.js with a pinned model and verified artifacts so that nothing is downloaded or executed implicitly and normal operation can run fully offline (design risk: embedding supply chain and footprint).

**Decision:** Pin `Xenova/all-MiniLM-L6-v2` at revision `751bff37182d3f1213fa05d7196b954e230abad9` with SHA-256 checksums for the six required files (config, tokenizer, vocab, quantized ONNX weights), recorded by downloading the pinned revision once at pin time. Installation is explicit, gated on `embeddings.allowRemoteDownloads`, refused in private mode, verifies checksums before writing, stores artifacts owner-only under the package cache, and never executes downloaded content. Changing the pinned revision or checksums requires a new decision entry.

**Consequences:** Model updates are a deliberate supply-chain decision rather than silent drift. The quantized ONNX artifact (~23 MB) is the download footprint; semantic retrieval stays on the lexical fallback until artifacts are verified (T49/T82).

## 2026-09-06 — Keep the lesson embedding indexer artifact-agnostic with an injectable embed function

**Status:** Accepted

**Context:** T49 needs confirmed-lesson embedding indexing, but the real local embedder (Transformers.js over the pinned artifacts) is not wired yet and semantic retrieval (T17) will also need to embed queries. Coupling indexing to the model runtime now would make it untestable without the artifact supply chain and would blur the boundary between "compute a vector" and "persist vectors with versioned lifecycle".

**Decision:** Define the embedding computation as an injectable `EmbedLessonTextFn` and keep the indexer responsible only for selecting pending active lesson versions, validating vectors (384 dimensions, finite components), persisting them keyed by (model, revision), and pruning stale-revision and non-active-version rows. Model and revision default to the pinned manifest values so re-embedding is versioned by the pin. Artifact verification is a responsibility of the code that constructs the real embedder, not of the indexer. The asynchronous surface is a fail-open, single-flight scheduler (`schedule()`) whose failures are reported as outcomes, never thrown into the host.

**Consequences:** T17 supplies the real embedder (and can reuse the same function for query embedding); until then nothing calls the indexer with a production embedder and semantic retrieval stays on the lexical fallback. Pruning old-revision vectors after successful re-embedding trades a few megabytes of recomputable data for a store that always reflects the current pin. Indexing cost is bounded per run by a batch cap and incremental by design.

## 2026-09-06 — Take Transformers.js as an optional peer dependency

**Status:** Accepted

**Context:** T17 needs to embed query text, which requires the Transformers.js runtime (`@huggingface/transformers` with its bundled ONNX runtime, ~100 MB installed). The package ethos is dependency-light and the design mandates fail-open behavior ("if the embedding model is cold or fails, lexical retrieval proceeds immediately"), but a hard dependency would make every install pay the runtime cost even for lexical-only use.

**Decision:** Declare `@huggingface/transformers` as an optional peer dependency. `createLocalLessonEmbedder` verifies the pinned artifacts first, then loads the runtime through a dynamic import that is validated structurally on load; a missing or malformed runtime produces a typed `LessonEmbedderError` with code `runtime-unavailable`, so callers fail open to lexical retrieval. The default loader never touches the network for the runtime or the model (`allowRemoteModels = false`), and the model is read only from the checksum-verified artifact directory.

**Consequences:** Default installs stay light; users who want semantic retrieval install the optional runtime explicitly (wiring for an install command arrives with T82). The runtime-unavailable path is a first-class tested behavior rather than an environmental accident. If semantic retrieval becomes default-on later, this decision should be revisited with install-footprint evidence.

## 2026-09-06 — Aggregation labels profile-backoff levels; ranking applies the penalty

**Status:** Accepted

**Context:** T20 aggregates decayed evidence for an exact model/variant across progressively broader task-profile matches. The design says coarser matches must "reduce confidence accordingly", so the first implementation multiplied every evidence item's weight by a per-level backoff weight. A constant multiplier on all items of an estimate cancels out of the weighted mean and scales out of Kish effective sample size — it changed only the reported `decayedWeight`, inflating apparent precision discounting without altering any statistic a consumer would rank on.

**Decision:** Aggregation reports the backoff level used for each dimension estimate (and widens to coarser levels only when the narrower level carries no evidence). The level's penalty weight from `EVIDENCE_AGGREGATION_CONSTANTS.backoffLevelWeights` is a documented input to downstream utility scoring (T61), which multiplies quality-dominated utility or margin requirements by it. Aggregation itself keeps item weights to signal confidence × exponential decay, so mean, ESS, and uncertainty remain honest evidence statistics.

**Consequences:** T61 must actually consume `backoffLevel` (a test can enforce that coarse-level evidence does not outrank exact-level evidence with equal means). Uncertainty still grows for sparse coarse evidence through ESS, so confidence gating (T62) also discriminates naturally. Two further aggregation contracts fixed here: only execution-linked signals aggregate, since task-level feedback cannot be attributed to one model/variant without guessing (the design's false-attribution risk); and evidence only joins from task profiles whose `taxonomy_version` equals the current `TASK_TAXONOMY_VERSION`, so a taxonomy bump orphans stale-dimension evidence rather than silently re-matching it.

## 2026-09-06 — Utility scores normalize cost/latency relative to the eligible set and score only known dimensions

**Status:** Accepted

**Context:** T61 ranks eligible models by a preset-weighted utility, but the four evidence dimensions live on different scales: quality and reliability are 0–1, while cost and latency are unbounded native units (USD, ms). Combining them needs normalization, and candidates can lack evidence on any dimension entirely (cold start). The design names only constraints: quality-dominant presets, hard limits are separate (T60), cold-start priors come later from user configuration and host capabilities/pricing (T62).

**Decision:** Quality and reliability scores are the aggregated means directly. Cost and latency scores are normalized relatively across the candidates on the ballot — cheapest/fastest scores 1, most expensive/slowest 0, midpoints proportionally between, and equal (or single-candidate) values all score 1 — so no invented normalization anchors or config surface are needed and the utility stays on one comparable 0–1 scale. Evidence-free dimensions are dropped per candidate and the remaining preset weights renormalized, so utility reflects only what is known; a candidate with no evidence anywhere scores 0 and keeps its input order among equally evidence-free candidates, which is the gap T62's priors fill. Each dimension's preset weight is additionally discounted by its profile-backoff level weight (per the earlier aggregation decision), which only matters when dimensions sit at different levels. Scoring is mean-based: ESS and uncertainty are surfaced in the ranked output for the confidence floor (T62) and receipts (T21), not folded into scores.

**Consequences:** Adding or removing a candidate can shift others' cost/latency scores — acceptable because ranking is always computed over one fixed ballot, and receipts expose the underlying means so relative scores stay auditable. Utility 0 is "nothing known", not "known bad"; downstream consumers must read contributions, not utility alone, until priors exist. Deterministic tie behavior is exact-utility ties preserving eligibility input order; near-equal floating-point utilities may order arbitrarily but deterministically.

## 2026-09-06 — Cold-start priors fill only evidence-free dimensions as sampleCount-0 coarsest-level estimates

**Status:** Accepted

**Context:** T62 adds the design's cold-start priors: "from user configuration and OpenCode model capabilities/pricing". Priors had to join a pipeline whose dimensions are on mixed scales (0–1 quality/reliability, USD cost, ms latency) and whose utility drops evidence-free dimensions before renormalizing. Config had to stay honest about what a prior is: a user judgment encoded before any evidence exists, never a recorded signal.

**Decision:** Priors are per-dimension optional estimates on an exact provider/model/variant, stored in `routing.priors` and validated against `MODEL_RANKING_CONSTANTS.dimensionOrder` (quality/reliability in 0–1, cost/latency non-negative). Ranking injects a prior only where the loaded summary has no mean for that dimension — recorded evidence always wins, dimension by dimension. A prior estimate carries `backoffLevel: 3` (the coarsest weight, 0.25, so measured beats assumed even across profiles) and `sampleCount: 0` / `decayedWeight: 0`, which doubles as the downstream marker distinguishing prior-backed from evidence-backed contributions. Cost/latency priors participate in the existing relative normalization, so published pricing becomes a ranked prior without new scoring code. Duplicate prior identities are rejected rather than last-wins. Priors are not counted as signals (`consideredSignalCount` untouched).

**Consequences:** A candidate with priors on every dimension still loses a same-preset comparison against equal-mean exact-profile evidence, by design. The `sampleCount > 0` marker is now a load-bearing contract: T62's confidence floor and T21's receipts read it instead of adding a separate source flag. Renormalization cancels the coarse-level discount when *all* contributing dimensions share it (pure prior-backed utility = plain preset-weighted prior average), which keeps cold-start ordering interpretable.

## 2026-09-06 — Evidence gates label the recommendation; confidence floor means real-evidence weight share

**Status:** Accepted

**Context:** The design requires "configured minimum evidence, a confidence floor, and a utility margin over the current model" before a recommendation may act automatically, but the per-dimension uncertainty from T20 lives on mixed scales (a 0.01 standard error is huge for quality, tiny for latency in ms), so a single absolute uncertainty floor cannot span dimensions. V1 is recommendation-only: it must display the best eligible option and why even when evidence is thin.

**Decision:** `recommendModel()` (src/core/model-recommendation.ts) always recommends the top-ranked eligible candidate — the gates label the recommendation, they never suppress or replace it. Three deterministic gates: `min-evidence-samples` (total real sampleCount behind the winner's utility), `confidence-floor` (share of the winner's contributing utility weight resting on real evidence rather than priors — scale-free, and the cold-start-relevant meaning of confidence), and `utility-margin` (winner utility minus the host model's utility when the host model is eligible; with no comparable current model the gate passes vacuously with `actual: null`, because the hard filters already bind every candidate on the ballot). Defaults in config (`5 / 0.5 / 0.05`) are explicit pre-benchmark placeholders pending T22's manual approval. The winner's per-dimension contributions are returned with the recommendation so receipts (T21) can render the "why" without re-ranking.

**Consequences:** T23 (automatic routing) can reuse the gate verdicts as-is; T63's synthetic replay validates this exact semantics; T22 may revise thresholds and even the confidence definition without changing the pipeline shape. Known tradeoff: samples concentrated on cost alone can pass the confidence floor while quality rests on priors — the sample-count gate bounds that only partially, so T22/T63 should revisit whether a quality-specific rule is needed before automatic routing is enabled.

## 2026-09-06 — V1 routing candidates come straight from the allowlist; privacy policy is "any" at the boundary

**Status:** Accepted

**Context:** T21 wires `recommendModel()` into the OpenCode `chat.message` flow. The T60 hard filters expect host-reported availability and observed cost/latency estimates on each candidate, and a global privacy policy ("local-only" or "any"), but OpenCode exposes no runtime availability probe at message time (that is T65's model-mutation probe territory), evidence-backed estimates are not loaded until ranking (after filtering), and the config schema carries no global privacy-policy field — only per-allowlist-entry `privacy`.

**Decision:** The adapter (src/opencode/routing-receipt.ts) builds routing candidates directly from the configured allowlist with `available: true` — the allowlist is the user's authoritative curation, and an entry the user configured is by definition offered to the host. No observed cost/latency estimates are attached at the boundary, so hard cost/latency limits are carried through but bind only once a future stage supplies known estimates. The privacy policy passed to the filters is `"any"` in V1; per-entry `privacy` remains user curation, and private mode already disables routing entirely upstream. Receipts are computed for both `recommendation-only` and `automatic` config modes — automatic is display-only until T23/T65 wire mutation — and are skipped under private mode, a disabled routing toggle, `mode: "disabled"`, or an empty allowlist.

**Consequences:** T65 should replace the hardcoded `available: true` with probe-derived availability, and a global privacy policy may need a config surface before T23 enables automatic routing (until then the setting would only ever suppress display, never mutation). The empty-allowlist skip keeps unconfigured installs silent instead of emitting a null-recommendation receipt per message. The receipt surface is per-session state plus the `swe_factory_get_recommendation` tool plus an info diagnostic whose summary uses key=value pairs — diagnostics path redaction blanks slash-joined model paths, so model identity must not be written as `provider/model/variant`.

## 2026-09-06 — Lesson usage tracking is day-granular, adapter-written, and the digest's "unused" is version-scoped

**Status:** Accepted

**Context:** T24 requires a "stale, unused, duplicate, and conflict" maintenance digest, but nothing in the store recorded lesson usage — retrieval produced only ephemeral per-injection receipts — so "unused" was uncomputable. The digest needed a decision on where usage is written, at what granularity, and what "unused" means for a lesson with multiple superseded versions.

**Decision:** Migration 5 adds `lesson_retrieval_hits (lesson_id, version, retrieved_day)` with PK `(lesson_id, version, retrieved_day)`; usage is recorded via `recordLessonRetrievalHits()` (src/core/lesson-usage-tracking.ts) with `INSERT OR IGNORE`, so repeat hits collapse per UTC day and the table stays bounded while preserving the last-retrieved day the digest needs. The OpenCode plugin writes hits for lexically retrieved lessons after `chat.message` retrieval inside a fail-open try/catch — core retrieval stays side-effect-free, CLI inspection doesn't count as usage, and tracking failures never break injection. The digest (src/core/lesson-maintenance-digest.ts) flags a lesson "unused" only when its *active version* is older than the unused threshold (so a fresh supersession resets the clock) and has no hit on that version inside the window; "stale" keys off `lessons.updated_at`. Overlap detection reuses the candidate-detection thresholds (`DUPLICATE_BODY_THRESHOLD` / `MINIMUM_OVERLAP_THRESHOLD`) and the shared `lexical-overlap.ts` helpers (extracted from T35/T45's now-three private copies), but only compares lessons within the same `(scope, project_id)` group — cross-scope and cross-project pairs are out of scope for V1 — and the O(n²) scan is bounded by `maxPairwiseLessons` with an explicit `pairwiseScanTruncated` flag.

**Consequences:** T72 can schedule digest generation directly; T85's retrieval boosts could later reuse the hit table if needed (out of scope today). Known tradeoffs: retrieval-hit ≠ packed-into-context (suppressed/budget-excluded lessons still count as "used"), which is acceptable for maintenance triage; day granularity cannot answer "how many times today". Digest thresholds (90 stale / 30 unused / 1000 pairwise cap) are explicit placeholders pending live-use review, like the other pre-benchmark defaults.

## 2026-09-07 — Fuse confirmed lessons by rank and treat known applicability mismatches as exclusions

**Status:** Accepted

**Context:** T85 must combine FTS5 and cosine candidates without comparing incompatible raw scores, preserve project-over-global precedence, and make loose lesson applicability metadata deterministic. V1 retrieves only active confirmed lessons from one authoritative source, so numeric confirmed/source-authority boosts would add the same constant to every candidate and imply ranking signals that do not exist.

**Decision:** Fuse bounded lexical and semantic lists with reciprocal-rank fusion using `k = 60`. Project scope remains an absolute ordering tier rather than a numeric boost. Within a scope, add a pre-benchmark `0.005` boost for each exact known applicability dimension: activity, domain, complexity, and stack. `taskTypes` aliases activity and `languages` aliases stack, so aliases cannot double-count one dimension. When both a supported lesson constraint and its task-profile dimension are known, disjoint values make the lesson inapplicable and remove it before final ranking; missing, malformed, or unrecognized applicability metadata does not restrict the lesson. Comparisons are trimmed and case-insensitive. Semantic runtime startup is lazy and fail-open: a cold or failed semantic channel yields lexical results, and the retrieval receipt records semantic availability.

**Consequences:** Hybrid scores remain inspectable and deterministic while project precedence cannot be overturned by channel support or applicability boosts. T50 must benchmark the RRF and boost constants before they are treated as tuned values. The applicability contract is intentionally limited to dimensions the deterministic task profiler can supply; adding new restrictive keys requires an explicit contract change rather than generic JSON matching.

## 2026-09-07 — Benchmark harnesses live in benchmarks/, not the publishable core; embedders load lazily through a factory

**Status:** Accepted

**Context:** T50 placed the confirmed-lesson retrieval harness in src/core and exported it from the package index, but the harness is a terminal measurement surface — nothing in the library, adapter, or CLI calls it. Keeping it in core also forced `createLocalLessonEmbedder()` (and therefore the Transformers.js runtime) to exist as a direct dependency of the harness call, and real runs revealed the runtime needs an explicit dtype (`q8`) and `allowLocalModels` to load the checksum-verified artifacts deterministically.

**Decision:** Benchmark harnesses, corpora, and runners live under benchmarks/ with tests importing them from there; core exports only library surface. The retrieval harness takes a lazy `createEmbed` factory instead of an `embed` function, so embedding setup (artifact verification, runtime load) happens only when a run actually starts, and the run script owns the artifact-directory flag. The embedder pins `PINNED_EMBEDDING_DTYPE = "q8"` alongside the pinned model revision, so artifact bytes, revision, and quantization are pinned together. The T63 synthetic routing replay was built to this layout from the start.

**Consequences:** The package's public API shrinks (retrieval-benchmark exports removed from core); any external consumer of the harness would import from the benchmarks path, which is not published — acceptable because it is a repo-local measurement surface. Real benchmark runs remain network-free by construction (`allowRemoteModels = false`) and require checksum-verified artifacts. Future benchmarks (T92 acceptance scenarios aside) should follow the same placement and lazy-factory pattern.

## 2026-09-07 — Session-selected variants are threaded into recorded execution profiles

**Status:** Accepted

**Context:** Evidence aggregation attributes outcome signals to an exact provider/model/variant, but OpenCode 1.18.27's `AssistantMessage` (the completion event the plugin captures) carries no variant field, so recorded execution profiles had `variant = NULL`. Because allowlist candidates always carry a non-null variant string, the exact-variant evidence match in `loadModelEvidenceItems` could never aggregate plugin-captured evidence — making the V1 evidence loop unreachable through live use and blocking T92's acceptance scenario.

**Decision:** The plugin remembers the variant each session selected for generation (`chat.message` input's `variant`) and threads it into that session's subsequent assistant-completion execution profiles. This mirrors how the routing receipt already resolves the host-selected model's variant, and it is the adapter's best available source of generation-time variant truth in the supported OpenCode version. Sessions that never select a variant still record `variant = NULL`, matching nothing until a future compatibility probe (T65) supplies exact variants.

**Consequences:** Plugin-captured evidence can now back recommendations for exact model/variant pairs. If a session's variant changes between message turns, the next completion records the latest selection; concurrent generations within one session with different variants are out of scope for V1 (evidence lands under the most recently selected variant).
