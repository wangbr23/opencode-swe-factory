import type { SecretScanResult } from "../core/secrets.js";

export const DEFAULT_CANDIDATE_REVIEW_WINDOW_DAYS = 7;

export type LessonScope = "project" | "global";

export type LessonCandidateDraft = Readonly<{
  title: string;
  body: string;
  rationale: string;
  applicability: Readonly<Record<string, unknown>>;
  provenance: Readonly<Record<string, unknown>>;
}>;

export type LessonCandidate = Readonly<{
  id: string;
  projectId: string | null;
  scope: LessonScope;
  draft: LessonCandidateDraft;
  secretScan: Pick<SecretScanResult, "disposition" | "findings">;
  requiresAcknowledgment: boolean;
  createdAt: string;
  expiresAt: string;
}>;

export type ApprovedLesson = Readonly<{
  lessonId: string;
  version: number;
  scope: LessonScope;
  projectId: string | null;
  activeVersion: number;
  createdAt: string;
}>;

export type ProposeLessonCandidateInput = Readonly<{
  projectId: string | null;
  scope: LessonScope;
  draft: LessonCandidateDraft;
  secretScan: SecretScanResult;
  now?: Date;
  reviewWindowDays?: number;
}>;

export type LessonCandidateDecision = "approve" | "reject" | "defer";

export type ReviewLessonCandidateInput = Readonly<{
  candidateId: string;
  decision: LessonCandidateDecision;
  /** Required when the candidate's scan disposition is `acknowledgment-required`. */
  acknowledgedSecretRisk?: boolean;
  now?: Date;
}>;

export type LessonCandidateReviewOutcome =
  | Readonly<{ status: "approved"; lesson: ApprovedLesson }>
  | Readonly<{ status: "rejected"; deletedCandidateId: string }>
  | Readonly<{ status: "deferred"; candidateId: string; expiresAt: string }>;

export type PendingLessonCandidateSummary = Readonly<{
  id: string;
  projectId: string | null;
  scope: LessonScope;
  draft: LessonCandidateDraft;
  requiresAcknowledgment: boolean;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
}>;

export type ListPendingCandidatesInput = Readonly<{
  includeExpired?: boolean;
  now?: Date;
}>;

export type CleanupExpiredCandidatesInput = Readonly<{
  now?: Date;
}>;

export type CleanupExpiredCandidatesResult = Readonly<{
  deletedCount: number;
  deletedIds: ReadonlyArray<string>;
}>;
