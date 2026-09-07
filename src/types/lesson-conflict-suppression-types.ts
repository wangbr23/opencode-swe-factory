import type { RetrievedLesson } from "./retrieved-lesson-types.js";

export type SuppressConflictsInput = Readonly<{
  results: ReadonlyArray<RetrievedLesson>;
  bodyConflictThreshold?: number;
}>;

export type SuppressConflictsResult = Readonly<{
  kept: ReadonlyArray<RetrievedLesson>;
  suppressed: ReadonlyArray<SuppressedLesson>;
}>;

export type SuppressedLesson = Readonly<{
  lessonId: string;
  conflictsWith: string;
  bodyOverlap: number;
}>;
