import type {
  LessonMaintenanceDigest,
  LessonMaintenanceDigestInput,
  MaintenanceDigestOverlapPair,
  MaintenanceDigestStaleLesson,
  MaintenanceDigestUnusedLesson,
} from "../../types/lesson-maintenance-digest-types.js";
import type { LessonScope } from "../../types/lessons-types.js";
import {
  DUPLICATE_BODY_THRESHOLD,
  MINIMUM_OVERLAP_THRESHOLD,
} from "./lesson-duplicate-detection-constants.js";
import {
  DEFAULT_MAX_PAIRWISE_LESSONS,
  DEFAULT_STALE_AFTER_DAYS,
  DEFAULT_UNUSED_AFTER_DAYS,
  MS_PER_DAY,
} from "./lesson-maintenance-digest-constants.js";
import { extractTerms, jaccardSimilarity } from "./lexical-overlap.js";
import type { SqliteConnection } from "../db/sqlite.js";

export {
  DEFAULT_MAX_PAIRWISE_LESSONS,
  DEFAULT_STALE_AFTER_DAYS,
  DEFAULT_UNUSED_AFTER_DAYS,
} from "./lesson-maintenance-digest-constants.js";
export type {
  LessonMaintenanceDigest,
  LessonMaintenanceDigestInput,
  MaintenanceDigestOverlapPair,
  MaintenanceDigestStaleLesson,
  MaintenanceDigestUnusedLesson,
} from "../../types/lesson-maintenance-digest-types.js";

export class LessonMaintenanceDigestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LessonMaintenanceDigestError";
  }
}

type ActiveLessonRow = Readonly<{
  lessonId: string;
  version: number;
  scope: LessonScope;
  projectId: string | null;
  title: string;
  body: string;
  updatedAt: string;
  versionCreatedAt: string;
}>;

const ACTIVE_LESSONS_SQL = `
SELECT l.id AS lesson_id, l.project_id, l.scope, l.active_version, l.updated_at,
       v.title, v.body, v.created_at AS version_created_at
FROM lessons l
JOIN lesson_versions v ON v.lesson_id = l.id AND v.version = l.active_version
WHERE l.active_version IS NOT NULL
ORDER BY l.id
`;

const LAST_RETRIEVAL_DAYS_SQL = `
SELECT lesson_id, version, MAX(retrieved_day) AS last_day
FROM lesson_retrieval_hits
GROUP BY lesson_id, version
`;

function requirePositiveNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new LessonMaintenanceDigestError(`${label} must be a positive finite number.`);
  }
  return value;
}

function requireScope(value: unknown, lessonId: string): LessonScope {
  if (value !== "project" && value !== "global") {
    throw new LessonMaintenanceDigestError(`Lesson ${lessonId} has an unknown scope.`);
  }
  return value;
}

function requireString(value: unknown, lessonId: string, field: string): string {
  if (typeof value !== "string") {
    throw new LessonMaintenanceDigestError(`Lesson ${lessonId} has a malformed ${field}.`);
  }
  return value;
}

function parseTimestamp(value: string, lessonId: string, field: string): number {
  const time = Date.parse(value);
  if (Number.isNaN(time)) {
    throw new LessonMaintenanceDigestError(`Lesson ${lessonId} has a malformed ${field}.`);
  }
  return time;
}

function loadActiveLessonRows(connection: SqliteConnection): ActiveLessonRow[] {
  const rows: ActiveLessonRow[] = [];
  for (const row of connection.database.query(ACTIVE_LESSONS_SQL).all()) {
    const record = row as Record<string, unknown>;
    if (typeof record.lesson_id !== "string" || typeof record.active_version !== "number") {
      continue;
    }
    rows.push({
      lessonId: record.lesson_id,
      version: record.active_version,
      scope: requireScope(record.scope, record.lesson_id),
      projectId: typeof record.project_id === "string" ? record.project_id : null,
      title: requireString(record.title, record.lesson_id, "title"),
      body: requireString(record.body, record.lesson_id, "body"),
      updatedAt: requireString(record.updated_at, record.lesson_id, "updated_at"),
      versionCreatedAt: requireString(record.version_created_at, record.lesson_id, "version created_at"),
    });
  }
  return rows;
}

