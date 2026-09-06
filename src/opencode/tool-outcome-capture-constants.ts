export const TOOL_OUTCOME_CAPTURE_CONSTANTS = Object.freeze({
  bashToolName: "bash",
  bashCommandArg: "command",
  metadataExitKeys: ["exit", "exitCode"],
  metadataAbortedKey: "aborted",
  metadataErrorKey: "error",
  errorNameKey: "name",
  errorCodeKey: "statusCode",
  authenticationStatusCodes: new Set([401, 403]),
  providerStatusThreshold: 429,
});
