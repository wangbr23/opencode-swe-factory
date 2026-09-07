import type { EmbedLessonTextFn } from "./lesson-embedding-index-types.js";
import type { LessonScope } from "./lessons-types.js";
import type { RetrievedLesson } from "./retrieved-lesson-types.js";

export type RetrieveConfirmedLessonsSemanticallyInput = Readonly<{
  projectId: string;
  query: string;
  /** Embeds the query text; the same injectable embedder used for indexing. */
  embed: EmbedLessonTextFn;
  /** Defaults to the pinned embedding model id. */
  model?: string;
  /** Defaults to the pinned embedding model revision. */
  revision?: string;
  limit?: number;
}>;

export type SemanticLessonResult = RetrievedLesson & Readonly<{
  similarity: number;
  semanticRank: number;
}>;

export type SemanticLessonRow = Readonly<{
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
  vector: Uint8Array;
}>;
