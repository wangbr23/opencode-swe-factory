# Governed Memory and Model Recommender V1

**Date:** 2026-09-05

**Status:** Accepted

## Context

The original design combined approved lessons, project-document retrieval, broad memory infrastructure, outcome evidence, and automatic model routing. Review of [Claude-Mem](https://github.com/thedotmack/claude-mem) showed that automatic session capture, AI compression, history search, context injection, a viewer, and multi-host integrations are already available in a mature Apache-2.0 project that supports OpenCode.

Rebuilding that complete category would not create enough user value to justify an independent package. However, Claude-Mem's core model is episodic: it captures prompts, assistant messages, and tool activity, sends observations to a configured model provider for compression, and stores generated observations. Its documented extension point is a worker HTTP API rather than an importable memory library. Its OpenCode adapter and database do not provide human approval, immutable lesson supersession, task-outcome attribution, or evidence-based model recommendations.

The product therefore narrows around normative memory and measured routing evidence rather than competing as another general session-memory product.

## V1 Outcomes

V1 must prove two end-to-end outcomes:

1. A human-approved correction is retrieved, cited, and applied to a similar task in a later OpenCode process without retaining the raw conversation.
2. Privacy-bounded execution evidence changes a model recommendation for a compatible task profile, with the evidence and reason inspectable by the user.

Work that does not directly support one of these outcomes, their privacy boundary, or basic recovery is not part of V1.

## Product Boundary

V1 includes:

- Structured lesson candidates with explicit approve, edit, reject, and defer decisions.
- Immutable confirmed lesson versions, supersession, duplicate/conflict review, and project/global scope.
- Scoped lexical and local semantic retrieval over confirmed lessons.
- Task-start context packing, citations, conflict suppression, and compact receipts.
- Redacted task profiles, exact execution profiles, objective and explicit outcome signals, decayed evidence, and deterministic recommendations.
- Recommendation-only OpenCode integration. The user-selected model remains authoritative.
- Secret admission controls, private mode, local diagnostics, hard deletion, export, backup, and restore for package-owned data.
- A tool-neutral core, CLI, and one OpenCode adapter without a daemon or network service.

V1 excludes:

- General transcript or session-history capture and search.
- Raw prompt, response, assistant-message, or tool-output retention.
- Curated project-document chunking, indexing, or retrieval beyond OpenCode's normal instruction/context behavior.
- Retrieval at inferred phase transitions.
- Automatic model mutation, routing overrides, and controlled exploration.
- A web viewer, HTTP service, hosted storage, telemetry, and non-OpenCode adapters.
- A required Claude-Mem installation.

## Architecture

Keep the existing single-package boundary and local SQLite store. The store remains necessary because confirmed lesson state and routing evidence have different trust, lifecycle, and privacy requirements from Claude-Mem observations. Do not write into Claude-Mem's database or depend on its internal schema.

At each top-level or delegated task boundary, resolve private mode before processing text, build a redacted task profile, retrieve applicable confirmed lessons, suppress unresolved conflicts, and pack results into the primary system block under a fixed budget. Complete the task using the host-selected model, then derive allowed outcome signals from transient hook data and discard raw outputs.

Aggregate evidence by exact model/variant and compatible task profile. V1 emits a recommendation and reason but never mutates the active model. Recommendation quality is validated with synthetic replay and live shadow use before any automatic behavior is considered.

Semantic retrieval remains justified for paraphrased corrections, but its corpus is limited to approved lesson versions. Project-document embeddings and document/lesson rank fusion are not required in V1.

## Claude-Mem Interoperation

Users may run Claude-Mem beside this package when they want episodic session recall. The products should remain independently operable:

- Claude-Mem answers "what happened before?"
- This package answers "what approved rule applies, and which model has evidence for this task?"

After V1 evidence is reviewed, an optional read-only bridge may query Claude-Mem's documented HTTP API. Such a bridge must be explicitly enabled, fail open when the worker is absent, treat returned observations as untrusted reference material, and never make them confirmed lessons without human approval. No bridge work starts before the V1 evidence gate.

## Rollout

1. Finish the confirmed-lesson vertical slice with lexical retrieval, duplicate/conflict handling, approval tools, task-start injection, and cross-process acceptance.
2. Add local semantic retrieval only for approved lessons and validate paraphrased correction recall.
3. Finish task outcome capture, aggregation, eligibility, ranking, and recommendation-only integration.
4. Validate recommendation changes through synthetic replay and a live acceptance scenario.
5. Review both V1 outcomes manually before approving any document retrieval, Claude-Mem bridge, phase retrieval, or automatic model-routing work.

## Consequences

- The existing document schema and source-admission implementation remain valid groundwork but are dormant in V1.
- Generic memory features are delegated to existing products instead of recreated.
- The independent store and adapter remain smaller than a Claude-Mem fork or companion that shares its runtime.
- Privacy guarantees remain enforceable because package-owned persistence never requires broad session capture or a compression-provider call.
- Automatic routing is no longer required to declare V1 useful; recommendation mode is the validated routing outcome.
