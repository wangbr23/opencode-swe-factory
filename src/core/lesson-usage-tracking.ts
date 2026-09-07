import type {
  LessonRetrievalHit,
  RecordLessonRetrievalHitsInput,
  RecordLessonRetrievalHitsResult,
} from "../types/lesson-usage-types.js";
import type { SqliteConnection } from "./sqlite.js";

export class LessonUsageTrackingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LessonUsageTrackingError";
  }
}

const INSERT_HIT_SQL =
  "INSERT OR IGNORE INTO lesson_retrieval_hits (lesson_id, version, retrieved_day) VALUES (?, ?, ?)";

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new LessonUsageTrackingError(`${label} must be a non-empty string.`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new LessonUsageTrackingError(`${label} must be a positive integer.`);
  }
  return value;
}

function validateHit(hit: LessonRetrievalHit, index: number): LessonRetrievalHit {
  const prefix = `hits[${index}]`;
  return {
    lessonId: requireNonEmptyString(hit.lessonId, `${prefix}.lessonId`),
    version: requirePositiveInteger(hit.version, `${prefix}.version`),
  };
}

function resolveRetrievedDay(now: Date): string {
  const time = now.getTime();
  if (!Number.isFinite(time)) {
    throw new LessonUsageTrackingError("now must be a valid date.");
  }
  return now.toISOString().slice(0, 10);
}

/**
 * Records one retrieval hit per (lesson, version, UTC day). Repeat hits on the
 * same day collapse into the existing row, which keeps the table bounded while
 * preserving the last-retrieved day the maintenance digest needs.
 */
export function recordLessonRetrievalHits(
  connection: SqliteConnection,
  input: RecordLessonRetrievalHitsInput,
): RecordLessonRetrievalHitsResult {
  const validated = input.hits.map(validateHit);
  if (validated.length === 0) {
    return { recordedCount: 0 };
  }

  const retrievedDay = resolveRetrievedDay(input.now ?? new Date());

  const recordedCount = connection.database.transaction((): number => {
    let changes = 0;
    for (const hit of validated) {
      changes += connection.database.run(INSERT_HIT_SQL, [
        hit.lessonId,
        hit.version,
        retrievedDay,
      ]).changes;
    }
    return changes;
  })();

  return { recordedCount };
}
