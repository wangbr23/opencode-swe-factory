# Journal

Append-only. One entry per work session. Newest at the bottom. Do not edit past entries; if something is wrong now, say so in a new one.

## 2026-09-03 — project created

Initialized project scaffold (AGENTS.md, CLEANCODE.md, decisions log, and TODO). Nothing built yet.

## 2026-09-03 — Defined adaptive memory and model routing

Completed a discovery interview and confirmed the product scope, trust boundaries, memory lifecycle, retrieval approach, model-routing policy, OpenCode integration, safety controls, V1 acceptance scenarios, and explicit experiments. Saved the result in the [coding memory and model router spec](specs/coding-memory-model-router.md).

## 2026-09-03 — Reviewed the coding memory and router design

Grounded and drafted the [coding memory and model router design](designs/2026-09-03-coding-memory-model-router.md), obtained an independent read-only review, resolved its four judgment calls with the user, and revised the design for tested-version OpenCode compatibility, safe system injection, queued-message handling, privacy-first deletion, tiered secret scanning, and evidence-gated routing.

## 2026-09-05 — Narrowed V1 after evaluating Claude-Mem

Compared the product and implementation boundary with Claude-Mem/Grok Mem, including its OpenCode adapter, worker HTTP API, SQLite observation model, provider-based compression, privacy controls, package exports, and Apache-2.0 boundary. Chose not to duplicate general session memory or depend on Claude-Mem's runtime. Revised V1 around two differentiated outcomes: cross-process recall of human-approved corrections and evidence-driven model recommendations. Deferred curated-document retrieval, phase-transition retrieval, automatic model mutation, and exploration behind a manual evidence gate. No runtime code changed during this review.

## 2026-09-05 — Added scoped lexical lesson retrieval

Implemented FTS5 retrieval over active confirmed lesson versions with current-project/global isolation, deterministic BM25 ordering, bounded results, literal-token query hardening, and strict metadata parsing. Added behavior coverage for scope isolation, inactive and superseded versions, hostile FTS punctuation, deterministic limits, and malformed stored metadata. Verification passed with 134 tests plus typecheck and build. The existing approval flow still needs the planned duplicate/conflict and commit work before it can create multiple independent lessons in one scope.

## 2026-09-05 — Added duplicate and conflict detection for lesson candidates

Implemented pre-approval detection that retrieves lexically nearby confirmed lessons and classifies each as a potential duplicate (body Jaccard >= 0.5) or potential conflict (topically related but different content, body Jaccard >= 0.15). Uses the existing FTS retrieval as a pre-filter, computes term-level Jaccard similarity on title and body independently, supports excluding specific lesson IDs (for edit-in-place flows), and sorts matches by body overlap descending with deterministic tiebreakers. Added 11 behavior tests covering near-duplicate classification, conflict classification, scope isolation, exclusion filtering, threshold filtering, ordering, exact duplicates, inactive lessons, cross-scope detection, and punctuation-only input. Verification passed with 145 tests plus typecheck and build.
