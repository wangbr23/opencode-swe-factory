# Agent-Driven Lesson Supersession

**Date:** 2026-09-10

**Status:** Draft — revised after independent Codex review (2026-09-10)

## Problem

When a new lesson should replace an existing one, the override machinery exists in core (`supersedeLesson`, `resolveOverlap`) but nothing agent-facing can invoke it. A real case (2026-09-10) required a one-off script. Three gaps compound each other:

1. **No action path.** The adapter exposes only propose/commit tools; `resolveOverlap` (src/opencode/approval-flow.ts:98) is test-only. A human wanting an override must leave the conversation.
2. **Lexical-only detection.** `detectLessonDuplicatesAndConflicts` matches by Jaccard on title/body terms. A corrected lesson phrased differently from a months-old contradicting lesson can fall under the threshold, and neither agent nor human remembers the old lesson exists.
3. **Insufficient approval evidence.** The card lists overlaps as `[relation] "title" (id, vN, scope) — N%` only. A title is not enough for a human to judge replacement from evidence rather than memory.

The design goal: **nobody's memory is load-bearing.** Every contradiction surfaces at proposal time with enough content to judge, and resolves in the same approval interaction — with the honest caveat that semantic coverage is best-effort (see Cold-start semantics).

## Non-Goals

- Per-lesson delete or deactivate (tombstone) operations.
- Retrieval-time contradiction surfacing.
- Automatic supersession — overrides stay human-gated like every lesson mutation.
- Extending the maintenance digest's pairwise scan to embeddings.
- Extending project authorization to the existing commit tool (follow-up; see Project authorization).

## Design

### 1. Core operation: `resolvePendingLessonOverlap`

Resolution becomes one core operation in src/core/lessons (new `lesson-overlap-resolution.ts`) — not an adapter handler with guards bolted on. The operation owns the whole flow inside a **single transaction**:

1. Load the pending candidate (`pending_lesson_candidates.draft_json`, shape `{ draft, ... }`).
2. Validate: candidate not expired; scope/project of candidate and target lesson match exactly; project-scoped candidate and target match the **caller's project** (authorization, not just scope-match — without it an agent in project A could resolve project B's pending candidate against B's lesson).
3. If the stored candidate carries low-confidence secret findings, require `acknowledgedSecretRisk` — same gate as `reviewLessonCandidate` approve. The draft was scanned at propose time; supersession publishes the same content.
4. `supersedeLesson` on the target (new immutable version carrying the candidate draft) **and** reject the candidate, in one transaction. Today's `resolveOverlap` runs two separate transactions; a reject failure after supersession (e.g. the candidate expired mid-review) would leave the old lesson replaced while the candidate stays approvable — a duplicate waiting to happen.

Result reuses `ResolveOverlapResult`. No draft override parameters: edited/merged content goes through edit-and-repropose first, then resolves with the new candidate.

The OpenCode tool `swe_factory_resolve_overlap` (registered in `composePluginHooks` next to `swe_factory_commit_lesson`, src/opencode/plugin.ts:445) is a thin wrapper: args `candidateId`, `overlappingLessonId`, `acknowledgedSecretRisk?`; it passes the session's `projectId` for authorization and returns the formatted outcome. Posture matches the commit tool — no private-mode gate, because resolution is post-proposal human review of an already-scanned, already-persisted candidate and processes no new task text. A test must cover "candidate created before private mode, resolved while private".

### 2. Approval card carries the evidence and the option

`formatApprovalCard` (src/opencode/approval-flow.ts:18):

- For each overlap, render the overlapping lesson's body as a **bounded preview** (~800 chars) between strong delimiters (`---`), with a pointer to `review <candidateId>` for the full text. Lesson bodies have no stored size cap (candidate parsing enforces only non-empty strings), so the card must not assume short bodies; delimiters also fence stored lesson text from the card's own instructions (prompt-injection hygiene).
- Supersede options are offered **only for same-scope, same-project overlaps** — the only targets the resolution operation will accept. Cross-scope overlaps (e.g. a global lesson duplicating a project candidate, which occurred in practice on 2026-09-10) render as evidence with "approve alongside" framing, never as an option the guard would reject.
- Semantic-only matches render as `[related]` with their similarity — they carry weaker evidence than textual overlap, so they get no Supersede action by default; the human reads both bodies and decides (Approve / Reject remain available).

### 3. Detection: semantic augmentation

`detectLessonDuplicatesAndConflicts` (src/core/lessons/lesson-duplicate-detection.ts:38) gains an async semantic pass, unioned with the unchanged lexical pass:

