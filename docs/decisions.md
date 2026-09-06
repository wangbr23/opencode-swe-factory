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
