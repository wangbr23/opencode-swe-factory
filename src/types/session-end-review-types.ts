import type { PendingLessonCandidateSummary } from "./lessons-types.js";

export type SessionEndCandidateSummary = Readonly<{
  candidateId: string;
  title: string;
  scope: PendingLessonCandidateSummary["scope"];
  projectId: string | null;
  expiresAt: string;
  requiresAcknowledgment: boolean;
}>;

export type SessionEndCandidateReview = Readonly<{
  removedExpiredCandidateIds: ReadonlyArray<string>;
  pendingCandidates: ReadonlyArray<SessionEndCandidateSummary>;
}>;

export type BuildSessionEndCandidateReviewInput = Readonly<{
  now?: Date;
}>;
