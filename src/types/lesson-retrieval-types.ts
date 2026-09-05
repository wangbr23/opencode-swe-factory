import type { LessonScope } from "./lessons-types.js";

export type RetrieveConfirmedLessonsLexicallyInput = Readonly<{
  projectId: string;
  query: string;
  limit?: number;
}>;

export type LexicalLessonResult = Readonly<{
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
  lexicalRank: number;
}>;

export type LexicalLessonRow = Readonly<{
  lesson_id: string;
  lesson_version: number;
  project_id: string | null;
  scope: LessonScope;
  title: string;
  body: string;
  rationale: string;
  applicability_json: string;
  provenance_json: string;
  created_at: string;
  lexical_score: number;
}>;
