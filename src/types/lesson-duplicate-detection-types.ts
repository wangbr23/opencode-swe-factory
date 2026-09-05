import type { LessonCandidateDraft, LessonScope } from "./lessons-types.js";

export type OverlapRelation = "duplicate" | "potential-conflict";

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
}>;

export type DetectLessonDuplicatesInput = Readonly<{
  draft: LessonCandidateDraft;
  projectId: string;
  excludeLessonIds?: ReadonlyArray<string>;
  limit?: number;
}>;

export type DetectLessonDuplicatesResult = Readonly<{
  matches: ReadonlyArray<LessonOverlapMatch>;
}>;
