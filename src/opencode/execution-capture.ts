import {
  recordExecutionProfile,
  recordOutcomeSignal,
  type RecordExecutionProfileInput,
} from "../core/execution-profiles.js";
import type { SqliteConnection } from "../core/sqlite.js";
import { getActiveTask } from "./task-boundary.js";
import type { ResolvedFeatureToggles } from "../types/feature-toggle-types.js";
import type {
  AssistantCompletionInput,
  ExecutionCaptureState,
  HandleAssistantCompletionResult,
} from "../types/execution-capture-types.js";
import { EXECUTION_CAPTURE_CONSTANTS as CAPTURE } from "./execution-capture-constants.js";

export type {
  AssistantCompletionError,
  AssistantCompletionInput,
  AssistantCompletionTokens,
  ExecutionCaptureState,
  HandleAssistantCompletionResult,
} from "../types/execution-capture-types.js";

export function createExecutionCaptureState(): ExecutionCaptureState {
  return { recordedMessageIds: new Set() };
}

function buildExecutionInput(
  input: AssistantCompletionInput,
  taskId: string,
  latencyMs: number,
  finishState: string,
  completedAtMs: number,
): RecordExecutionProfileInput {
  const base: RecordExecutionProfileInput = {
    taskId,
    provider: input.provider,
    model: input.model,
    agent: input.agent,
    selectionSource: CAPTURE.selectionSourceHost,
    toolProfile: {},
    softwareVersions: { ...(input.softwareVersions ?? {}) },
    startedAt: new Date(input.startedAtMs),
    completedAt: new Date(completedAtMs),
    latencyMs,
    tokens: {
      input: input.tokens.input,
      output: input.tokens.output,
      reasoning: input.tokens.reasoning,
      cacheRead: input.tokens.cacheRead,
      cacheWrite: input.tokens.cacheWrite,
    },
    costUsd: input.costUsd,
    finishState,
  };

  if (!input.error) {
    return base;
  }

  const withError: RecordExecutionProfileInput = {
    ...base,
    providerErrorKind: input.error.name,
  };
  if (input.error.code !== undefined) {
    return { ...withError, providerErrorCode: input.error.code };
  }
  return withError;
}

export function handleAssistantCompletion(
  captureState: ExecutionCaptureState,
  taskBoundaryState: Parameters<typeof getActiveTask>[0],
  connection: SqliteConnection,
  toggles: ResolvedFeatureToggles,
  input: AssistantCompletionInput,
): HandleAssistantCompletionResult {
  if (toggles.privateMode) {
    return { status: "skipped", reason: "private-mode" };
  }
  if (!toggles.modelTelemetry) {
    return { status: "skipped", reason: "model-telemetry-disabled" };
  }
  if (input.completedAtMs === undefined) {
    return { status: "skipped", reason: "incomplete-completion" };
  }
  if (captureState.recordedMessageIds.has(input.messageId)) {
    return { status: "skipped", reason: "already-recorded" };
  }

  const activeTask = getActiveTask(taskBoundaryState, input.sessionId, input.agent);
  if (!activeTask) {
    return { status: "skipped", reason: "no-active-task" };
  }

  const latencyMs = Math.max(0, input.completedAtMs - input.startedAtMs);
  const finishState = input.error
    ? CAPTURE.errorFinishState
    : (input.finish ?? CAPTURE.unknownFinishState);

  try {
    const execution = recordExecutionProfile(
      connection,
      buildExecutionInput(input, activeTask.taskId, latencyMs, finishState, input.completedAtMs),
    );

    const observedAt = new Date(input.completedAtMs);
    const signalIds = [
      recordOutcomeSignal(connection, {
        taskId: activeTask.taskId,
        executionId: execution.executionId,
        dimension: "cost",
        kind: CAPTURE.costSignalKind,
        source: CAPTURE.signalSourceAssistantMessage,
        confidence: CAPTURE.exactConfidence,
        value: input.costUsd,
        observedAt,
      }).signalId,
      recordOutcomeSignal(connection, {
        taskId: activeTask.taskId,
        executionId: execution.executionId,
        dimension: "latency",
        kind: CAPTURE.latencySignalKind,
        source: CAPTURE.signalSourceAssistantMessage,
        confidence: CAPTURE.exactConfidence,
        value: latencyMs,
        observedAt,
      }).signalId,
      recordOutcomeSignal(connection, {
        taskId: activeTask.taskId,
        executionId: execution.executionId,
        dimension: "reliability",
        kind: CAPTURE.finishSignalKind,
        source: CAPTURE.signalSourceAssistantMessage,
        confidence: CAPTURE.exactConfidence,
        value: input.error ? 0 : 1,
        metadata: {
          finishState,
          ...(input.error ? { errorKind: input.error.name } : {}),
        },
        observedAt,
      }).signalId,
    ];

    captureState.recordedMessageIds.add(input.messageId);

    return {
      status: "recorded",
      executionId: execution.executionId,
      taskId: activeTask.taskId,
      signalIds,
    };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
