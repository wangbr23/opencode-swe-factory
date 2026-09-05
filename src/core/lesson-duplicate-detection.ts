import type {
  DetectLessonDuplicatesInput,
  DetectLessonDuplicatesResult,
  LessonOverlapMatch,
  OverlapRelation,
} from "../types/lesson-duplicate-detection-types.js";
import {
  DEFAULT_DETECTION_RETRIEVAL_LIMIT,
  DUPLICATE_BODY_THRESHOLD,
  MINIMUM_OVERLAP_THRESHOLD,
} from "./lesson-duplicate-detection-constants.js";
import { retrieveConfirmedLessonsLexically } from "./lesson-retrieval.js";
import type { SqliteConnection } from "./sqlite.js";

export {
  DEFAULT_DETECTION_RETRIEVAL_LIMIT,
  DUPLICATE_BODY_THRESHOLD,
  MINIMUM_OVERLAP_THRESHOLD,
} from "./lesson-duplicate-detection-constants.js";
export type {
  DetectLessonDuplicatesInput,
  DetectLessonDuplicatesResult,
  LessonOverlapMatch,
  OverlapRelation,
} from "../types/lesson-duplicate-detection-types.js";

function extractTerms(text: string): Set<string> {
  const tokens = text.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const terms = new Set<string>();
  for (const token of tokens) {
    terms.add(token.toLowerCase());
  }
  return terms;
}

function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;
  for (const term of smaller) {
    if (larger.has(term)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return intersection / union;
}

function classifyRelation(bodyOverlap: number): OverlapRelation {
  return bodyOverlap >= DUPLICATE_BODY_THRESHOLD ? "duplicate" : "potential-conflict";
}

/**
 * Retrieves lexically nearby confirmed lessons and classifies each as a
 * potential duplicate or conflict based on term overlap with the candidate
 * draft. Results are sorted by body overlap descending so the strongest
 * matches surface first.
 */
export function detectLessonDuplicatesAndConflicts(
  connection: SqliteConnection,
  input: DetectLessonDuplicatesInput,
): DetectLessonDuplicatesResult {
  const queryText = `${input.draft.title} ${input.draft.body}`;
  const retrievalLimit = input.limit ?? DEFAULT_DETECTION_RETRIEVAL_LIMIT;

  const nearby = retrieveConfirmedLessonsLexically(connection, {
    projectId: input.projectId,
    query: queryText,
    limit: retrievalLimit,
  });

  const excludeSet = new Set(input.excludeLessonIds ?? []);
  const candidateTitleTerms = extractTerms(input.draft.title);
  const candidateBodyTerms = extractTerms(input.draft.body);

  const matches: LessonOverlapMatch[] = [];

  for (const lesson of nearby) {
    if (excludeSet.has(lesson.lessonId)) continue;

    const titleOverlap = jaccardSimilarity(candidateTitleTerms, extractTerms(lesson.title));
    const bodyOverlap = jaccardSimilarity(candidateBodyTerms, extractTerms(lesson.body));

    if (bodyOverlap < MINIMUM_OVERLAP_THRESHOLD && titleOverlap < MINIMUM_OVERLAP_THRESHOLD) {
      continue;
    }

    matches.push({
      lessonId: lesson.lessonId,
      version: lesson.version,
      scope: lesson.scope,
      projectId: lesson.projectId,
      title: lesson.title,
      body: lesson.body,
      relation: classifyRelation(bodyOverlap),
      titleOverlap,
      bodyOverlap,
      lexicalRank: lesson.lexicalRank,
    });
  }

  matches.sort((a, b) => {
    if (b.bodyOverlap !== a.bodyOverlap) return b.bodyOverlap - a.bodyOverlap;
    if (b.titleOverlap !== a.titleOverlap) return b.titleOverlap - a.titleOverlap;
    return a.lessonId < b.lessonId ? -1 : a.lessonId > b.lessonId ? 1 : 0;
  });

  return { matches };
}
