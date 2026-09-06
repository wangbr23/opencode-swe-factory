import { reviewLessonCandidate } from "../core/lessons.js";
import { supersedeLesson } from "../core/lesson-supersession.js";
import type { SqliteConnection } from "../core/sqlite.js";
import type { ProposeLessonToolResult, ScanTextFn } from "../types/lesson-tool-types.js";
import type {
  EditAndReproposeInput,
  ResolveOverlapInput,
  ResolveOverlapResult,
} from "../types/approval-flow-types.js";
import { handleProposeLesson } from "./lesson-tools.js";

export type {
  EditAndReproposeInput,
  ResolveOverlapInput,
  ResolveOverlapResult,
} from "../types/approval-flow-types.js";

export function formatApprovalCard(result: ProposeLessonToolResult): string {
  if (result.status === "blocked") {
    return `Lesson proposal blocked: ${result.reason}`;
  }
  if (result.status === "failed") {
    return `Lesson proposal failed: ${result.error}`;
  }

  const { candidate, overlaps } = result;
  const lines: string[] = [];

  lines.push("Lesson Candidate");
  lines.push("");
  lines.push(`Title: ${candidate.draft.title}`);
  lines.push(`Scope: ${candidate.scope}`);
  if (candidate.projectId !== null) {
    lines.push(`Project: ${candidate.projectId}`);
  }
  lines.push("");
  lines.push(candidate.draft.body);
  lines.push("");
  lines.push(`Rationale: ${candidate.draft.rationale}`);

  if (candidate.requiresAcknowledgment) {
    lines.push("");
    lines.push(
      "Warning: Low-confidence secret findings detected. Approval requires explicit acknowledgment.",
    );
  }

  if (overlaps.length > 0) {
    lines.push("");
    lines.push("Overlapping confirmed lessons:");
    for (const overlap of overlaps) {
      const pct = Math.round(overlap.bodyOverlap * 100);
      lines.push(
        `  [${overlap.relation}] "${overlap.title}" (${overlap.lessonId}, v${overlap.version}, ${overlap.scope}) — ${pct}% body overlap`,
      );
    }
  }

  lines.push("");
  lines.push(`Candidate ID: ${candidate.id}`);

  return lines.join("\n");
}

export async function editAndRepropose(
  connection: SqliteConnection,
  projectId: string | null,
  scanText: ScanTextFn,
  input: EditAndReproposeInput,
): Promise<ProposeLessonToolResult> {
  try {
    reviewLessonCandidate(connection, {
      candidateId: input.candidateId,
      decision: "reject",
    });
  } catch (error) {
    return {
      status: "failed",
      error: `Failed to reject original candidate: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const proposeInput = input.applicability !== undefined && input.provenance !== undefined
    ? { title: input.title, body: input.body, rationale: input.rationale, scope: input.scope, applicability: input.applicability, provenance: input.provenance }
    : input.applicability !== undefined
      ? { title: input.title, body: input.body, rationale: input.rationale, scope: input.scope, applicability: input.applicability }
      : input.provenance !== undefined
        ? { title: input.title, body: input.body, rationale: input.rationale, scope: input.scope, provenance: input.provenance }
        : { title: input.title, body: input.body, rationale: input.rationale, scope: input.scope };

  return handleProposeLesson(connection, projectId, scanText, proposeInput);
}

export function resolveOverlap(
  connection: SqliteConnection,
  input: ResolveOverlapInput,
): ResolveOverlapResult {
  try {
    const supersession = supersedeLesson(connection, {
      lessonId: input.overlappingLessonId,
      draft: input.draft,
    });

    reviewLessonCandidate(connection, {
      candidateId: input.candidateId,
      decision: "reject",
    });

    return { status: "resolved", supersession };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
