import { recordToolOutcomeSignal } from "../core/tool-outcome-signals.js";
import type { SqliteConnection } from "../core/sqlite.js";
import { getActiveTask } from "./task-boundary.js";
import type { ResolvedFeatureToggles } from "../types/feature-toggle-types.js";
import type { ToolFailureKind } from "../types/tool-outcome-signal-types.js";
import type {
  HandleToolCompletionResult,
  ToolCompletionInput,
  ToolOutcomeCaptureState,
} from "../types/tool-outcome-capture-types.js";
import { TOOL_OUTCOME_CAPTURE_CONSTANTS as CAPTURE } from "./tool-outcome-capture-constants.js";

export type {
  HandleToolCompletionResult,
  ToolCompletionInput,
  ToolOutcomeCaptureState,
} from "../types/tool-outcome-capture-types.js";

export function createToolOutcomeCaptureState(): ToolOutcomeCaptureState {
  return { recordedCallIds: new Set() };
}

function readNumberField(source: unknown, key: string): number | undefined {
  if (typeof source !== "object" || source === null) return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBooleanField(source: unknown, key: string): boolean {
  if (typeof source !== "object" || source === null) return false;
  return (source as Record<string, unknown>)[key] === true;
}

function readStringField(source: unknown, key: string): string | undefined {
  if (typeof source !== "object" || source === null) return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Classify a host tool failure from objective fields only (abort flags,
 * status codes, error names) — never from command output content. Failure
 * kinds stay separate from model quality per the design's attribution rule.
 */
function classifyFailureKind(metadata: unknown): ToolFailureKind | undefined {
  if (readBooleanField(metadata, CAPTURE.metadataAbortedKey)) {
    return "cancellation";
  }

  const error = (() => {
    if (typeof metadata !== "object" || metadata === null) return undefined;
    const value = (metadata as Record<string, unknown>)[CAPTURE.metadataErrorKey];
    if (typeof value !== "object" || value === null) return undefined;
    return value as Record<string, unknown>;
  })();
  if (!error) return undefined;

  const statusCode = readNumberField(error, CAPTURE.errorCodeKey);
  if (statusCode !== undefined) {
    if (CAPTURE.authenticationStatusCodes.has(statusCode)) {
      return "authentication";
    }
    if (statusCode >= CAPTURE.providerStatusThreshold) {
      return "provider";
    }
    return "local-tool";
  }

  return readStringField(error, CAPTURE.errorNameKey) !== undefined
    ? "local-tool"
    : undefined;
}

/**
 * Normalize the transient tool completion into a neutral record. Only
 * objective status facts survive normalization; the raw output string and
 * full arguments are read here and discarded.
 */
function buildToolCompletionRecord(input: ToolCompletionInput) {
  const exitCode = CAPTURE.metadataExitKeys
    .map((key) => readNumberField(input.metadata, key))
    .find((value) => value !== undefined);

  const errorKind = classifyFailureKind(input.metadata);

  const commandText =
    input.tool === CAPTURE.bashToolName
      ? readStringField(input.args, CAPTURE.bashCommandArg)
      : undefined;

  return {
    tool: input.tool,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(errorKind !== undefined ? { errorKind } : {}),
    ...(commandText !== undefined ? { commandText } : {}),
  };
}

export function handleToolCompletion(
  captureState: ToolOutcomeCaptureState,
  taskBoundaryState: Parameters<typeof getActiveTask>[0],
  connection: SqliteConnection,
  toggles: ResolvedFeatureToggles,
  input: ToolCompletionInput,
): HandleToolCompletionResult {
  if (toggles.privateMode) {
    return { status: "skipped", reason: "private-mode" };
  }
  if (!toggles.recording) {
    return { status: "skipped", reason: "recording-disabled" };
  }
  if (captureState.recordedCallIds.has(input.callId)) {
    return { status: "skipped", reason: "already-recorded" };
  }

  const activeTask = getActiveTask(taskBoundaryState, input.sessionId);
  if (!activeTask) {
    return { status: "skipped", reason: "no-active-task" };
  }

  try {
    const result = recordToolOutcomeSignal(connection, {
      taskId: activeTask.taskId,
      record: buildToolCompletionRecord(input),
    });

    if (result.status === "recorded") {
      captureState.recordedCallIds.add(input.callId);
      return {
        status: "recorded",
        signalId: result.signalId,
        taskId: result.taskId,
        category: result.category,
        value: result.value,
      };
    }
    return { status: "skipped", reason: result.reason };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
