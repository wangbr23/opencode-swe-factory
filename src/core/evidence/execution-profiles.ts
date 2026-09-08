import { randomUUID } from "node:crypto";

import { TaskPersistenceError } from "../tasks/task-persistence.js";
import type { SqliteConnection } from "../db/sqlite.js";
import type {
  ExecutionProfileRow,
  OutcomeSignalRow,
  OutcomeDimension,
  RecordExecutionProfileInput,
  RecordExecutionProfileResult,
  RecordOutcomeSignalInput,
  RecordOutcomeSignalResult,
} from "../../types/execution-profile-types.js";

export type {
  ExecutionProfileRow,
  ExecutionTokens,
  OutcomeDimension,
  OutcomeSignalRow,
  RecordExecutionProfileInput,
  RecordExecutionProfileResult,
  RecordOutcomeSignalInput,
  RecordOutcomeSignalResult,
} from "../../types/execution-profile-types.js";

export class ExecutionProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionProfileError";
  }
}

function resolveActiveProfileVersion(connection: SqliteConnection, taskId: string): number {
  const task = connection.database
    .query<{ id: string; active_profile_version: number | null }, [string]>(
      "SELECT id, active_profile_version FROM tasks WHERE id = ?",
    )
    .get(taskId);

  if (!task) {
    throw new TaskPersistenceError(`Task ${taskId} not found.`);
  }
  if (task.active_profile_version === null) {
    throw new TaskPersistenceError(`Task ${taskId} has no active task profile.`);
  }
  return task.active_profile_version;
}

export function recordExecutionProfile(
  connection: SqliteConnection,
  input: RecordExecutionProfileInput,
): RecordExecutionProfileResult {
  const taskProfileVersion = resolveActiveProfileVersion(connection, input.taskId);

  if ((input.hostProvider === undefined) !== (input.hostModel === undefined)) {
    throw new ExecutionProfileError("hostProvider and hostModel must be provided together.");
  }
  if (input.latencyMs < 0) {
    throw new ExecutionProfileError("latencyMs must not be negative.");
  }

  const executionId = randomUUID();
  const now = (input.now ?? new Date()).toISOString();

  connection.database.run(
    `INSERT INTO execution_profiles (
      id, task_id, task_profile_version, provider, model, variant, agent,
      selection_source, host_provider, host_model, host_variant,
      tool_profile_json, software_versions_json, started_at, completed_at,
      latency_ms, input_tokens, output_tokens, reasoning_tokens,
      cache_read_tokens, cache_write_tokens, cost_usd, finish_state,
      provider_error_kind, provider_error_code, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      executionId,
      input.taskId,
      taskProfileVersion,
      input.provider,
      input.model,
      input.variant ?? null,
      input.agent,
      input.selectionSource,
      input.hostProvider ?? null,
      input.hostModel ?? null,
      input.hostVariant ?? null,
      JSON.stringify(input.toolProfile ?? {}),
      JSON.stringify(input.softwareVersions ?? {}),
      input.startedAt.toISOString(),
      input.completedAt.toISOString(),
      input.latencyMs,
      input.tokens.input,
      input.tokens.output,
      input.tokens.reasoning,
      input.tokens.cacheRead,
      input.tokens.cacheWrite,
      input.costUsd,
      input.finishState,
      input.providerErrorKind ?? null,
      input.providerErrorCode ?? null,
      now,
    ],
  );

  return { executionId, taskId: input.taskId, taskProfileVersion };
}

export function recordOutcomeSignal(
  connection: SqliteConnection,
  input: RecordOutcomeSignalInput,
): RecordOutcomeSignalResult {
  if ((input.lessonId === undefined) !== (input.lessonVersion === undefined)) {
    throw new ExecutionProfileError("lessonId and lessonVersion must be provided together.");
  }
  if (input.confidence < 0 || input.confidence > 1) {
    throw new ExecutionProfileError("confidence must be between 0 and 1.");
  }

  const signalId = randomUUID();
  const now = (input.now ?? new Date()).toISOString();
  const observedAt = (input.observedAt ?? input.now ?? new Date()).toISOString();

  connection.database.run(
    `INSERT INTO outcome_signals (
      id, task_id, execution_id, dimension, kind, source, confidence, value,
      metadata_json, lesson_id, lesson_version, supersedes_signal_id,
      observed_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      signalId,
      input.taskId,
      input.executionId ?? null,
      input.dimension,
      input.kind,
      input.source,
      input.confidence,
      input.value,
      JSON.stringify(input.metadata ?? {}),
      input.lessonId ?? null,
      input.lessonVersion ?? null,
      input.supersedesSignalId ?? null,
      observedAt,
      now,
    ],
  );

  return { signalId, taskId: input.taskId, dimension: input.dimension };
}

export function getExecutionProfile(
  connection: SqliteConnection,
  executionId: string,
): (ExecutionProfileRow & { signals: OutcomeSignalRow[] }) | null {
  const row = connection.database
    .query<ExecutionProfileRow, [string]>(
      "SELECT * FROM execution_profiles WHERE id = ?",
    )
    .get(executionId);

  if (!row) {
    return null;
  }

  const signals = connection.database
    .query<OutcomeSignalRow, [string]>(
      "SELECT * FROM outcome_signals WHERE execution_id = ? ORDER BY rowid",
    )
    .all(executionId);

  return { ...row, signals };
}
