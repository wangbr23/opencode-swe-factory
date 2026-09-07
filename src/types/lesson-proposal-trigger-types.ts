import type { LessonCandidate } from "./lessons-types.js";
import type { ToolOutcomeCategory } from "./tool-outcome-signal-types.js";

export type LessonProposalTriggerKind = "strong-signal" | "repeated-success";

export type LessonProposalTriggerReason =
  | "no-qualifying-tasks"
  | "below-repeated-success-threshold"
  | "pending-automatic-candidate";

export type ProposalTaskProfileSnapshot = Readonly<{
  activity: string | null;
  domain: string | null;
  complexity: string;
  risk: string;
  stack: ReadonlyArray<string>;
  summary: string;
}>;

/**
 * One completed task whose effective (non-superseded) evidence contains at
 * least one positive signal. Tasks whose evidence is empty or fully negative
 * never appear here — silence is never treated as success.
 */
export type QualifyingTaskEvidence = Readonly<{
  taskId: string;
  verifiedCategories: ReadonlyArray<ToolOutcomeCategory>;
  hasExplicitAcceptance: boolean;
  latestPositiveObservedAt: string;
  profile: ProposalTaskProfileSnapshot | null;
}>;

export type EvaluateLessonProposalTriggerInput = Readonly<{
  projectId: string;
  now?: Date;
  /**
   * Distinct verified-success tasks required for the repeated-success trigger.
   * Must be at least 2 — a single unattended success is not "repeated".
   */
  minVerifiedSuccesses?: number;
  /** Only consider tasks completed at or after this ISO instant. */
  since?: string;
  reviewWindowDays?: number;
}>;

export type LessonProposalTriggerResult =
  | Readonly<{
      status: "triggered";
      triggerKind: LessonProposalTriggerKind;
      candidate: LessonCandidate;
      evidence: ReadonlyArray<QualifyingTaskEvidence>;
    }>
  | Readonly<{
      status: "blocked";
      reason: string;
      triggerKind: LessonProposalTriggerKind;
      evidence: ReadonlyArray<QualifyingTaskEvidence>;
    }>
  | Readonly<{
      status: "no-trigger";
      reason: LessonProposalTriggerReason;
      qualifyingTaskCount: number;
      strongSignalTaskCount: number;
    }>;
