import type { LessonScope } from "./lessons-types.js";

/** A confirmed lesson returned by any retrieval channel. */
export type RetrievedLesson = Readonly<{
  lessonId: string;
  version: number;
  projectId: string | null;
  scope: LessonScope;
  title: string;
  body: string;
  rationale: string;
  applicability: Readonly<Record<string, unknown>>;
  provenance: Readonly<Record<string, unknown>>;
  createdAt: string;
}>;