function loadLastRetrievalDays(connection: SqliteConnection): Map<string, string> {
  const lastDays = new Map<string, string>();
  for (const row of connection.database.query(LAST_RETRIEVAL_DAYS_SQL).all()) {
    const record = row as Record<string, unknown>;
    if (typeof record.lesson_id !== "string" || typeof record.version !== "number") {
      continue;
    }
    if (typeof record.last_day !== "string") {
      continue;
    }
    lastDays.set(`${record.lesson_id}:${record.version}`, record.last_day);
  }
  return lastDays;
}

function ageInDays(fromMs: number, nowMs: number): number {
  return Math.floor((nowMs - fromMs) / MS_PER_DAY);
}

function byAgeDescThenId(
  a: Readonly<{ ageDays: number; lessonId: string }>,
  b: Readonly<{ ageDays: number; lessonId: string }>,
): number {
  if (b.ageDays !== a.ageDays) return b.ageDays - a.ageDays;
  return a.lessonId < b.lessonId ? -1 : a.lessonId > b.lessonId ? 1 : 0;
}

function buildStaleSection(
  lessons: ReadonlyArray<ActiveLessonRow>,
  nowMs: number,
  staleAfterDays: number,
): MaintenanceDigestStaleLesson[] {
  const stale: MaintenanceDigestStaleLesson[] = [];
  for (const lesson of lessons) {
    const updatedAtMs = parseTimestamp(lesson.updatedAt, lesson.lessonId, "updated_at");
    const ageDays = ageInDays(updatedAtMs, nowMs);
    if (nowMs - updatedAtMs >= staleAfterDays * MS_PER_DAY) {
      stale.push({
        lessonId: lesson.lessonId,
        version: lesson.version,
        scope: lesson.scope,
        projectId: lesson.projectId,
        title: lesson.title,
        lastUpdatedAt: lesson.updatedAt,
        ageDays,
      });
    }
  }
  return stale.sort(byAgeDescThenId);
}

function buildUnusedSection(
  lessons: ReadonlyArray<ActiveLessonRow>,
  lastDays: ReadonlyMap<string, string>,
  nowMs: number,
  now: Date,
  unusedAfterDays: number,
): MaintenanceDigestUnusedLesson[] {
  const cutoff = new Date(nowMs - unusedAfterDays * MS_PER_DAY);
  const cutoffDay = cutoff.toISOString().slice(0, 10);
  const unused: MaintenanceDigestUnusedLesson[] = [];
  for (const lesson of lessons) {
    const versionCreatedAtMs = parseTimestamp(
      lesson.versionCreatedAt,
      lesson.lessonId,
      "version created_at",
    );
    if (nowMs - versionCreatedAtMs < unusedAfterDays * MS_PER_DAY) {
      continue;
    }
    const lastDay = lastDays.get(`${lesson.lessonId}:${lesson.version}`);
    if (lastDay !== undefined && lastDay > cutoffDay) {
      continue;
    }
    unused.push({
      lessonId: lesson.lessonId,
      version: lesson.version,
      scope: lesson.scope,
      projectId: lesson.projectId,
      title: lesson.title,
      lastRetrievalDay: lastDay ?? null,
      ageDays: ageInDays(versionCreatedAtMs, nowMs),
    });
  }
  return unused.sort(byAgeDescThenId);
}

