import type { ResolvedFeatureToggles } from "./feature-toggle-types.js";

export type AssistantCompletionTokens = Readonly<{
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}>;

export type AssistantCompletionError = Readonly<{
  name: string;
  code?: string;
}>;

export type AssistantCompletionInput = Readonly<{
  sessionId: string;
  messageId: string;
  agent: string;
  provider: string;
  model: string;
  costUsd: number;
  tokens: AssistantCompletionTokens;
  startedAtMs: number;
  completedAtMs?: number;
  finish?: string;
  error?: AssistantCompletionError;
  softwareVersions?: Readonly<Record<string, string>>;
}>;

export type HandleAssistantCompletionResult =
  | Readonly<{
      status: "recorded";
      executionId: string;
      taskId: string;
      signalIds: ReadonlyArray<string>;
    }>
  | Readonly<{
      status: "skipped";
      reason:
        | "private-mode"
        | "model-telemetry-disabled"
        | "no-active-task"
        | "incomplete-completion"
        | "already-recorded";
    }>
  | Readonly<{ status: "failed"; error: string }>;

export type ExecutionCaptureState = Readonly<{
  recordedMessageIds: Set<string>;
}>;
