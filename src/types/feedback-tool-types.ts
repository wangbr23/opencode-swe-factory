import type { RecordExplicitFeedbackResult } from "./feedback-signal-types.js";

export type RecordFeedbackToolInput = Readonly<{
  sessionId: string;
  feedbackKind: RecordExplicitFeedbackResult["feedbackKind"];
  taskId?: string;
}>;

export type RecordFeedbackToolSkippedReason =
  | "private-mode"
  | "recording-disabled"
  | "no-active-task";

export type RecordFeedbackToolResult =
  | Readonly<{ status: "skipped"; reason: RecordFeedbackToolSkippedReason }>
  | RecordExplicitFeedbackResult
  | Readonly<{ status: "failed"; error: string }>;
