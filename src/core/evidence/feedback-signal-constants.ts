import type { ExplicitFeedbackKind, ExplicitFeedbackValue } from "../../types/feedback-signal-types.js";

/**
 * Quality value contributed by each explicit feedback kind. Acceptance is the
 * only positive control; corrections and reworks are negative.
 */
export const EXPLICIT_FEEDBACK_VALUES: Readonly<Record<ExplicitFeedbackKind, ExplicitFeedbackValue>> =
  Object.freeze({
    acceptance: 1,
    correction: 0,
    rework: 0,
  });

export const FEEDBACK_SIGNAL_CONSTANTS = Object.freeze({
  /** Outcome-signal kind for every explicitly recorded feedback control. */
  signalKind: "explicit-feedback",
  signalSource: "explicit-user-feedback",
  exactConfidence: 1,
  /**
   * Outcome-signal kind for the strong negative quality evidence recorded when
   * a confirmed correction lesson links back to an affected execution.
   */
  correctionLessonKind: "correction-lesson",
  correctionLessonSource: "confirmed-lesson",
  acceptanceFeedbackKind: "acceptance" as ExplicitFeedbackKind,
});
