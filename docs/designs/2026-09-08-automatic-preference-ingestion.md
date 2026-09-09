# Automatic Preference-Lesson Ingestion Scope

**Date:** 2026-09-08

**Status:** Accepted (settles the T96 scope decision)

## Context

T96 asked whether the system should automatically detect lasting user preferences in conversation and turn them into lessons, and under what boundaries. Three sub-questions were open: whether utterances may be mined at all (privacy), whether a preference must repeat across sessions before a draft is proposed (repetition confidence), and how global-vs-project scope is chosen.

The existing pipeline already covers most of the flow end to end:

- The lesson-capture protocol injected with every lesson context block instructs the agent to propose a lesson on an explicit correction, praise, a standing preference, or a repeatedly-verified method, and requires presenting candidates through the question interaction (`src/opencode/` protocol text; design: [coding memory router](2026-09-03-coding-memory-model-router.md), "Lesson Capture And Approval").
- The proposal tool secret-scans the draft and blocks on high-confidence findings; low-confidence findings require explicit acknowledgment before approval (`handleProposeLesson`, `src/opencode/lesson-tools.ts:20`; `proposeLessonCandidate`, `src/core/lessons/lessons.ts:184`).
- Pending candidates store only the structured draft, are excluded from retrieval, expire after a review window, and are deleted on rejection (`src/core/lessons/lessons.ts`).
- The approval card displays the proposed scope, overlapping lessons, and the acknowledgment warning (`formatApprovalCard`, `src/opencode/approval-flow.ts:18`); Edit creates a replacement candidate rather than mutating an approved row.

Live-session feedback (2026-09-08 journal) showed the remaining risk is not missing infrastructure but detection reliability: a standing preference was once routed to a documentation file instead of a lesson proposal.

## Decision

**The ingestion flow is model-driven and approval-gated.** For any message the active agent recognizes as a lasting preference — stated once, explicitly:

1. The model recognizes the preference (no plugin-side deterministic pattern matching; phrasing varies too much for cue-based detection to be reliable).
2. The model drafts the lesson (generalized from the utterance, e.g. "Explain things simply by default") and proposes it through the existing proposal tool.
3. The plugin enforces the secret scan: high-confidence findings block the candidate outright; low-confidence findings require explicit acknowledgment on the card.
4. The candidate is presented through the approval card with Approve / Edit / Defer / Reject.
5. Only approval creates a durable confirmed lesson. Defer keeps it pending until expiry; Reject deletes the draft.

**One explicit statement is enough to propose.** There is no cross-session repetition threshold for explicitly stated preferences — the T96 idea of "cross-session repetition confidence" is dropped for this class of signal. The human approval card is the gate, so a false positive costs one Reject. Repetition-based confidence remains relevant only for implicit signals (repeated comparable success), which follow the existing design rule that automated outcomes may trigger a proposal only after repeated strong evidence — still approval-gated.

**Scope is model-proposed and card-editable.** The draft carries the model's inferred scope: global for interaction preferences ("explain things simply"), project for repo conventions ("keep folders granular"). The approval card displays the scope; the user edits it by choosing Edit, which creates a replacement candidate at the corrected scope.

**Privacy boundary (codified):** raw utterances are never persisted. The utterance text may appear only inside the candidate's structured draft (title, body, rationale, provenance) that the user reviews; nothing else from the message is stored. Rejected and expired drafts are deleted. This adds nothing new to the storage model — it restates the existing pending-candidate rules as the boundary that applies to preference ingestion specifically.

## Consequences

- No new pipeline, detector code, schema, or repetition-counter storage is required; the decision ratifies the existing flow as the required path for preferences.
- Detection quality is a prompt/protocol concern, not infrastructure. The known failure mode (preference captured into a doc instead of a lesson proposal) is addressed by protocol text, and acceptance scenarios should pin the happy path and the secret-block path.
- Because no repetition gate exists, the protocol must bias toward proposing on any explicit preference statement; over-proposal is absorbed by the card, under-proposal by silence.

## Non-goals

- Plugin-side deterministic preference detection.
- Persisting raw utterances or any message content outside the reviewed draft.
- Automatic durability for any class of lesson, including preferences.
- Repetition-counting infrastructure for explicit statements.

## Verification

An acceptance scenario (T97) exercises: an explicit preference statement proposes a global-scope draft; the card renders scope and overlaps; a secret-bearing draft is blocked; an Edit changing scope produces a replacement candidate; approval creates the confirmed lesson and rejection deletes the draft.
