import { cleanupExpiredCandidates, listPendingLessonCandidates } from "./lessons.js";
import type { SqliteConnection } from "../db/sqlite.js";
import type {
  BuildSessionEndCandidateReviewInput,
  SessionEndCandidateReview,
} from "../../types/session-end-review-types.js";

export function buildSessionEndCandidateReview(
  connection: SqliteConnection,
  input?: BuildSessionEndCandidateReviewInput,
): SessionEndCandidateReview {
  const now = input?.now ?? new Date();

  const expired = cleanupExpiredCandidates(connection, { now });
  const pending = listPendingLessonCandidates(connection, { now });

  return {
    removedExpiredCandidateIds: expired.deletedIds,
    pendingCandidates: pending.map((candidate) => ({
      candidateId: candidate.id,
      title: candidate.draft.title,
      scope: candidate.scope,
      projectId: candidate.projectId,
      expiresAt: candidate.expiresAt,
      requiresAcknowledgment: candidate.requiresAcknowledgment,
    })),
  };
}
