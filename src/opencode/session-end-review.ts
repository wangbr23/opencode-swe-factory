import { buildSessionEndCandidateReview } from "../core/session-end-review.js";
import { writeLocalDiagnostic } from "../core/diagnostics.js";
import { join } from "node:path";
import type { SqliteConnection } from "../core/sqlite.js";
import type { ResolvedFeatureToggles } from "../types/feature-toggle-types.js";
import type { SessionEndCandidateReview } from "../types/session-end-review-types.js";

export type SessionEndReviewState = Readonly<{
  remindedSignatureBySession: Map<string, string>;
}>;

export type HandleSessionIdleInput = Readonly<{
  sessionId: string;
  diagnosticsPath: string;
}>;

export type HandleSessionIdleResult =
  | Readonly<{ status: "skipped"; reason: "disabled" }>
  | Readonly<{ status: "already-reminded" }>
  | Readonly<{ status: "reminded"; review: SessionEndCandidateReview }>;

export function createSessionEndReviewState(): SessionEndReviewState {
  return { remindedSignatureBySession: new Map() };
}

export function describeSessionEndReminder(review: SessionEndCandidateReview): string {
  const lines = review.pendingCandidates.map(
    (candidate) =>
      `${candidate.candidateId} "${candidate.title}" (${candidate.scope}, expires ${candidate.expiresAt})`,
  );
  return `Deferred lesson candidates pending review (${lines.length}). Use swe_factory_commit_lesson to approve or reject each: ${lines.join("; ")}.`;
}

export async function handleSessionIdle(
  state: SessionEndReviewState,
  connection: SqliteConnection,
  toggles: ResolvedFeatureToggles,
  input: HandleSessionIdleInput,
): Promise<HandleSessionIdleResult> {
  const review = buildSessionEndCandidateReview(connection);

  if (toggles.privateMode || !toggles.recording) {
    return { status: "skipped", reason: "disabled" };
  }

  const signature = review.pendingCandidates.map((candidate) => candidate.candidateId).join(",");
  if (state.remindedSignatureBySession.get(input.sessionId) === signature) {
    return { status: "already-reminded" };
  }
  state.remindedSignatureBySession.set(input.sessionId, signature);

  if (review.pendingCandidates.length > 0) {
    await writeLocalDiagnostic(
      {
        component: "lessons",
        code: "deferred-candidate-reminder",
        severity: "info",
        summary: describeSessionEndReminder(review),
      },
      { filePath: join(input.diagnosticsPath, "diagnostics.jsonl") },
    );
  }

  return { status: "reminded", review };
}
