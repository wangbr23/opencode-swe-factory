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

## 2026-09-05 — Added CLI interactive lesson-review command

Implemented the `review` CLI command for human lesson candidate review. The list mode (`review`) shows all non-expired pending candidates with scope, title, and expiry. The interactive mode (`review <id>`) displays full candidate details (title, body, rationale, scope, secret scan status), runs duplicate/conflict detection against existing confirmed lessons, displays any overlapping matches with relation classification and body overlap percentage, and prompts for a decision (approve/reject/defer/quit). Supports `--acknowledge-secret-risk` for candidates with low-confidence secret findings. Added `listPendingLessonCandidates` to the core for querying pending candidates with optional expiry filtering. Added 13 behavior tests covering listing, empty state, approval, rejection, deferral, quit, overlap display, no-overlap display, secret acknowledgment warning and flag, nonexistent candidate, null readline, and invalid input retry. Verification passed with 158 tests plus typecheck and build.

## 2026-09-05 — Added CLI lesson search and inspection commands

Implemented `search <query>` and `lesson <id>` CLI commands. The search command performs lexical retrieval over confirmed lessons via existing FTS5 infrastructure, supports multi-word queries (positional args joined), and accepts `--project <id>` to filter by project scope (defaults to global+project retrieval). The lesson command inspects a specific confirmed lesson showing scope, version count, timestamps, and full active version content. Added `inspectLesson()` to lesson-supersession reusing existing private helpers (findLessonRow, toSnapshot, getLessonVersionRow). Added `LessonInspection` type. Added 10 behavior tests covering search results, empty matches, multi-word queries, project filtering, missing query argument, lesson inspection, project scope display, nonexistent ID, missing ID argument, and version number display. Verification passed with 168 tests plus typecheck and build.

## 2026-09-05 — Added expiring pending-candidate cleanup

Implemented `cleanupExpiredCandidates()` which deletes pending lesson candidates whose `expires_at` is at or before the provided (or current) time. Returns the count and IDs of deleted candidates. Uses a two-step approach: first queries for expired IDs, then batch-deletes, so the caller gets the deleted IDs in the result. Added `CleanupExpiredCandidatesInput` and `CleanupExpiredCandidatesResult` types. Added 7 behavior tests covering expired deletion, non-expired preservation, empty table, mixed set, correct ID tracking, default time, and boundary-at-expiry. Verification passed with 175 tests plus typecheck and build.

## 2026-09-05 — Added CLI configuration and feature-toggle controls

Implemented `config`, `config get <path>`, `config set <path> <value>`, and `toggles` CLI commands. The `config` command dumps the full configuration as JSON; `config get` reads a dot-path value (scalars printed directly, objects as JSON); `config set` writes a dot-path value with automatic type coercion (boolean, number, null, string) and validates the resulting config through the existing `resolveConfig`/`savePackageConfig` pipeline, rejecting invalid values. The `toggles` command shows private-mode status and resolved feature toggles per scope (global/project/session) using `featureTogglesForScope`, including routing status derived from config mode. Added `config` to the multi-word command parser. Added 18 behavior tests covering show-all, get (top-level, nested, object, unknown path, missing arg), set (boolean, string, nullable number, null, invalid value, unknown path, missing value), toggles (default, disabled features, private mode, routing disabled), and unknown subcommand. Verification passed with 193 tests plus typecheck and build.

## 2026-09-05 — Added CLI lesson-supersession command

Implemented `supersede <lesson-id>` CLI command that replaces a confirmed lesson's active version with new content. Requires `--title`, `--body`, and `--rationale` options for the replacement draft. Shows the current active version before applying the change for confirmation context, preserves the original version's applicability and provenance metadata, and prints the version transition (old version superseded, new version number). Uses the existing `supersedeLesson()` core function which handles immutable version insertion, supersession marking, and active-version pointer update in a single transaction. Added 9 behavior tests covering successful supersession, content verification via inspection, nonexistent lesson, missing lesson ID, missing each required option, multiple sequential supersessions, and metadata preservation. Verification passed with 202 tests plus typecheck and build.

