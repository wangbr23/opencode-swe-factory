import type { EmbedLessonTextFn } from "./lesson-embedding-index-types.js";
import type { LexicalLessonResult } from "./lesson-retrieval-types.js";
import type { SemanticLessonResult } from "./lesson-semantic-retrieval-types.js";
import type { RetrievedLesson } from "./retrieved-lesson-types.js";

export type LessonRetrievalTaskProfile = Readonly<{
  activity?: string | null;
  domain?: string | null;
  complexity?: string | null;
  stack?: ReadonlyArray<string>;
}>;

export type HybridScoreContributions = Readonly<{
  reciprocalRankFusion: number;
  exactTaskDimensions: number;
}>;

export type HybridLessonResult = RetrievedLesson & Readonly<{
  lexicalRank: number | null;
  semanticRank: number | null;
  similarity: number | null;
  score: number;
  /** Project scope is an absolute ordering rule, not a numeric score contribution. */
  contributions: HybridScoreContributions;
}>;

export type SemanticRetrievalAvailability =
  | Readonly<{ status: "available"; candidateCount: number }>
  | Readonly<{ status: "unavailable"; candidateCount: 0; error: string }>;

export type FuseLessonRetrievalInput = Readonly<{
  lexical: ReadonlyArray<LexicalLessonResult>;
  semantic: ReadonlyArray<SemanticLessonResult>;
  taskProfile?: LessonRetrievalTaskProfile;
  limit?: number;
}>;

export type RetrieveConfirmedLessonsHybridInput = Readonly<{
  projectId: string;
  query: string;
  limit?: number;
  taskProfile?: LessonRetrievalTaskProfile;
  /** Omitting the optional local embedder retains lexical-only retrieval. */
  embed?: EmbedLessonTextFn;
}>;

export type HybridLessonRetrievalResult = Readonly<{
  lessons: ReadonlyArray<HybridLessonResult>;
  semantic: SemanticRetrievalAvailability;
}>;