- Semantic hits come from `retrieveConfirmedLessonsSemantically` (same project scoping, same retrieval limit, injected `embed` function — core stays runtime-agnostic per the injectable-embedder decision).
- Lexical hits keep the existing `duplicate` / `potential-conflict` relations.
- **Semantic-only hits get a new `related` relation** with their own similarity field and a pre-benchmark cutoff constant (placeholder pending benchmark, like the other defaults) — they must not inherit `classifyRelation(bodyOverlap)`, which would mislabel weak-Jaccard semantic neighbors as conflicts.
- Dedupe by `lessonId` (lexical entry's metadata wins).

**Cold-start semantics (explicit):** the embedder is the adapter's lazily-started lesson embedder (`deps.createLessonEmbedder`, plugin.ts:188-199). That pattern does **not** await startup, so the first proposal of a session may be lexical-only while the model loads. This design keeps the non-blocking posture (consistent with the fail-open retrieval decisions) rather than making model load part of proposal latency. Lexical detection is the guaranteed floor; semantic `related` hits are additive; the maintenance digest remains the backstop for anything missed. The doc does not claim every contradiction surfaces on every proposal.

### 4. Wire the embedding indexer in the adapter

Review finding (verified): `createLessonEmbeddingIndexer` has **no production caller** — the plugin only builds a query-time embedder, so stored lesson vectors never accumulate outside tests/benchmarks and every semantic channel (retrieval and detection alike) is silently empty in normal installs.

The adapter must schedule the existing injectable indexer using the same adapter-owned lazy embed factory: create the indexer once with `createLocalLessonEmbedder` wiring, and schedule a run after lesson commit/resolution (and opportunistically at session start, fail-open). Without this, the semantic half of this design — and the existing hybrid retrieval — never sees vectors in production. Artifacts remain the user-installed, checksum-verified pin; absence of artifacts keeps everything lexical.

### 5. Digest surfacing: CLI `maintenance` command

The background digest only writes a diagnostic line (src/opencode/background-scheduler.ts:119-124) that says "Inspect via the CLI" — but no CLI command renders the digest. Add a `maintenance` command printing `buildLessonMaintenanceDigest` sections (stale, unused, duplicates, potentialConflicts) with lesson ids and titles. Core already exports the builder; no core change. Retained despite review pushback: it is the missing human surface for the backstop touchpoint, and it is cheap.

## Data Flow (happy path)

1. Agent proposes a corrected lesson → `handleProposeLesson` → detection (lexical ∪ semantic) finds the months-old contradicting lesson regardless of age or wording (semantic pass best-effort).
2. Card renders both bodies (bounded preview); human reads and picks "Supersede `<old-lesson-id>`".
3. Agent calls `swe_factory_resolve_overlap(candidateId, overlappingLessonId)` → one core transaction supersedes the old lesson's active version with the candidate draft and rejects the candidate.
4. All retrieval paths already filter `superseded_by_version IS NULL` — the old content becomes unretrievable with zero retrieval changes.

## Edge Cases

| Case | Behavior |
| --- | --- |
| Candidate expired | Transaction fails atomically → `{ status: "failed" }` with expiry message |
| Overlapping lesson superseded mid-review | `supersedeLesson` refuses (active version already superseded) → failed, nothing mutated |
| Candidate/lesson scope mismatch | Failed before any mutation; card never offered a Supersede option for it |
| Target lesson belongs to another project | Authorization failure before any mutation (session project must match project-scoped candidate/target) |
| Low-confidence secrets in draft | Require `acknowledgedSecretRisk`, same as approve |
| Embedder absent, cold, or throws | Lexical-only detection; proposal unaffected |
| Embedding index empty (pre-wiring installs) | Semantic channels empty; lexical floor applies; indexer wiring closes this |
| Approve chosen despite overlap listing | Unchanged behavior (both lessons active); digest surfaces the conflict later |

## Test Plan

- Unit: `resolvePendingLessonOverlap` — happy path uses the stored draft verbatim; missing candidate; expired candidate (nothing mutated); scope-mismatch guard; cross-project authorization; secret acknowledgment gate; atomicity (a forced failure after supersede leaves both the lesson and the candidate untouched).
- Unit (card): bounded body preview with delimiters; supersede option appears only for same-scope same-project overlaps; `related` rendering for semantic-only hits.
- Detection: semantic-only hit surfaces as `related` with zero lexical overlap; embedder failure degrades to lexical-only; dedupe keeps lexical metadata.
- Indexer: scheduled after commit/resolution; failure is fail-open and reported as an outcome, never thrown.
- Plugin test: tool registered, args validated, session `projectId` passed through; execute resolves and the candidate disappears from `review`; private-mode resolution of a pre-existing candidate succeeds.
- Acceptance: extend `tests/acceptance/lesson-isolation.test.ts` — propose a differently-phrased correction of a seeded months-old lesson, card lists it, resolve, then hybrid recall returns only the new content and never the superseded body.

## Risks

- **Semantic coverage is probabilistic, not guaranteed.** Cold-start, artifact absence, or an unfired indexer make a given proposal lexical-only. The digest and card remain the backstops; the goal is "no memory required", not "semantic always runs".
- **`related` is a new relation vocabulary entry.** The card and any downstream consumers of `LessonOverlapMatch` must handle it; the digest keeps its own pairwise classification unchanged.
- **Project authorization asymmetry.** `swe_factory_commit_lesson` remains able to approve a candidate proposed under a different project (pre-existing posture). Resolving gets the guard now; extending it to commit is a deliberate follow-up so this design does not silently change existing tool behavior.

## Rollout

1. Core operation + guards + tests (no behavior change until wired).
2. Card changes (preview bounds, delimiters, per-target Supersede options, `related` rendering).
3. Tool registration + plugin tests.
4. Semantic detection pass + indexer wiring (independent toggle-free fail-open path).
5. `maintenance` CLI command (independent; can land any time).

## Deferred

- Surfacing digest items at session start (beyond CLI + diagnostic).
- Per-lesson deactivate/delete for tombstoning already-approved lessons (motivated in practice: scope corrections require tombstone pointer versions today).
- Semantic conflict detection inside the maintenance digest.