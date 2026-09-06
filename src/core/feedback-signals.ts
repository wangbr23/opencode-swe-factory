import { recordOutcomeSignal } from "./execution-profiles.js";
import { EXPLICIT_FEEDBACK_VALUES, FEEDBACK_SIGNAL_CONSTANTS } from "./feedback-signal-constants.js";
import type { SqliteConnection } from "./sqlite.js";
import type {
  ExplicitFeedbackKind,
  RecordCorrectionLessonEvidenceInput,
  RecordCorrectionLessonEvidenceResult,
  RecordExplicitFeedbackInput,
  RecordExplicitFeedbackResult,
} from "../types/feedback-signal-types.js";

export type {
  ExplicitFeedbackKind,
  ExplicitFeedbackSignalMetadata,
  ExplicitFeedbackValue,
  RecordCorrectionLessonEvidenceInput,
  RecordCorrectionLessonEvidenceResult,
  RecordExplicitFeedbackInput,
  RecordExplicitFeedbackResult,
} from "../types/feedback-signal-types.js";
export { EXPLICIT_FEEDBACK_VALUES, FEEDBACK_SIGNAL_CONSTANTS } from "./feedback-signal-constants.js";

export class FeedbackSignalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedbackSignalError";
  }
}

function assertTaskExists(connection: SqliteConnection, taskId: string): void {
  const task = connection.database
    .query<{ id: string }, [string]>("SELECT id FROM tasks WHERE id = ?")
    .get(taskId);
  if (!task) {
    throw new FeedbackSignalError(`Task ${taskId} not found.`);
  }
}

function assertLessonVersionExists(
  connection: SqliteConnection,
  lessonId: string,
  lessonVersion: number,
): void {
  const row = connection.database
    .query<{ lesson_id: string }, [string, number]>(
      "SELECT lesson_id FROM lesson_versions WHERE lesson_id = ? AND version = ?",
    )
    .get(lessonId, lessonVersion);
  if (!row) {
    throw new FeedbackSignalError(`Lesson version ${lessonId}@${lessonVersion} not found.`);
  }
}

function assertExecutionBelongsToTask(
  connection: SqliteConnection,
  taskId: string,
  executionId: string,
): void {
  const row = connection.database
    .query<{ id: string }, [string, string]>(
      "SELECT id FROM execution_profiles WHERE id = ? AND task_id = ?",
    )
    .get(executionId, taskId);
  if (!row) {
    throw new FeedbackSignalError(
      `Execution profile ${executionId} was not found for task ${taskId}.`,
    );
  }
}

/**
 * Find the task's latest acceptance signal that no later signal has already
 * superseded. Only that signal can be retracted by new negative feedback.
 */
function findSupersedableAcceptanceSignal(
  connection: SqliteConnection,
  taskId: string,
): string | undefined {
  const row = connection.database
    .query<{ id: string }, [string]>(
      `SELECT id FROM outcome_signals
       WHERE task_id = ?
         AND kind = '${FEEDBACK_SIGNAL_CONSTANTS.signalKind}'
         AND json_extract(metadata_json, '$.feedbackKind') = '${FEEDBACK_SIGNAL_CONSTANTS.acceptanceFeedbackKind}'
         AND id NOT IN (
           SELECT supersedes_signal_id FROM outcome_signals WHERE supersedes_signal_id IS NOT NULL
         )
       ORDER BY rowid DESC
       LIMIT 1`,
    )
    .get(taskId);
  return row?.id;
}

/**
 * Record one explicit feedback control as a high-confidence quality signal.
 * A negative kind (correction, rework) retracts the task's latest acceptance
 * by superseding it, so aggregation never sees contradictory evidence for the
 * same acceptance.
 */
export function recordExplicitFeedback(
  connection: SqliteConnection,
  input: RecordExplicitFeedbackInput,
): RecordExplicitFeedbackResult {
  if (!Object.keys(EXPLICIT_FEEDBACK_VALUES).includes(input.feedbackKind)) {
    throw new FeedbackSignalError(`Unknown explicit feedback kind: ${String(input.feedbackKind)}.`);
  }
  assertTaskExists(connection, input.taskId);

  const value = EXPLICIT_FEEDBACK_VALUES[input.feedbackKind];

  return connection.database.transaction((): RecordExplicitFeedbackResult => {
    const supersededSignalId =
      value === 0 ? findSupersedableAcceptanceSignal(connection, input.taskId) : undefined;

    const { signalId } = recordOutcomeSignal(connection, {
      taskId: input.taskId,
      dimension: "quality",
      kind: FEEDBACK_SIGNAL_CONSTANTS.signalKind,
      source: FEEDBACK_SIGNAL_CONSTANTS.signalSource,
      confidence: FEEDBACK_SIGNAL_CONSTANTS.exactConfidence,
      value,
      metadata: { feedbackKind: input.feedbackKind },
      ...(supersededSignalId !== undefined ? { supersedesSignalId: supersededSignalId } : {}),
      ...(input.observedAt !== undefined ? { observedAt: input.observedAt } : {}),
      ...(input.now !== undefined ? { now: input.now } : {}),
    });

    return {
      status: "recorded",
      signalId,
      taskId: input.taskId,
      feedbackKind: input.feedbackKind,
      value,
      ...(supersededSignalId !== undefined ? { supersededSignalId } : {}),
    };
  })();
}

/**
 * Link a confirmed correction lesson back to the affected task (and execution
 * when known) as strong negative quality evidence. Only the structural links
 * are stored — the conversation itself is never retained.
 */
export function recordCorrectionLessonEvidence(
  connection: SqliteConnection,
  input: RecordCorrectionLessonEvidenceInput,
): RecordCorrectionLessonEvidenceResult {
  assertTaskExists(connection, input.taskId);
  assertLessonVersionExists(connection, input.lessonId, input.lessonVersion);
  if (input.executionId !== undefined) {
    assertExecutionBelongsToTask(connection, input.taskId, input.executionId);
  }

  const { signalId } = recordOutcomeSignal(connection, {
    taskId: input.taskId,
    dimension: "quality",
    kind: FEEDBACK_SIGNAL_CONSTANTS.correctionLessonKind,
    source: FEEDBACK_SIGNAL_CONSTANTS.correctionLessonSource,
    confidence: FEEDBACK_SIGNAL_CONSTANTS.exactConfidence,
    value: 0,
    metadata: {},
    lessonId: input.lessonId,
    lessonVersion: input.lessonVersion,
    ...(input.executionId !== undefined ? { executionId: input.executionId } : {}),
    ...(input.observedAt !== undefined ? { observedAt: input.observedAt } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
  });

  return {
    signalId,
    taskId: input.taskId,
    lessonId: input.lessonId,
    lessonVersion: input.lessonVersion,
    ...(input.executionId !== undefined ? { executionId: input.executionId } : {}),
  };
}
