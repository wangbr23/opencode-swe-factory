import { recordOutcomeSignal } from "./execution-profiles.js";
import { TOOL_FAILURE_KINDS } from "./tool-outcome-signal-constants.js";
import {
  OUTCOME_DIMENSION_VALUES,
  OUTCOME_RECLASSIFICATION_CONSTANTS,
} from "./outcome-reclassification-constants.js";
import type { SqliteConnection } from "../db/sqlite.js";
import type {
  OutcomeFailureAttributionState,
  ReclassifyOutcomeFailureInput,
  ReclassifyOutcomeFailureResult,
} from "../../types/outcome-reclassification-types.js";
import type { OutcomeDimension } from "../../types/execution-profile-types.js";
import type { ToolFailureKind } from "../../types/tool-outcome-signal-types.js";

export type {
  OutcomeFailureAttributionState,
  ReclassifyOutcomeFailureInput,
  ReclassifyOutcomeFailureResult,
} from "../../types/outcome-reclassification-types.js";
export { OUTCOME_RECLASSIFICATION_CONSTANTS } from "./outcome-reclassification-constants.js";

export class OutcomeReclassificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutcomeReclassificationError";
  }
}

type ReclassifiableSignalRow = Readonly<{
  id: string;
  execution_id: string | null;
  dimension: string;
  kind: string;
  source: string;
  confidence: number;
  value: number;
  metadata_json: string;
  observed_at: string;
  superseded_by: string | null;
}>;

function loadSignalRow(
  connection: SqliteConnection,
  taskId: string,
  signalId: string,
): ReclassifiableSignalRow | undefined {
  return connection.database
    .query<ReclassifiableSignalRow, [string, string]>(
      `SELECT id, execution_id, dimension, kind, source, confidence, value,
              metadata_json, observed_at,
              (SELECT newer.id FROM outcome_signals AS newer
               WHERE newer.supersedes_signal_id = outcome_signals.id) AS superseded_by
       FROM outcome_signals
       WHERE id = ? AND task_id = ?`,
    )
      .get(signalId, taskId) ?? undefined;
}

function readFailureKind(metadata: Record<string, unknown>): ToolFailureKind | undefined {
  // Metadata of this shape is written only from the validated TOOL_FAILURE_KINDS
  // vocabulary, so a string value is safe to treat as a failure kind.
  const value = metadata[OUTCOME_RECLASSIFICATION_CONSTANTS.failureKindKey];
  return typeof value === "string" ? (value as ToolFailureKind) : undefined;
}

function readDimension(value: string): OutcomeDimension {
  const match = OUTCOME_DIMENSION_VALUES.find((dimension) => dimension === value);
  if (match === undefined) {
    throw new OutcomeReclassificationError(`Outcome signal has unknown dimension "${value}".`);
  }
  return match as OutcomeDimension;
}

function assertRestorableExecution(
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
    throw new OutcomeReclassificationError(
      `Execution profile ${executionId} was not found for task ${taskId}.`,
    );
  }
}

/**
 * Reclassify one recorded outcome failure by superseding it with a corrected
 * signal: the original row stays immutable and aggregation recomputes from
 * effective signals alone. `failureKind` corrects the failure classification;
 * `notModelCaused` withdraws the failure's attribution to the executing model
 * by unlinking the correction from the execution (the design's false-attribution
 * remedy). Omitting `notModelCaused` on a previously withdrawn signal restores
 * its original execution link, so withdrawal stays reversible.
 */
