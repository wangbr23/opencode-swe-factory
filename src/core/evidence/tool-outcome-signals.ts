import { recordOutcomeSignal } from "./execution-profiles.js";
import type { SqliteConnection } from "../db/sqlite.js";
import {
  TOOL_COMMAND_CATEGORY_PREFIXES,
  TOOL_OUTCOME_SIGNAL_CONSTANTS,
} from "./tool-outcome-signal-constants.js";
import type {
  DerivedToolOutcomeSignal,
  RecordToolOutcomeSignalInput,
  RecordToolOutcomeSignalResult,
  ToolCompletionRecord,
  ToolOutcomeCategory,
  ToolOutcomeSignalMetadata,
} from "../../types/tool-outcome-signal-types.js";

export type {
  DerivedToolOutcomeSignal,
  RecordToolOutcomeSignalInput,
  RecordToolOutcomeSignalResult,
  ToolCompletionRecord,
  ToolFailureKind,
  ToolOutcomeCategory,
  ToolOutcomeSignalMetadata,
} from "../../types/tool-outcome-signal-types.js";
export { TOOL_COMMAND_CATEGORY_PREFIXES, TOOL_FAILURE_KINDS } from "./tool-outcome-signal-constants.js";

/**
 * Resolve the outcome category for a completed tool. The transient command
 * text is matched against the configured prefix table in memory and is never
 * persisted; commands matching nothing fall back to the generic category.
 */
export function resolveToolOutcomeCategory(
  record: ToolCompletionRecord,
): ToolOutcomeCategory {
  const commandText = record.commandText?.trim().toLowerCase();
  if (commandText !== undefined && commandText.length > 0) {
    for (const entry of TOOL_COMMAND_CATEGORY_PREFIXES) {
      if (commandText.startsWith(entry.prefix)) {
        return entry.category;
      }
    }
  }
  return TOOL_OUTCOME_SIGNAL_CONSTANTS.genericCategory;
}

/**
 * Derive objective tool success/failure signals from the transient status of
 * a completed tool execution. A signal is produced only when the status is
 * determinate: a host-classified failure or an exit code. Raw output is never
 * an input, and tool failures stay on the reliability dimension — they are
 * never negative model-quality evidence.
 */
export function deriveToolOutcomeSignals(
  record: ToolCompletionRecord,
): ReadonlyArray<DerivedToolOutcomeSignal> {
  const category = resolveToolOutcomeCategory(record);

  let failureKind;
  if (record.errorKind !== undefined) {
    failureKind = record.errorKind;
  } else if (record.exitCode !== undefined) {
    failureKind =
      record.exitCode === 0
        ? undefined
        : TOOL_OUTCOME_SIGNAL_CONSTANTS.commandFailureKind;
  } else {
    return [];
  }

  const metadata: ToolOutcomeSignalMetadata = {
    tool: record.tool,
    category,
    ...(failureKind !== undefined ? { failureKind } : {}),
  };

  return [
    {
      dimension: "reliability",
      kind: TOOL_OUTCOME_SIGNAL_CONSTANTS.signalKind,
      source: TOOL_OUTCOME_SIGNAL_CONSTANTS.signalSource,
      confidence: TOOL_OUTCOME_SIGNAL_CONSTANTS.exactConfidence,
      value: failureKind === undefined ? 1 : 0,
      metadata,
    },
  ];
}

/**
 * Derive the outcome signal for a tool completion and persist it against the
 * task. Only the objective signal (dimension, kind, category, failure kind)
 * is stored — command text and raw output are discarded in memory.
 */
export function recordToolOutcomeSignal(
  connection: SqliteConnection,
  input: RecordToolOutcomeSignalInput,
): RecordToolOutcomeSignalResult {
  const [signal] = deriveToolOutcomeSignals(input.record);
  if (!signal) {
    return { status: "skipped", reason: "indeterminate-status" };
  }

  const observedAt = input.record.observedAt ?? input.now ?? new Date();
  const { signalId } = recordOutcomeSignal(connection, {
    taskId: input.taskId,
    dimension: signal.dimension,
    kind: signal.kind,
    source: signal.source,
    confidence: signal.confidence,
    value: signal.value,
    metadata: signal.metadata,
    observedAt,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });

  return {
    status: "recorded",
    signalId,
    taskId: input.taskId,
    category: signal.metadata.category,
    value: signal.value,
  };
}
