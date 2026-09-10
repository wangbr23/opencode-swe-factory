import type { ToolFailureKind } from "./tool-outcome-signal-types.js";

/**
 * Attribution state the corrected signal has relative to model evidence:
 * "unchanged" keeps the original execution link, "withdrawn" removes it so
 * aggregation stops attributing the failure to the executing model, and
 * "restored" re-links a previously withdrawn failure.
 */
export type OutcomeFailureAttributionState = "unchanged" | "withdrawn" | "restored";

export type ReclassifyOutcomeFailureInput = Readonly<{
  taskId: string;
  signalId: string;
  /** Corrected failure classification; omit to change attribution only. */
  failureKind?: ToolFailureKind;
  /**
   * Withdraw the failure's attribution to the executing model. Omitting it
   * restores the original execution link when the signal was withdrawn.
   */
  notModelCaused?: boolean;
  now?: Date;
}>;

export type ReclassifyOutcomeFailureResult = Readonly<{
  signalId: string;
  taskId: string;
  supersededSignalId: string;
  failureKind?: ToolFailureKind;
  previousFailureKind?: ToolFailureKind;
  attribution: OutcomeFailureAttributionState;
}>;
