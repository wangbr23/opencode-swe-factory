import type {
  FuseLessonRetrievalInput,
  HybridLessonResult,
  HybridLessonRetrievalResult,
  LessonRetrievalTaskProfile,
  RetrieveConfirmedLessonsHybridInput,
  SemanticRetrievalAvailability,
} from "../../types/lesson-hybrid-retrieval-types.js";
import type { LexicalLessonResult } from "../../types/lesson-retrieval-types.js";
import type { SemanticLessonResult } from "../../types/lesson-semantic-retrieval-types.js";
import {
  DEFAULT_HYBRID_LESSON_LIMIT,
  EXACT_TASK_DIMENSION_BOOST,
  MAX_HYBRID_LESSON_LIMIT,
  RECIPROCAL_RANK_FUSION_K,
} from "./lesson-hybrid-retrieval-constants.js";
import { retrieveConfirmedLessonsLexically } from "./lesson-retrieval.js";
import { retrieveConfirmedLessonsSemantically } from "./lesson-semantic-retrieval.js";
import type { SqliteConnection } from "../db/sqlite.js";

export {
  DEFAULT_HYBRID_LESSON_LIMIT,
  EXACT_TASK_DIMENSION_BOOST,
  MAX_HYBRID_LESSON_LIMIT,
  RECIPROCAL_RANK_FUSION_K,
} from "./lesson-hybrid-retrieval-constants.js";
export type {
  FuseLessonRetrievalInput,
  HybridLessonResult,
  HybridLessonRetrievalResult,
  LessonRetrievalTaskProfile,
  RetrieveConfirmedLessonsHybridInput,
  SemanticRetrievalAvailability,
} from "../../types/lesson-hybrid-retrieval-types.js";

export class LessonHybridRetrievalInputError extends Error {}

function resolveLimit(limit: number | undefined): number {
  const resolved = limit ?? DEFAULT_HYBRID_LESSON_LIMIT;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > MAX_HYBRID_LESSON_LIMIT) {
    throw new LessonHybridRetrievalInputError(
      `limit must be a positive safe integer no greater than ${MAX_HYBRID_LESSON_LIMIT}.`,
    );
  }
  return resolved;
}

function identity(lesson: { lessonId: string; version: number }): string {
  return `${lesson.lessonId}:${lesson.version}`;
}

function validateRank(rank: number, label: string): void {
  if (!Number.isSafeInteger(rank) || rank <= 0) {
    throw new LessonHybridRetrievalInputError(`${label} must be a positive safe integer.`);
  }
}

function normalizedStrings(value: unknown): ReadonlySet<string> {
  const values = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  const normalized = values
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return new Set(normalized);
}

function matchingDimensionCount(
  lesson: LexicalLessonResult | SemanticLessonResult,
  profile: LessonRetrievalTaskProfile | undefined,
): number {
  if (!profile) {
    return 0;
  }

  const applicability = lesson.applicability;
  const profileValue = (dimension: "activity" | "domain" | "complexity"): string | null => {
    const value = profile[dimension];
    if (typeof value !== "string") {
      return null;
    }
    const normalized = value.trim().toLowerCase();
    return normalized.length > 0 ? normalized : null;
  };

  const activity = profileValue("activity");
  const domain = profileValue("domain");
  const complexity = profileValue("complexity");
  const stack = (profile.stack ?? [])
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  const activityConstraints = new Set([
    ...normalizedStrings(applicability.activity),
    ...normalizedStrings(applicability.taskTypes),
  ]);

  const constrainedDimensions = [
    {
      constraints: activityConstraints,
      values: activity === null ? [] : [activity],
    },
    {
      constraints: normalizedStrings(applicability.domain),
      values: domain === null ? [] : [domain],
    },
    {
      constraints: normalizedStrings(applicability.complexity),
      values: complexity === null ? [] : [complexity],
    },
    {
      constraints: normalizedStrings(applicability.languages),
      values: stack,
    },
  ];

  let matches = 0;
  for (const dimension of constrainedDimensions) {
    if (dimension.constraints.size === 0 || dimension.values.length === 0) {
      continue;
    }

    if (!dimension.values.some((value) => dimension.constraints.has(value))) {
      return -1;
    }

    matches += 1;
  }

  return matches;
}

