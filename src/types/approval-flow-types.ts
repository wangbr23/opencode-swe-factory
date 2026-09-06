import type { LessonCandidateDraft, LessonScope } from "./lessons-types.js";
import type { SupersedeLessonResult } from "./lesson-supersession-types.js";

export type EditAndReproposeInput = Readonly<{
  candidateId: string;
  title: string;
  body: string;
  rationale: string;
  scope: LessonScope;
  applicability?: Readonly<Record<string, unknown>>;
  provenance?: Readonly<Record<string, unknown>>;
}>;

export type ResolveOverlapInput = Readonly<{
  candidateId: string;
  overlappingLessonId: string;
  draft: LessonCandidateDraft;
}>;

export type ResolveOverlapResult =
  | Readonly<{ status: "resolved"; supersession: SupersedeLessonResult }>
  | Readonly<{ status: "failed"; error: string }>;
