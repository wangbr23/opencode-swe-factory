import type { LessonScope } from "./lessons-types.js";
import type { RetrievedLesson } from "./retrieved-lesson-types.js";
import type { SuppressedLesson } from "./lesson-conflict-suppression-types.js";

export const DEFAULT_LESSON_TOKEN_BUDGET = 2000;

export type PackLessonContextInput = Readonly<{
  kept: ReadonlyArray<RetrievedLesson>;
  suppressed: ReadonlyArray<SuppressedLesson>;
  query: string;
  tokenBudget?: number;
  estimateTokens?: (text: string) => number;
}>;

export type PackedLesson = Readonly<{
  lessonId: string;
  version: number;
  scope: LessonScope;
  title: string;
  body: string;
  estimatedTokens: number;
}>;

export type ExcludedLesson =
  | Readonly<{ lessonId: string; reason: "budget-exceeded" }>
  | Readonly<{ lessonId: string; reason: "conflict-suppressed"; conflictsWith: string; bodyOverlap: number }>;

export type RetrievalReceipt = Readonly<{
  query: string;
  retrievedCount: number;
  suppressedCount: number;
  packedCount: number;
  excludedByBudgetCount: number;
  tokenBudget: number;
  estimatedTokensUsed: number;
  semantic: Readonly<{
    status: "available" | "unavailable";
    candidateCount: number;
  }>;
}>;

export type PackLessonContextResult = Readonly<{
  block: string;
  packed: ReadonlyArray<PackedLesson>;
  excluded: ReadonlyArray<ExcludedLesson>;
  receipt: RetrievalReceipt;
}>;
