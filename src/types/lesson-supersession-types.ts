import type { LessonCandidateDraft } from "../core/lessons.js";

export type LessonVersionSnapshot = Readonly<{
  lessonId: string;
  version: number;
  title: string;
  body: string;
  rationale: string;
  applicability: Readonly<Record<string, unknown>>;
  provenance: Readonly<Record<string, unknown>>;
  supersededByVersion: number | null;
  createdAt: string;
}>;

export type SupersedeLessonInput = Readonly<{
  lessonId: string;
  draft: LessonCandidateDraft;
  now?: Date;
}>;

export type SupersedeLessonResult = Readonly<{
  lessonId: string;
  supersededVersion: number;
  version: number;
  activeVersion: number;
}>;
