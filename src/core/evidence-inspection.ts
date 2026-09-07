import { TaskPersistenceError } from "./task-persistence.js";
import type { SqliteConnection } from "./sqlite.js";

export type TaskEvidenceSignal = Readonly<{
  id: string;
  executionId: string | null;
  dimension: string;
  kind: string;
  source: string;
  confidence: number;
  value: number;
  metadata: Record<string, unknown>;
  lessonId: string | null;
  lessonVersion: number | null;
  supersedesSignalId: string | null;
  supersededBy: string | null;
  observedAt: string;
  createdAt: string;
}>;

/**
 * List a task's outcome evidence signals in insertion order. Every recorded
 * signal kind (objective tool outcomes, explicit feedback, correction-lesson
 * links) appears so users can audit exactly what aggregation would consume,
 * including which signals have been retracted by supersession.
 */
export function listTaskEvidenceSignals(
  connection: SqliteConnection,
  taskId: string,
): ReadonlyArray<TaskEvidenceSignal> {
  const task = connection.database
    .query<{ id: string }, [string]>("SELECT id FROM tasks WHERE id = ?")
    .get(taskId);
  if (!task) {
    throw new TaskPersistenceError(`Task ${taskId} not found.`);
  }

  const rows = connection.database
    .query<
      {
        id: string;
        execution_id: string | null;
        dimension: string;
        kind: string;
        source: string;
        confidence: number;
        value: number;
        metadata_json: string;
        lesson_id: string | null;
        lesson_version: number | null;
        supersedes_signal_id: string | null;
        superseded_by: string | null;
        observed_at: string;
        created_at: string;
      },
      [string]
    >(
      `SELECT s.id, s.execution_id, s.dimension, s.kind, s.source, s.confidence, s.value,
              s.metadata_json, s.lesson_id, s.lesson_version, s.supersedes_signal_id,
              s.observed_at, s.created_at,
              (SELECT newer.id FROM outcome_signals AS newer
               WHERE newer.supersedes_signal_id = s.id) AS superseded_by
       FROM outcome_signals AS s
       WHERE s.task_id = ?
       ORDER BY s.rowid`,
    )
    .all(taskId);

  return rows.map((row) => ({
    id: row.id,
    executionId: row.execution_id,
    dimension: row.dimension,
    kind: row.kind,
    source: row.source,
    confidence: row.confidence,
    value: row.value,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    lessonId: row.lesson_id,
    lessonVersion: row.lesson_version,
    supersedesSignalId: row.supersedes_signal_id,
    supersededBy: row.superseded_by,
    observedAt: row.observed_at,
    createdAt: row.created_at,
  }));
}
