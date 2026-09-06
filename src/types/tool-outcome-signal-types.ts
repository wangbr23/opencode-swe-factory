import type { OutcomeDimension } from "./execution-profile-types.js";

export type ToolOutcomeCategory =
  | "test"
  | "lint"
  | "typecheck"
  | "build"
  | "review"
  | "generic";

export type ToolFailureKind =
  | "command"
  | "local-tool"
  | "provider"
  | "authentication"
  | "cancellation";

/**
 * Neutral, tool-host-agnostic description of a completed tool execution.
 * Carries objective status facts only — raw command output must never be
 * placed on this record; the host adapter discards it before calling core.
 */
export type ToolCompletionRecord = Readonly<{
  tool: string;
  /** Host-reported exit status, when the tool exposes one. */
  exitCode?: number;
  /** Host-classified failure (abort, provider error, auth rejection, ...). */
  errorKind?: ToolFailureKind;
  /**
   * Leading text of the transient command the tool ran, used in memory for
   * category resolution only. Never persisted.
   */
  commandText?: string;
  observedAt?: Date;
}>;

export type ToolOutcomeSignalMetadata = Readonly<{
  tool: string;
  category: ToolOutcomeCategory;
  failureKind?: ToolFailureKind;
}>;

export type DerivedToolOutcomeSignal = Readonly<{
  dimension: Extract<OutcomeDimension, "reliability">;
  kind: "tool-outcome";
  source: "tool-completion";
  confidence: number;
  value: 0 | 1;
  metadata: ToolOutcomeSignalMetadata;
}>;

export type RecordToolOutcomeSignalInput = Readonly<{
  taskId: string;
  record: ToolCompletionRecord;
  now?: Date;
}>;

export type RecordToolOutcomeSignalResult =
  | Readonly<{
      status: "recorded";
      signalId: string;
      taskId: string;
      category: ToolOutcomeCategory;
      value: 0 | 1;
    }>
  | Readonly<{ status: "skipped"; reason: "indeterminate-status" }>;
