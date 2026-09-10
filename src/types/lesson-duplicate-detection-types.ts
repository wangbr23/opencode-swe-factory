import type { LessonCandidateDraft, LessonScope } from "./lessons-types.js";
import type { EmbedLessonTextFn } from "./lesson-embedding-index-types.js";

export type OverlapRelation = "duplicate" | "potential-conflict" | "related";

export type LessonOverlapMatch = Readonly<{
  lessonId: string;
  version: number;
  scope: LessonScope;
  projectId: string | null;
  title: string;
  body: string;
  relation: OverlapRelation;
  titleOverlap: number;
  bodyOverlap: number;
  lexicalRank: number;
  /** Cosine similarity for semantic-only (`related`) matches; absent for lexical matches. */
  semanticSimilarity?: number;
}>;

export type DetectLessonDuplicatesInput = Readonly<{
  draft: LessonCandidateDraft;
  projectId: string;
  excludeLessonIds?: ReadonlyArray<string>;
  limit?: number;
  /** Optional embedder enabling the additive semantic pass; absent means lexical-only. */
  embed?: EmbedLessonTextFn;
}>;

export type DetectLessonDuplicatesResult = Readonly<{
  matches: ReadonlyArray<LessonOverlapMatch>;
}>;