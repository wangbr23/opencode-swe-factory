import type { LessonCandidateDraft, LessonScope } from "./lessons-types.js";

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

export type { ResolveOverlapResult } from "./lesson-overlap-resolution-types.js";
