import { proposeLessonCandidate, reviewLessonCandidate } from "../core/lessons/lessons.js";
import { detectLessonDuplicatesAndConflicts } from "../core/lessons/lesson-duplicate-detection.js";
import type { SqliteConnection } from "../core/db/sqlite.js";
import type {
  CommitLessonToolInput,
  CommitLessonToolResult,
  ProposeLessonToolInput,
  ProposeLessonToolResult,
  ScanTextFn,
} from "../types/lesson-tool-types.js";

export type {
  CommitLessonToolInput,
  CommitLessonToolResult,
  ProposeLessonToolInput,
  ProposeLessonToolResult,
  ScanTextFn,
} from "../types/lesson-tool-types.js";

export async function handleProposeLesson(
  connection: SqliteConnection,
  projectId: string | null,
  scanText: ScanTextFn,
  input: ProposeLessonToolInput,
): Promise<ProposeLessonToolResult> {
  try {
    const textToScan = `${input.title}\n${input.body}`;
    const secretScan = await scanText(textToScan);

    if (secretScan.disposition === "blocked") {
      return {
        status: "blocked",
        reason: "High-confidence secret findings prevent this lesson from being proposed.",
      };
    }

    const effectiveProjectId = input.scope === "project" ? projectId : null;

    const candidate = proposeLessonCandidate(connection, {
      projectId: effectiveProjectId,
      scope: input.scope,
      draft: {
        title: input.title,
        body: input.body,
        rationale: input.rationale,
        applicability: input.applicability ?? {},
        provenance: input.provenance ?? {},
      },
      secretScan,
    });

    const detectionProjectId = projectId ?? "__no_project__";
    const { matches } = detectLessonDuplicatesAndConflicts(connection, {
      draft: candidate.draft,
      projectId: detectionProjectId,
    });

    return { status: "proposed", candidate, overlaps: matches };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function handleCommitLesson(
  connection: SqliteConnection,
  input: CommitLessonToolInput,
): CommitLessonToolResult {
  try {
    const reviewInput = input.acknowledgedSecretRisk !== undefined
      ? { candidateId: input.candidateId, decision: input.decision, acknowledgedSecretRisk: input.acknowledgedSecretRisk }
      : { candidateId: input.candidateId, decision: input.decision };

    const outcome = reviewLessonCandidate(connection, reviewInput);
    return { status: "committed", outcome };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