export function reclassifyOutcomeFailure(
  connection: SqliteConnection,
  input: ReclassifyOutcomeFailureInput,
): ReclassifyOutcomeFailureResult {
  if (input.failureKind !== undefined && !TOOL_FAILURE_KINDS.includes(input.failureKind)) {
    throw new OutcomeReclassificationError(`Unknown failure kind: ${String(input.failureKind)}.`);
  }

  return connection.database.transaction((): ReclassifyOutcomeFailureResult => {
    const signal = loadSignalRow(connection, input.taskId, input.signalId);
    if (!signal) {
      throw new OutcomeReclassificationError(
        `Outcome signal ${input.signalId} was not found for task ${input.taskId}.`,
      );
    }
    if (signal.superseded_by !== null) {
      throw new OutcomeReclassificationError(
        `Outcome signal ${input.signalId} has already been superseded by ${signal.superseded_by} and cannot be reclassified.`,
      );
    }
    if (!OUTCOME_RECLASSIFICATION_CONSTANTS.reclassifiableSignalKinds.includes(signal.kind)) {
      throw new OutcomeReclassificationError(
        `Outcome signal ${input.signalId} has kind "${signal.kind}", which cannot be reclassified.`,
      );
    }
    if (signal.value !== 0) {
      throw new OutcomeReclassificationError(
        `Outcome signal ${input.signalId} is not a failure; only failures (value 0) can be reclassified.`,
      );
    }

    const metadata = JSON.parse(signal.metadata_json) as Record<string, unknown>;
    const currentFailureKind = readFailureKind(metadata);
    const kindCorrects =
      input.failureKind !== undefined && input.failureKind !== currentFailureKind;
    const withdraws = input.notModelCaused === true && signal.execution_id !== null;
    const restores =
      input.notModelCaused !== true &&
      metadata[OUTCOME_RECLASSIFICATION_CONSTANTS.notModelCausedKey] === true;

    if (!kindCorrects && !withdraws && !restores) {
      throw new OutcomeReclassificationError(
        `Nothing to reclassify: signal ${input.signalId} already has this classification.`,
      );
    }

    let restoredExecutionId: string | undefined;
    if (restores) {
      const original = metadata[OUTCOME_RECLASSIFICATION_CONSTANTS.originalExecutionIdKey];
      if (typeof original !== "string" || original.length === 0) {
        throw new OutcomeReclassificationError(
          `Outcome signal ${input.signalId} has no recorded original execution, so model attribution cannot be restored.`,
        );
      }
      assertRestorableExecution(connection, input.taskId, original);
      restoredExecutionId = original;
    }

    const nextMetadata: Record<string, unknown> = { ...metadata };
    if (kindCorrects) {
      nextMetadata[OUTCOME_RECLASSIFICATION_CONSTANTS.failureKindKey] = input.failureKind;
      if (currentFailureKind !== undefined) {
        nextMetadata[OUTCOME_RECLASSIFICATION_CONSTANTS.reclassifiedFailureKindKey] =
          currentFailureKind;
      }
    }
    if (withdraws) {
      nextMetadata[OUTCOME_RECLASSIFICATION_CONSTANTS.notModelCausedKey] = true;
      nextMetadata[OUTCOME_RECLASSIFICATION_CONSTANTS.originalExecutionIdKey] = signal.execution_id;
    }
    if (restores) {
      delete nextMetadata[OUTCOME_RECLASSIFICATION_CONSTANTS.notModelCausedKey];
      delete nextMetadata[OUTCOME_RECLASSIFICATION_CONSTANTS.originalExecutionIdKey];
    }

    const executionId = withdraws ? undefined : (signal.execution_id ?? restoredExecutionId);
    const { signalId } = recordOutcomeSignal(connection, {
      taskId: input.taskId,
      ...(executionId !== undefined ? { executionId } : {}),
      dimension: readDimension(signal.dimension),
      kind: signal.kind,
      source: signal.source,
      confidence: signal.confidence,
      value: signal.value,
      metadata: nextMetadata,
      supersedesSignalId: signal.id,
      observedAt: new Date(signal.observed_at),
      ...(input.now !== undefined ? { now: input.now } : {}),
    });

    return {
      signalId,
      taskId: input.taskId,
      supersededSignalId: signal.id,
      ...(kindCorrects
        ? {
            failureKind: input.failureKind,
            ...(currentFailureKind !== undefined
              ? { previousFailureKind: currentFailureKind }
              : {}),
          }
        : {}),
      attribution: withdraws ? "withdrawn" : restores ? "restored" : "unchanged",
    };
  })();
}
