import type { EmbedLessonTextFn } from "./lesson-embedding-index-types.js";
import type { LessonRetrievalTaskProfile } from "./lesson-hybrid-retrieval-types.js";
import type { LessonScope } from "./lessons-types.js";

export type ConfirmedLessonBenchmarkVersion = Readonly<{
  version: number;
  title: string;
  body: string;
  rationale: string;
  applicability: Readonly<Record<string, unknown>>;
  active: boolean;
}>;

export type ConfirmedLessonBenchmarkLesson = Readonly<{
  lessonId: string;
  scope: LessonScope;
  projectId: string | null;
  versions: ReadonlyArray<ConfirmedLessonBenchmarkVersion>;
}>;

export type ConfirmedLessonBenchmarkCase = Readonly<{
  id: string;
  projectId: string;
  query: string;
  taskProfile?: LessonRetrievalTaskProfile;
  tokenBudget: number;
  relevantLessonIds: ReadonlyArray<string>;
  expectedSuppressedLessonIds: ReadonlyArray<string>;
}>;

export type ConfirmedLessonRetrievalBenchmarkCorpus = Readonly<{
  schemaVersion: 1;
  lessons: ReadonlyArray<ConfirmedLessonBenchmarkLesson>;
  cases: ReadonlyArray<ConfirmedLessonBenchmarkCase>;
}>;

export type BenchmarkClock = () => number;

export type ConfirmedLessonRetrievalBenchmarkInput = Readonly<{
  corpus: ConfirmedLessonRetrievalBenchmarkCorpus;
  embed: EmbedLessonTextFn;
  now?: Date;
  clock?: BenchmarkClock;
  limit?: number;
}>;

export type ConfirmedLessonRetrievalBenchmarkCaseResult = Readonly<{
  id: string;
  retrievedLessonIds: ReadonlyArray<string>;
  suppressedLessonIds: ReadonlyArray<string>;
  packedLessonIds: ReadonlyArray<string>;
  recallAtK: number;
  reciprocalRank: number;
  incorrectInjectionCount: number;
  packedCount: number;
  conflictSuppressionCorrect: boolean;
  contextBudgetCompliant: boolean;
  latencyMs: number;
}>;

export type ConfirmedLessonRetrievalBenchmarkResult = Readonly<{
  schemaVersion: 1;
  caseResults: ReadonlyArray<ConfirmedLessonRetrievalBenchmarkCaseResult>;
  aggregate: Readonly<{
    recallAtK: number;
    meanReciprocalRank: number;
    incorrectInjectionRate: number;
    conflictSuppressionCorrectness: number;
    contextBudgetCompliance: number;
    /** Fresh database migration, indexing, and the first retrieve→suppress→pack case. */
    coldLatencyMs: number;
    /** Mean retrieve→suppress→pack latency for every case after the cold case. */
    warmLatencyMs: number | null;
  }>;
}>;
