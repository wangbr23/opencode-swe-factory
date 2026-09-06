import type { LexicalLessonResult } from "./lesson-retrieval-types.js";

export type SuppressConflictsInput = Readonly<{
  results: ReadonlyArray<LexicalLessonResult>;
  bodyConflictThreshold?: number;
}>;

export type SuppressConflictsResult = Readonly<{
  kept: ReadonlyArray<LexicalLessonResult>;
  suppressed: ReadonlyArray<SuppressedLesson>;
}>;

export type SuppressedLesson = Readonly<{
  lessonId: string;
  conflictsWith: string;
  bodyOverlap: number;
}>;