export function fuseLessonRetrieval(
  input: FuseLessonRetrievalInput,
): ReadonlyArray<HybridLessonResult> {
  const limit = resolveLimit(input.limit);
  for (const lesson of input.lexical) validateRank(lesson.lexicalRank, "lexicalRank");
  for (const lesson of input.semantic) validateRank(lesson.semanticRank, "semanticRank");
  const lexical = new Map(input.lexical.map((lesson) => [identity(lesson), lesson]));
  const semantic = new Map(input.semantic.map((lesson) => [identity(lesson), lesson]));
  const identities = new Set([...lexical.keys(), ...semantic.keys()]);
  const fused: HybridLessonResult[] = [];

  for (const key of identities) {
    const lexicalLesson = lexical.get(key);
    const semanticLesson = semantic.get(key);
    const lesson = lexicalLesson ?? semanticLesson;
    if (!lesson) continue;

    const reciprocalRankFusion =
      (lexicalLesson ? 1 / (RECIPROCAL_RANK_FUSION_K + lexicalLesson.lexicalRank) : 0)
      + (semanticLesson ? 1 / (RECIPROCAL_RANK_FUSION_K + semanticLesson.semanticRank) : 0);
    const matchedDimensions = matchingDimensionCount(lesson, input.taskProfile);
    if (matchedDimensions < 0) continue;

    const exactTaskDimensions = matchedDimensions * EXACT_TASK_DIMENSION_BOOST;
    const contributions = {
      reciprocalRankFusion,
      exactTaskDimensions,
    };
    const score = reciprocalRankFusion + exactTaskDimensions;

    fused.push({
      ...lesson,
      lexicalRank: lexicalLesson?.lexicalRank ?? null,
      semanticRank: semanticLesson?.semanticRank ?? null,
      similarity: semanticLesson?.similarity ?? null,
      score,
      contributions,
    });
  }

  return fused
    .sort((left, right) => {
      if (left.scope !== right.scope) return left.scope === "project" ? -1 : 1;
      if (right.score !== left.score) return right.score - left.score;
      return left.lessonId === right.lessonId
        ? left.version - right.version
        : (left.lessonId < right.lessonId ? -1 : 1);
    })
    .slice(0, limit);
}

export async function retrieveConfirmedLessonsHybrid(
  connection: SqliteConnection,
  input: RetrieveConfirmedLessonsHybridInput,
): Promise<HybridLessonRetrievalResult> {
  const limit = resolveLimit(input.limit);
  const lexical = retrieveConfirmedLessonsLexically(connection, {
    projectId: input.projectId,
    query: input.query,
    limit,
  });
  const fusionInput = {
    lexical,
    ...(input.taskProfile !== undefined ? { taskProfile: input.taskProfile } : {}),
    limit,
  };

  if (input.embed === undefined) {
    const lessons = fuseLessonRetrieval({
      ...fusionInput,
      semantic: [],
    });

    return {
      lessons,
      semantic: {
        status: "unavailable",
        candidateCount: 0,
        error: "Local embedding runtime is unavailable.",
      },
    };
  }
  try {
    const semantic = await retrieveConfirmedLessonsSemantically(connection, {
      projectId: input.projectId,
      query: input.query,
      limit,
      embed: input.embed,
    });
    const availability: SemanticRetrievalAvailability = {
      status: "available",
      candidateCount: semantic.length,
    };

    return {
      lessons: fuseLessonRetrieval({
        ...fusionInput,
        semantic,
      }),
      semantic: availability,
    };
  } catch (error) {
    const lessons = fuseLessonRetrieval({
      ...fusionInput,
      semantic: [],
    });

    return {
      lessons,
      semantic: {
        status: "unavailable",
        candidateCount: 0,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
