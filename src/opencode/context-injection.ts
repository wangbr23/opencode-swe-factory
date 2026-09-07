import { suppressConflictingLessons } from "../core/lesson-conflict-suppression.js";
import { packLessonContext } from "../core/lesson-context.js";
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

  if (state.pending.has(input.sessionId)) {
    state.pending.delete(input.sessionId);
    return { status: "skipped", reason: "ambiguous-correlation" };
  }

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

  if (packed.packed.length === 0) {
    return { status: "empty", receipt };
  }

  const pending: PendingInjection = {
    sessionId: input.sessionId,
    messageId: input.messageId,
    block: packed.block,
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

  state.pending.delete(sessionId);

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
