import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LessonUsageTrackingError,
  migrateSqliteSchema,
  openSqliteConnection,
  recordLessonRetrievalHits,
  releaseSchemaMigrations,
  type SqliteConnection,
} from "../src/core/index.js";

const DAY = "2026-09-06";
const LATER_DAY = "2026-09-08";

function withDatabase(run: (connection: SqliteConnection) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-lesson-usage-"));
  const connection = openSqliteConnection(join(directory, "memory.sqlite"));
  migrateSqliteSchema(connection, releaseSchemaMigrations);
  try {
    run(connection);
  } finally {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function insertLesson(connection: SqliteConnection, lessonId: string): void {
  connection.database.run(
    "INSERT INTO lessons (id, project_id, scope, active_version, created_at, updated_at) VALUES (?, NULL, 'global', 1, ?, ?)",
    [lessonId, `${DAY}T00:00:00.000Z`, `${DAY}T00:00:00.000Z`],
  );
  connection.database.run(
    "INSERT INTO lesson_versions (lesson_id, version, title, body, rationale, applicability_json, provenance_json, created_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?)",
    [lessonId, `Title ${lessonId}`, `Body of ${lessonId}`, "r", "{}", "{}", `${DAY}T00:00:00.000Z`],
  );
}

function selectHitDays(connection: SqliteConnection, lessonId: string): string[] {
  const rows = connection.database
    .query<{ retrieved_day: string }, [string]>(
      "SELECT retrieved_day FROM lesson_retrieval_hits WHERE lesson_id = ? ORDER BY retrieved_day",
    )
    .all(lessonId);
  return rows.map((row) => row.retrieved_day);
}

test("records one hit per lesson version and deduplicates same-day repeats", () =>
  withDatabase((connection) => {
    insertLesson(connection, "lesson-1");
    insertLesson(connection, "lesson-2");

    const hits = [
      { lessonId: "lesson-1", version: 1 },
      { lessonId: "lesson-2", version: 1 },
      { lessonId: "lesson-1", version: 1 },
    ];
    const first = recordLessonRetrievalHits(connection, { hits, now: new Date(`${DAY}T10:00:00.000Z`) });
    expect(first.recordedCount).toBe(2);

    const repeat = recordLessonRetrievalHits(connection, { hits, now: new Date(`${DAY}T18:00:00.000Z`) });
    expect(repeat.recordedCount).toBe(0);

    expect(selectHitDays(connection, "lesson-1")).toEqual([DAY]);
    expect(selectHitDays(connection, "lesson-2")).toEqual([DAY]);
  }));

test("records later days as additional rows", () =>
  withDatabase((connection) => {
    insertLesson(connection, "lesson-1");

    recordLessonRetrievalHits(connection, {
      hits: [{ lessonId: "lesson-1", version: 1 }],
      now: new Date(`${DAY}T10:00:00.000Z`),
    });
    recordLessonRetrievalHits(connection, {
      hits: [{ lessonId: "lesson-1", version: 1 }],
      now: new Date(`${LATER_DAY}T10:00:00.000Z`),
    });

    expect(selectHitDays(connection, "lesson-1")).toEqual([DAY, LATER_DAY]);
  }));

test("empty hits record nothing", () =>
  withDatabase((connection) => {
    const result = recordLessonRetrievalHits(connection, { hits: [] });
    expect(result.recordedCount).toBe(0);
  }));

test("rejects malformed hits", () =>
  withDatabase((connection) => {
    expect(() =>
      recordLessonRetrievalHits(connection, { hits: [{ lessonId: "", version: 1 }] }),
    ).toThrow(LessonUsageTrackingError);
    expect(() =>
      recordLessonRetrievalHits(connection, { hits: [{ lessonId: "lesson-1", version: 0 }] }),
    ).toThrow(LessonUsageTrackingError);
  }));

test("hits cascade-delete with their lesson", () =>
  withDatabase((connection) => {
    insertLesson(connection, "lesson-1");
    recordLessonRetrievalHits(connection, {
      hits: [{ lessonId: "lesson-1", version: 1 }],
      now: new Date(`${DAY}T10:00:00.000Z`),
    });

    connection.database.run("DELETE FROM lessons WHERE id = ?", ["lesson-1"]);

    expect(selectHitDays(connection, "lesson-1")).toEqual([]);
  }));
