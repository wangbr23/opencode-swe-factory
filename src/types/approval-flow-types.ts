import type { LessonScope } from "./lessons-types.js";

export type EditAndReproposeInput = Readonly<{
  candidateId: string;
  title: string;
  body: string;
  rationale: string;
  scope: LessonScope;
  applicability?: Readonly<Record<string, unknown>>;
  provenance?: Readonly<Record<string, unknown>>;
}>;
