import type {
  DetectLessonDuplicatesInput,
  DetectLessonDuplicatesResult,
  LessonOverlapMatch,
  OverlapRelation,
} from "../../types/lesson-duplicate-detection-types.js";
import {
  DEFAULT_DETECTION_RETRIEVAL_LIMIT,
  DUPLICATE_BODY_THRESHOLD,
  MINIMUM_OVERLAP_THRESHOLD,
  RELATED_SEMANTIC_SIMILARITY_CUTOFF,
} from "./lesson-duplicate-detection-constants.js";
import { retrieveConfirmedLessonsLexically } from "./lesson-retrieval.js";
import { retrieveConfirmedLessonsSemantically } from "./lesson-semantic-retrieval.js";
import { extractTerms, jaccardSimilarity } from "./lexical-overlap.js";
import type { SqliteConnection } from "../db/sqlite.js";

export {
  DEFAULT_DETECTION_RETRIEVAL_LIMIT,
  DUPLICATE_BODY_THRESHOLD,
  MINIMUM_OVERLAP_THRESHOLD,
  RELATED_SEMANTIC_SIMILARITY_CUTOFF,
} from "./lesson-duplicate-detection-constants.js";
export type {
  DetectLessonDuplicatesInput,
  DetectLessonDuplicatesResult,
  LessonOverlapMatch,
  OverlapRelation,
} from "../../types/lesson-duplicate-detection-types.js";

function classifyRelation(bodyOverlap: number): OverlapRelation {
  return bodyOverlap >= DUPLICATE_BODY_THRESHOLD ? "duplicate" : "potential-conflict";
}

function lexicalMatches(
  connection: SqliteConnection,
  input: DetectLessonDuplicatesInput,
  retrievalLimit: number,
): LessonOverlapMatch[] {
  const queryText = `${input.draft.title} ${input.draft.body}`;

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

  return matches;
}

/**
 * Semantic-only matches surface as the weaker `related` relation with cosine
 * similarity evidence; they never inherit the lexical conflict classifier.
 * Failure degrades to lexical-only (embedder absent, cold, artifact missing,
 * or throwing) so proposals never block on the semantic pass.
 */
async function relatedMatches(
  connection: SqliteConnection,
  input: DetectLessonDuplicatesInput,
  retrievalLimit: number,
  matchedLessonIds: ReadonlySet<string>,
): Promise<LessonOverlapMatch[]> {
  if (input.embed === undefined) return [];

  try {
    const semantic = await retrieveConfirmedLessonsSemantically(connection, {
      projectId: input.projectId,
      query: `${input.draft.title} ${input.draft.body}`,
      embed: input.embed,
      limit: retrievalLimit,
    });

    const excludeSet = new Set(input.excludeLessonIds ?? []);
    const matches: LessonOverlapMatch[] = [];
    for (const lesson of semantic) {
      if (lesson.similarity < RELATED_SEMANTIC_SIMILARITY_CUTOFF) continue;
      if (matchedLessonIds.has(lesson.lessonId) || excludeSet.has(lesson.lessonId)) continue;
      matches.push({
        lessonId: lesson.lessonId,
        version: lesson.version,
        scope: lesson.scope,
        projectId: lesson.projectId,
        title: lesson.title,
        body: lesson.body,
        relation: "related",
        titleOverlap: 0,
        bodyOverlap: 0,
        lexicalRank: 0,
        semanticSimilarity: lesson.similarity,
      });
    }
    return matches;
  } catch {
    // Fail-open: lexical detection is the guaranteed floor.
    return [];
  }
}

/**
 * Retrieves lexically nearby confirmed lessons and classifies each as a
 * potential duplicate or conflict based on term overlap with the candidate
 * draft. When an embedder is provided, an additive semantic pass surfaces
 * differently-phrased neighbors as `related` matches; lexical metadata wins
 * on dedupe. Results are sorted by body overlap descending so the strongest
 * matches surface first.
 */
export async function detectLessonDuplicatesAndConflicts(
  connection: SqliteConnection,
  input: DetectLessonDuplicatesInput,
): Promise<DetectLessonDuplicatesResult> {
  const retrievalLimit = input.limit ?? DEFAULT_DETECTION_RETRIEVAL_LIMIT;

  const matches = lexicalMatches(connection, input, retrievalLimit);
  const matchedLessonIds = new Set(matches.map((match) => match.lessonId));
  const semantic = await relatedMatches(connection, input, retrievalLimit, matchedLessonIds);

  matches.sort((a, b) => {
    if (b.bodyOverlap !== a.bodyOverlap) return b.bodyOverlap - a.bodyOverlap;
    if (b.titleOverlap !== a.titleOverlap) return b.titleOverlap - a.titleOverlap;
    return a.lessonId < b.lessonId ? -1 : a.lessonId > b.lessonId ? 1 : 0;
  });

  return { matches: [...matches, ...semantic] };
}