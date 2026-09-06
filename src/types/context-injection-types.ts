import type { RetrievalReceipt } from "./lesson-context-types.js";
import type { LexicalLessonResult } from "./lesson-retrieval-types.js";

export type PendingInjection = Readonly<{
  sessionId: string;
  messageId: string | undefined;
  block: string;
  receipt: RetrievalReceipt;
  preparedAt: string;
}>;

export type InjectionState = {
  readonly pending: Map<string, PendingInjection>;
};

export type RetrieveLessonsFn = (
  query: string,
  projectId: string,
) => ReadonlyArray<LexicalLessonResult>;

export type PrepareInjectionInput = Readonly<{
  sessionId: string;
  messageId?: string;
  query: string;
  projectId: string;
  tokenBudget?: number;
  now?: string;
}>;

export type PrepareInjectionResult =
  | Readonly<{ status: "prepared"; pending: PendingInjection }>
  | Readonly<{
      status: "skipped";
      reason: "retrieval-disabled" | "private-mode" | "empty-query" | "ambiguous-correlation";
    }>
  | Readonly<{ status: "empty"; receipt: RetrievalReceipt }>
  | Readonly<{ status: "failed"; error: string }>;

export type ApplyInjectionResult =
  | Readonly<{ status: "applied"; receipt: RetrievalReceipt }>
  | Readonly<{ status: "skipped"; reason: "no-session-id" | "no-pending-injection" }>;
