import {
  LessonCandidateError,
  LessonCandidateExpiredError,
  readPendingCandidate,
  reviewLessonCandidate,
} from "./lessons.js";
import { LessonSupersessionError, inspectLesson, supersedeLesson, type LessonInspection } from "./lesson-supersession.js";
import type { PendingLessonCandidateSummary } from "../../types/lessons-types.js";
import type {
  ResolveOverlapResult,
  ResolvePendingLessonOverlapInput,
} from "../../types/lesson-overlap-resolution-types.js";
import type { SqliteConnection } from "../db/sqlite.js";

export type {
  ResolveOverlapResult,
  ResolvePendingLessonOverlapInput,
} from "../../types/lesson-overlap-resolution-types.js";

function requireOverlappingLesson(connection: SqliteConnection, lessonId: string): LessonInspection {
  const inspection = inspectLesson(connection, lessonId);
  if (inspection === null) {
    throw new LessonSupersessionError(lessonId, `Lesson ${lessonId} was not found.`);
  }
  return inspection;
}

function assertCandidateNotExpired(candidate: PendingLessonCandidateSummary): void {
  if (!candidate.expired) return;
  throw new LessonCandidateExpiredError(
    `Pending lesson candidate ${candidate.id} expired at ${candidate.expiresAt}.`,
    candidate.id,
  );
}

function assertSameScopeAndProject(candidate: PendingLessonCandidateSummary, target: LessonInspection): void {
  const matches = candidate.scope === target.scope && candidate.projectId === target.projectId;
  if (matches) return;
  throw new LessonCandidateError(
    `Lesson candidate ${candidate.id} (${candidate.scope} scope, project ${candidate.projectId ?? "none"}) does not match lesson ${target.lessonId} (${target.scope} scope, project ${target.projectId ?? "none"}).`,
    candidate.id,
  );
}

/**
 * Project-scoped resolutions must come from the candidate's own project, so an
 * agent in one project cannot resolve another project's pending candidate.
 * Global candidates are shared and carry no caller-project requirement.
 */
function assertCallerAuthorized(candidate: PendingLessonCandidateSummary, callerProjectId: string | null): void {
  if (candidate.scope !== "project") return;
  if (callerProjectId !== candidate.projectId) {
    throw new LessonCandidateError(
      `Lesson candidate ${candidate.id} belongs to project ${candidate.projectId}; resolution requires the caller's project to match.`,
      candidate.id,
    );
  }
}

function assertSecretAcknowledgment(candidate: PendingLessonCandidateSummary, acknowledgedSecretRisk: boolean | undefined): void {
  if (!candidate.requiresAcknowledgment || acknowledgedSecretRisk === true) return;
  throw new LessonCandidateError(
    "Candidate carries low-confidence secret findings; approval requires explicit acknowledgment.",
    candidate.id,
  );
}

/**
 * Resolves an overlap by superseding the overlapping lesson's active version
 * with the candidate's stored draft and rejecting the candidate in a single
 * transaction. Guards run before any mutation: the candidate must exist and
 * be unexpired, the candidate and target lesson must match in scope and
 * project exactly, a project-scoped candidate must belong to the caller's
 * project, and an acknowledgment-required candidate demands the same explicit
 * secret acknowledgment as approval. Any guard failure or mutation failure
 * rolls back the whole operation.
 */
export function resolvePendingLessonOverlap(
  connection: SqliteConnection,
  input: ResolvePendingLessonOverlapInput,
): ResolveOverlapResult {
  const now = input.now ?? new Date();

  try {
    return connection.database.transaction((): ResolveOverlapResult => {
      const candidate = readPendingCandidate(connection, input.candidateId, now);
      assertCandidateNotExpired(candidate);
      const target = requireOverlappingLesson(connection, input.overlappingLessonId);
      assertSameScopeAndProject(candidate, target);
      assertCallerAuthorized(candidate, input.callerProjectId);
      assertSecretAcknowledgment(candidate, input.acknowledgedSecretRisk);

      const supersession = supersedeLesson(connection, {
        lessonId: target.lessonId,
        draft: candidate.draft,
        now,
      });
      reviewLessonCandidate(connection, { candidateId: candidate.id, decision: "reject", now });

      return { status: "resolved", supersession };
    })();
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}