## 2026-09-05 — Implemented confirmed-lesson project-over-global precedence

Modified lexical retrieval ordering to rank project-scoped lessons above global lessons. The SQL `ORDER BY` now sorts by scope priority (project = 0, global = 1) first, then by BM25 score, then by lesson ID for deterministic tiebreaking. This means when both a project lesson and a global lesson match a query, the project lesson always appears first in results — even if the global lesson has a stronger BM25 score. Within each scope tier, BM25 ordering is preserved. The limit is applied after this ordering, so a `limit: 1` query returns the best project match when one exists. Added 5 behavior tests covering equal-relevance precedence, stronger-global-BM25 precedence, global-only ordering, within-project BM25 ordering, and limit interaction with precedence. Verification passed with 207 tests plus typecheck and build.

## 2026-09-05 — Implemented unresolved lesson conflict suppression during retrieval

Added `suppressConflictingLessons()` as a post-retrieval filter that removes lower-ranked lessons whose body text conflicts with higher-ranked lessons in the same result set. Conflict is detected via Jaccard similarity on extracted body terms, using the same `MINIMUM_OVERLAP_THRESHOLD` (0.15) as duplicate detection. Results are processed in rank order (project-scoped first per T45 precedence), so project lessons always win over conflicting global lessons. The function returns both kept and suppressed results with the conflicting lesson ID and overlap score for receipt/audit purposes. Supports a custom threshold override. Added 10 behavior tests covering non-conflicting preservation, lower-rank suppression, project-over-global conflict resolution, below-threshold non-suppression, custom threshold, empty/single input, multiple conflicts against one lesson, overlap reporting, and rank-order preservation. Verification passed with 217 tests plus typecheck and build.

## 2026-09-05 — Implemented heading-aware Markdown chunking with stable citations

Added `chunkMarkdown()` that splits Markdown content into chunks at heading boundaries. Each chunk carries a heading path (e.g. "Setup > Dependencies") for stable citation, plus 1-indexed start/end line numbers for source traceability. The heading path is built from a stack that tracks nested heading levels and resets when a higher-level heading appears. Content before the first heading uses "/" as its heading path. Sections exceeding `maxChunkLines` (default 200) are split into numbered parts (e.g. "Section [part 1]"). Added types `MarkdownChunk`, `ChunkMarkdownInput`, `ChunkMarkdownResult`. Added 13 behavior tests covering heading-boundary splitting, nested heading paths, heading stack reset, pre-heading content, oversized section splitting, line number preservation across parts, empty content, no-headings content, heading-only documents, skipped heading levels, 1-indexed lines, code fences with hashes, and blank lines between sections. Verification passed with 230 tests plus typecheck and build.

## 2026-09-05 — Added CLI diagnostics and compatibility-status command

Implemented `status` CLI command that displays managed paths (database, config, data, cache, backups), database health (existence, migration status), OpenCode compatibility manifest (minimum and tested versions), a health report aggregating component checks, and recent diagnostic entries. Uses `createHealthReport()` for health aggregation and `readLocalDiagnostics()` for diagnostic history. Shows the last 5 diagnostic entries when any exist. Added 6 behavior tests covering existing database, non-existent database, compatibility manifest display, paths section, empty diagnostics, and health check components. Verification passed with 236 tests plus typecheck and build.

## 2026-09-05 — Added CLI project-relink command

Implemented `relink <project-id>` CLI command with `--path` and `--remote` options that explicitly changes a project's primary path and/or remote association. This is the deliberate operation referenced when `resolveProjectIdentity` refuses a conflict. Added `relinkProject()` to the project-identity core module — it updates the project row and adds new path/remote aliases in a single transaction, rejecting conflicts where the target path or remote is already used by another project. The CLI shows the before/after state for changed fields and confirms the relink. Added `RelinkProjectInput` and `RelinkProjectResult` types. Added 8 behavior tests covering path update, remote update, combined update, missing project ID, missing options, nonexistent project, path conflict, and same-path no-op. Verification passed with 244 tests plus typecheck and build.
