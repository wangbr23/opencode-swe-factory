import type { LessonCandidate, LessonCandidateDecision, LessonCandidateReviewOutcome, LessonScope } from "./lessons-types.js";
import type { LessonOverlapMatch } from "./lesson-duplicate-detection-types.js";
import type { SecretScanResult } from "./secrets-types.js";

export type ScanTextFn = (text: string) => Promise<SecretScanResult>;

export type ProposeLessonToolInput = Readonly<{
  title: string;
  body: string;
  rationale: string;
  scope: LessonScope;
  applicability?: Readonly<Record<string, unknown>>;
  provenance?: Readonly<Record<string, unknown>>;
}>;

export type ProposeLessonToolResult =
  | Readonly<{
      status: "proposed";
      candidate: LessonCandidate;
      overlaps: ReadonlyArray<LessonOverlapMatch>;
    }>
  | Readonly<{ status: "blocked"; reason: string }>
  | Readonly<{ status: "failed"; error: string }>;

export type CommitLessonToolInput = Readonly<{
  candidateId: string;
  decision: LessonCandidateDecision;
  acknowledgedSecretRisk?: boolean;
}>;

export type CommitLessonToolResult =
  | Readonly<{ status: "committed"; outcome: LessonCandidateReviewOutcome }>
  | Readonly<{ status: "failed"; error: string }>;

export type ResolveOverlapToolInput = Readonly<{
  candidateId: string;
  overlappingLessonId: string;
  acknowledgedSecretRisk?: boolean;
}>;
