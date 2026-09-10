/**
 * Reclassification operates on the objective outcome-failure surfaces only.
 * "assistant-finish" mirrors EXECUTION_CAPTURE_CONSTANTS.finishSignalKind in
 * the OpenCode adapter; core cannot import adapter constants, so the value is
 * kept in sync by the capture tests.
 */
export const OUTCOME_RECLASSIFICATION_CONSTANTS = Object.freeze({
  reclassifiableSignalKinds: Object.freeze(["tool-outcome", "assistant-finish"]),
  failureKindKey: "failureKind",
  reclassifiedFailureKindKey: "reclassifiedFailureKind",
  notModelCausedKey: "notModelCaused",
  originalExecutionIdKey: "originalExecutionId",
});

export const OUTCOME_DIMENSION_VALUES: ReadonlyArray<string> = Object.freeze([
  "quality",
  "reliability",
  "cost",
  "latency",
]);
