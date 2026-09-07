import type {
  SuppressConflictsInput,
  SuppressConflictsResult,
  SuppressedLesson,
} from "../types/lesson-conflict-suppression-types.js";
import type { RetrievedLesson } from "../types/retrieved-lesson-types.js";
import { MINIMUM_OVERLAP_THRESHOLD } from "./lesson-duplicate-detection-constants.js";
import { extractTerms, jaccardSimilarity } from "./lexical-overlap.js";

export type {
  SuppressConflictsInput,
  SuppressConflictsResult,
  SuppressedLesson,
} from "../types/lesson-conflict-suppression-types.js";

/**
 * Filters retrieval results to suppress lessons that conflict with
 * higher-ranked lessons in the same result set. A conflict is detected
 * when two lessons have body term overlap at or above the threshold but
 * below the duplicate threshold — topically related with different content.
 *
 * Results are processed in rank order (project-scoped first, then by BM25).
 * When a conflict is found, the lower-ranked lesson is suppressed.
 */
export function suppressConflictingLessons(input: SuppressConflictsInput): SuppressConflictsResult {
  const threshold = input.bodyConflictThreshold ?? MINIMUM_OVERLAP_THRESHOLD;
  const kept: RetrievedLesson[] = [];
  const suppressed: SuppressedLesson[] = [];
  const keptTerms: Array<{ lessonId: string; terms: ReadonlySet<string> }> = [];

  for (const result of input.results) {
    const resultTerms = extractTerms(result.body);
    let conflictWith: string | undefined;
    let conflictOverlap = 0;

    for (const existing of keptTerms) {
      const overlap = jaccardSimilarity(resultTerms, existing.terms);
      if (overlap >= threshold) {
        conflictWith = existing.lessonId;
        conflictOverlap = overlap;
        break;
      }
    }

    if (conflictWith !== undefined) {
      suppressed.push({
        lessonId: result.lessonId,
        conflictsWith: conflictWith,
        bodyOverlap: conflictOverlap,
      });
    } else {
      kept.push(result);
      keptTerms.push({ lessonId: result.lessonId, terms: resultTerms });
    }
  }

  return { kept, suppressed };
}
