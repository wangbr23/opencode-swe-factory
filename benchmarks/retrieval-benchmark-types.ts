import type { EmbedLessonTextFn } from "../src/types/lesson-embedding-index-types.js";
import type { LessonRetrievalTaskProfile } from "../src/types/lesson-hybrid-retrieval-types.js";
import type { LessonScope } from "../src/types/lessons-types.js";

export type ConfirmedLessonBenchmarkVersion = Readonly<{
  version: number;
  title: string;
  body: string;
  rationale: string;
  applicability: Readonly<Record<string, unknown>>;
  createdAt: string;
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
  expectedPackedLessonIds: ReadonlyArray<string>;
}>;

export type ConfirmedLessonRetrievalBenchmarkCorpus = Readonly<{
  schemaVersion: 1;
  lessons: ReadonlyArray<ConfirmedLessonBenchmarkLesson>;
  cases: ReadonlyArray<ConfirmedLessonBenchmarkCase>;
}>;

export type BenchmarkClock = () => number;
export type CreateBenchmarkEmbedderFn = () => Promise<EmbedLessonTextFn>;

export type ConfirmedLessonRetrievalBenchmarkInput = Readonly<{
  corpus: ConfirmedLessonRetrievalBenchmarkCorpus;
  createEmbed: CreateBenchmarkEmbedderFn;
  now?: Date;
  clock?: BenchmarkClock;
  limit?: number;
}>;

export type ConfirmedLessonRetrievalBenchmarkCaseResult = Readonly<{
  id: string;
  /** Retrieval quality is measured before conflict suppression. */
  retrievedLessonIds: ReadonlyArray<string>;
  retrievedLessonVersions: ReadonlyArray<Readonly<{ lessonId: string; version: number }>>;
  semanticAvailable: boolean;
  semanticCandidateCount: number;
  suppressedLessonIds: ReadonlyArray<string>;
  /** False injection is measured after conflict suppression and token packing. */
  packedLessonIds: ReadonlyArray<string>;
  recallAtK: number;
  reciprocalRank: number;
  incorrectInjectionCount: number;
  packedCount: number;
  conflictSuppressionCorrect: boolean;
  packingCorrect: boolean;
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
    packingCorrectness: number;
    contextBudgetCompliance: number;
    semanticAvailability: number;
    /** Fresh startup: embedder construction, database setup/indexing, and first pipeline case. */
    coldLatencyMs: number;
    /** Startup through indexing, excluding the first query pipeline. */
    setupLatencyMs: number;
    /** Mean query retrieval → suppression → packing time after the cold case. */
    warmLatencyMs: number | null;
  }>;
}>;
