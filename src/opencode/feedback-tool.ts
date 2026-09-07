import { recordExplicitFeedback } from "../core/feedback-signals.js";
import type { SqliteConnection } from "../core/sqlite.js";
import type { ResolvedFeatureToggles } from "../types/feature-toggle-types.js";
import type {
  RecordFeedbackToolInput,
  RecordFeedbackToolResult,
} from "../types/feedback-tool-types.js";
import { getActiveTask, type TaskBoundaryState } from "./task-boundary.js";

export type {
  RecordFeedbackToolInput,
  RecordFeedbackToolResult,
} from "../types/feedback-tool-types.js";

export function handleRecordFeedback(
  state: TaskBoundaryState,
  connection: SqliteConnection,
  toggles: ResolvedFeatureToggles,
  input: RecordFeedbackToolInput,
): RecordFeedbackToolResult {
  if (toggles.privateMode) {
    return { status: "skipped", reason: "private-mode" };
  }
  if (!toggles.recording) {
    return { status: "skipped", reason: "recording-disabled" };
  }

  const activeTask = getActiveTask(state, input.sessionId);
  const taskId = input.taskId ?? activeTask?.taskId;
  if (taskId === undefined) {
    return { status: "skipped", reason: "no-active-task" };
  }

  try {
    return recordExplicitFeedback(connection, {
      taskId,
      feedbackKind: input.feedbackKind,
    });
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function describeFeedbackResult(result: RecordFeedbackToolResult): string {
  if (result.status === "skipped") {
    if (result.reason === "no-active-task") {
      return "No feedback recorded: there is no active task for this session and no task ID was provided.";
    }
    if (result.reason === "private-mode") {
      return "Feedback skipped: private mode is active.";
    }
    return "Feedback skipped: recording is disabled.";
  }
  if (result.status === "failed") {
    return `Feedback failed: ${result.error}`;
  }

  const lines = [
    `Recorded ${result.feedbackKind} feedback for task ${result.taskId}.`,
    `Signal: ${result.signalId}`,
  ];
  if (result.supersededSignalId !== undefined) {
    lines.push(`Retracted prior acceptance signal ${result.supersededSignalId}.`);
  }
  return lines.join("\n");
}
