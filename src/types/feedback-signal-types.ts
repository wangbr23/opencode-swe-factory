import type { OutcomeDimension } from "./execution-profile-types.js";

/**
 * The explicit feedback controls the design recognizes as high-confidence
 * quality evidence: acceptance of the delivered work, a correction that
 * supplies the right answer, and a rework request without guidance.
 */
export type ExplicitFeedbackKind = "acceptance" | "correction" | "rework";

export type ExplicitFeedbackValue = 0 | 1;

export type ExplicitFeedbackSignalMetadata = Readonly<{
  feedbackKind: ExplicitFeedbackKind;
}>;

export type RecordExplicitFeedbackInput = Readonly<{
  taskId: string;
  feedbackKind: ExplicitFeedbackKind;
  observedAt?: Date;
  now?: Date;
}>;

export type RecordExplicitFeedbackResult = Readonly<{
  status: "recorded";
  signalId: string;
  taskId: string;
  feedbackKind: ExplicitFeedbackKind;
  value: ExplicitFeedbackValue;
  /** Set when this negative feedback retracted the task's latest acceptance. */
  supersededSignalId?: string;
}>;

export type RecordCorrectionLessonEvidenceInput = Readonly<{
  taskId: string;
  lessonId: string;
  lessonVersion: number;
  executionId?: string;
  observedAt?: Date;
  now?: Date;
}>;

export type RecordCorrectionLessonEvidenceResult = Readonly<{
  signalId: string;
  taskId: string;
  lessonId: string;
  lessonVersion: number;
  executionId?: string;
}>;

export type DerivedFeedbackSignalShape = Readonly<{
  dimension: OutcomeDimension;
  kind: string;
  source: string;
  confidence: number;
  value: ExplicitFeedbackValue;
  metadata: ExplicitFeedbackSignalMetadata;
}>;