function buildOverlapSections(
  lessons: ReadonlyArray<ActiveLessonRow>,
): Pick<LessonMaintenanceDigest, "duplicates" | "potentialConflicts"> {
  type ScopedLesson = Readonly<{ lesson: ActiveLessonRow; terms: ReadonlySet<string> }>;

  const groupKeys = new Map<string, ScopedLesson[]>();
  for (const lesson of lessons) {
    const key = `${lesson.scope}:${lesson.projectId ?? ""}`;
    const scoped: ScopedLesson = { lesson, terms: extractTerms(lesson.body) };
    const group = groupKeys.get(key);
    if (group === undefined) {
      groupKeys.set(key, [scoped]);
    } else {
      group.push(scoped);
    }
  }

  const duplicates: MaintenanceDigestOverlapPair[] = [];
  const potentialConflicts: MaintenanceDigestOverlapPair[] = [];

  for (const group of groupKeys.values()) {
    for (const [index, a] of group.entries()) {
      for (const b of group.slice(index + 1)) {
        const bodyOverlap = jaccardSimilarity(a.terms, b.terms);
        if (bodyOverlap < MINIMUM_OVERLAP_THRESHOLD) {
          continue;
        }
        const pair: MaintenanceDigestOverlapPair = {
          lessonIdA: a.lesson.lessonId,
          lessonIdB: b.lesson.lessonId,
          scope: a.lesson.scope,
          projectId: a.lesson.projectId,
          titleA: a.lesson.title,
          titleB: b.lesson.title,
          bodyOverlap,
        };
        if (bodyOverlap >= DUPLICATE_BODY_THRESHOLD) {
          duplicates.push(pair);
        } else {
          potentialConflicts.push(pair);
        }
      }
    }
  }

  const byPairOrder = (a: MaintenanceDigestOverlapPair, b: MaintenanceDigestOverlapPair): number => {
    if (a.lessonIdA !== b.lessonIdA) return a.lessonIdA < b.lessonIdA ? -1 : 1;
    return a.lessonIdB < b.lessonIdB ? -1 : a.lessonIdB > b.lessonIdB ? 1 : 0;
  };
  duplicates.sort(byPairOrder);
  potentialConflicts.sort(byPairOrder);

  return { duplicates, potentialConflicts };
}

/**
 * Builds the human-review maintenance digest over active confirmed lessons:
 * stale lessons (untouched for a long time), unused lessons (active version
 * never or rarely surfaced by retrieval), and duplicate/potential-conflict
 * pairs detected with the same lexical overlap semantics as candidate
 * detection. Lessons are only compared within the same scope and project.
 */
export function buildLessonMaintenanceDigest(
  connection: SqliteConnection,
  input: LessonMaintenanceDigestInput = {},
): LessonMaintenanceDigest {
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new LessonMaintenanceDigestError("now must be a valid date.");
  }

  const staleAfterDays = input.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;
  const unusedAfterDays = input.unusedAfterDays ?? DEFAULT_UNUSED_AFTER_DAYS;
  const maxPairwiseLessons = input.maxPairwiseLessons ?? DEFAULT_MAX_PAIRWISE_LESSONS;
  requirePositiveNumber(staleAfterDays, "staleAfterDays");
  requirePositiveNumber(unusedAfterDays, "unusedAfterDays");
  requirePositiveNumber(maxPairwiseLessons, "maxPairwiseLessons");

  const allLessons = loadActiveLessonRows(connection);
  const lastDays = loadLastRetrievalDays(connection);

  const pairwiseScanTruncated = allLessons.length > maxPairwiseLessons;
  const pairwiseLessons = pairwiseScanTruncated
    ? allLessons.slice(0, maxPairwiseLessons)
    : allLessons;

  const { duplicates, potentialConflicts } = buildOverlapSections(pairwiseLessons);

  return {
    generatedAt: now.toISOString(),
    thresholds: { staleAfterDays, unusedAfterDays },
    activeLessonCount: allLessons.length,
    stale: buildStaleSection(allLessons, nowMs, staleAfterDays),
    unused: buildUnusedSection(allLessons, lastDays, nowMs, now, unusedAfterDays),
    duplicates,
    potentialConflicts,
    pairwiseScanTruncated,
  };
}
