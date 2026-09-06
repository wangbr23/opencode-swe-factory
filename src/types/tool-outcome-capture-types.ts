import type { ToolCompletionRecord, ToolOutcomeCategory } from "./tool-outcome-signal-types.js";

export type ToolOutcomeCaptureState = Readonly<{
  recordedCallIds: Set<string>;
}>;

export type ToolCompletionInput = Readonly<{
  sessionId: string;
  callId: string;
  tool: string;
  /** Transient tool arguments; only read in memory, never persisted. */
  args?: unknown;
  /** Transient tool metadata; only read in memory, never persisted. */
  metadata?: unknown;
}>;

export type HandleToolCompletionResult =
  | Readonly<{
      status: "recorded";
      signalId: string;
      taskId: string;
      category: ToolOutcomeCategory;
      value: 0 | 1;
    }>
  | Readonly<{
      status: "skipped";
      reason:
        | "private-mode"
        | "recording-disabled"
        | "no-active-task"
        | "already-recorded"
        | "indeterminate-status";
    }>
  | Readonly<{ status: "failed"; error: string }>;

export type { ToolCompletionRecord };
