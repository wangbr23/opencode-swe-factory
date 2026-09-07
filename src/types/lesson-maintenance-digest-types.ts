import type { LessonScope } from "./lessons-types.js";

export type MaintenanceDigestStaleLesson = Readonly<{
  lessonId: string;
  version: number;
  scope: LessonScope;
  projectId: string | null;
  title: string;
  lastUpdatedAt: string;
  ageDays: number;
}>;

export type MaintenanceDigestUnusedLesson = Readonly<{
  lessonId: string;
  version: number;
  scope: LessonScope;
  projectId: string | null;
  title: string;
  /** UTC day of the most recent retrieval hit for the active version, null when never retrieved. */
  lastRetrievalDay: string | null;
  ageDays: number;
}>;

export type MaintenanceDigestOverlapPair = Readonly<{
  lessonIdA: string;
  lessonIdB: string;
  scope: LessonScope;
  projectId: string | null;
  titleA: string;
  titleB: string;
  bodyOverlap: number;
}>;

export type LessonMaintenanceDigestInput = Readonly<{
  now?: Date;
  staleAfterDays?: number;
  unusedAfterDays?: number;
  /**
   * Upper bound on lessons compared pairwise for overlap; keeps the O(n²) scan
   * deterministic and bounded. Lessons beyond the cap (ordered by id) are not
   * compared and the digest reports the truncation.
   */
  maxPairwiseLessons?: number;
}>;

export type LessonMaintenanceDigest = Readonly<{
  generatedAt: string;
  thresholds: Readonly<{
    staleAfterDays: number;
    unusedAfterDays: number;
  }>;
  activeLessonCount: number;
  stale: ReadonlyArray<MaintenanceDigestStaleLesson>;
  unused: ReadonlyArray<MaintenanceDigestUnusedLesson>;
  duplicates: ReadonlyArray<MaintenanceDigestOverlapPair>;
  potentialConflicts: ReadonlyArray<MaintenanceDigestOverlapPair>;
  pairwiseScanTruncated: boolean;
}>;
