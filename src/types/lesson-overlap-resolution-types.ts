import type { SupersedeLessonResult } from "./lesson-supersession-types.js";

export type ResolvePendingLessonOverlapInput = Readonly<{
  candidateId: string;
  overlappingLessonId: string;
  /** Project of the session requesting the resolution; must match a project-scoped candidate and target. */
  callerProjectId: string | null;
  /** Required when the candidate's stored scan disposition is `acknowledgment-required`. */
  acknowledgedSecretRisk?: boolean;
  now?: Date;
}>;

export type ResolveOverlapResult =
  | Readonly<{ status: "resolved"; supersession: SupersedeLessonResult }>
  | Readonly<{ status: "failed"; error: string }>;