import type { ToolOutcomeCategory } from "../../types/tool-outcome-signal-types.js";

/**
 * Tool-outcome categories that count as objective verification of a method.
 * The `generic` category is deliberately excluded: a passing generic command
 * is not evidence that a coding method worked.
 */
export const VERIFICATION_CATEGORIES: ReadonlyArray<ToolOutcomeCategory> = Object.freeze([
  "test",
  "lint",
  "typecheck",
  "build",
  "review",
]);

export const LESSON_PROPOSAL_TRIGGER_CONSTANTS = Object.freeze({
  /**
   * Provenance marker placed on every automatically generated draft. The
   * evaluator uses it to find already-proposed evidence tasks, so repeated
   * evaluations only accumulate fresh successes.
   */
  automaticProvenanceTrigger: "automatic",
  defaultMinVerifiedSuccesses: 3,
});
