import { suppressConflictingLessons } from "../core/lessons/lesson-conflict-suppression.js";
import { packLessonContext } from "../core/lessons/lesson-context.js";
import type { ResolvedFeatureToggles } from "../types/feature-toggle-types.js";
import type {
  ApplyInjectionResult,
  InjectionState,
  PendingInjection,
  PrepareInjectionInput,
  PrepareInjectionResult,
  RetrieveLessonsFn,
} from "../types/context-injection-types.js";

export type {
  ApplyInjectionResult,
  InjectionState,
  PendingInjection,
  PrepareInjectionInput,
  PrepareInjectionResult,
  RetrieveLessonsFn,
} from "../types/context-injection-types.js";

export const LESSON_PROPOSAL_PROTOCOL = [
  "## Lesson Capture Protocol",
  "",
  "A lesson is anything from this session that a future session should repeat or avoid: work that went well and should be repeated, or a mistake, correction, or expressed preference that should change how you work. Judge the substance, not the user's exact words.",
  "Bias toward proposing. Proposals are drafts awaiting human approval and expire if ignored, so a wasted proposal costs seconds while a missed lesson repeats the mistake. Recording something in repo docs, a journal, or a summary does not substitute for proposing it.",
  "When a lesson-worthy moment happens, propose it via the swe_factory_propose_lesson tool in the same turn, proactively — never wait to be asked. Never include secrets or credential-like content in a proposal.",
  "Immediately after a proposal returns, present it for approval via the question tool (or your environment's equivalent interactive ask) with Approve / Edit / Defer / Reject options. Never just list the candidate in text.",
].join("\n");

export function createInjectionState(): InjectionState {
  return { pending: new Map() };
}

export async function prepareInjection(
  state: InjectionState,
  toggles: ResolvedFeatureToggles,
  input: PrepareInjectionInput,
  retrieve: RetrieveLessonsFn,
): Promise<PrepareInjectionResult> {
  if (toggles.privateMode) {
    return { status: "skipped", reason: "private-mode" };
  }

  if (!toggles.retrieval) {
    return { status: "skipped", reason: "retrieval-disabled" };
  }

  const trimmedQuery = input.query.trim();
  if (trimmedQuery.length === 0) {
    return { status: "skipped", reason: "empty-query" };
  }

  // A newer message in the same session replaces pending: the latest user
  // message is the retrieval query that matters, and overwriting stays
  // deterministic when messages queue ahead of the next LLM request.

  let retrieved;
  try {
    retrieved = await retrieve(trimmedQuery, input.projectId);
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const { kept, suppressed } = suppressConflictingLessons({ results: retrieved.lessons });
  const packInput = input.tokenBudget !== undefined
    ? { kept, suppressed, query: trimmedQuery, tokenBudget: input.tokenBudget }
    : { kept, suppressed, query: trimmedQuery };
  const packed = packLessonContext(packInput);
  const receipt = {
    ...packed.receipt,
    semantic: {
      status: retrieved.semantic.status,
      candidateCount: retrieved.semantic.candidateCount,
    },
  };

  // The protocol is a fixed adapter-level block, not lesson content: it stays
  // out of the lesson token budget and the retrieval receipt's accounting, and
  // it is the sole injection payload while no lessons have been confirmed yet.
  const block = packed.block.length > 0
    ? `${LESSON_PROPOSAL_PROTOCOL}\n\n${packed.block}`
    : LESSON_PROPOSAL_PROTOCOL;

  const pending: PendingInjection = {
    sessionId: input.sessionId,
    messageId: input.messageId,
    block,
    receipt,
    preparedAt: input.now ?? new Date().toISOString(),
  };

  state.pending.set(input.sessionId, pending);

  return { status: "prepared", pending };
}

export function applyInjection(
  state: InjectionState,
  sessionId: string | undefined,
  system: string[],
): ApplyInjectionResult {
  if (sessionId === undefined) {
    return { status: "skipped", reason: "no-session-id" };
  }

  const pending = state.pending.get(sessionId);
  if (!pending) {
    return { status: "skipped", reason: "no-pending-injection" };
  }

  // Pending stays until the next prepare replaces it: OpenCode fires the
  // system transform for every LLM request of a turn — the forked title and
  // summary requests, and each tool-loop step — and the block must ride on
  // all of them, not only whichever request consumes it first.
  if (system.length === 0) {
    system.push(pending.block);
  } else {
    system[0] = system[0] + "\n\n" + pending.block;
  }

  return { status: "applied", receipt: pending.receipt };
}

export function clearPendingInjection(state: InjectionState, sessionId: string): boolean {
  return state.pending.delete(sessionId);
}
