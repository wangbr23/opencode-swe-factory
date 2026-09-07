import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_STALE_AFTER_DAYS,
  LessonMaintenanceDigestError,
  buildLessonMaintenanceDigest,
  migrateSqliteSchema,
  openSqliteConnection,
  recordLessonRetrievalHits,
  releaseSchemaMigrations,
  type SqliteConnection,
} from "../src/core/index.js";

const NOW = new Date("2026-09-06T00:00:00.000Z");
const MS_PER_DAY = 86_400_000;

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * MS_PER_DAY).toISOString();
}

function withDatabase(run: (connection: SqliteConnection) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-lesson-digest-"));
  const connection = openSqliteConnection(join(directory, "memory.sqlite"));
  migrateSqliteSchema(connection, releaseSchemaMigrations);
  try {
    run(connection);
  } finally {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function insertProject(connection: SqliteConnection, projectId: string): void {
  connection.database.run("INSERT INTO projects (id, path, created_at, updated_at) VALUES (?, ?, ?, ?)", [
    projectId,
    `/repos/${projectId}`,
    NOW.toISOString(),
    NOW.toISOString(),
  ]);
}

function insertLesson(
  connection: SqliteConnection,
  input: Readonly<{
    id: string;
    scope: "project" | "global";
    projectId: string | null;
    title: string;
    body: string;
    updatedAt?: string;
    versionCreatedAt?: string;
  }>,
): void {
  const updatedAt = input.updatedAt ?? NOW.toISOString();
  const versionCreatedAt = input.versionCreatedAt ?? updatedAt;
  connection.database.run(
    "INSERT INTO lessons (id, project_id, scope, active_version, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
    [input.id, input.projectId, input.scope, versionCreatedAt, updatedAt],
  );
  connection.database.run(
    "INSERT INTO lesson_versions (lesson_id, version, title, body, rationale, applicability_json, provenance_json, created_at) VALUES (?, 1, ?, ?, 'rationale', '{}', '{}', ?)",
    [input.id, input.title, input.body, versionCreatedAt],
  );
}

function insertActiveVersion(
  connection: SqliteConnection,
  input: Readonly<{
    lessonId: string;
    version: number;
    title: string;
    body: string;
    createdAt: string;
    lessonCreatedAt: string;
    updatedAt: string;
  }>,
): void {
  connection.database.run(
    "INSERT OR REPLACE INTO lessons (id, project_id, scope, active_version, created_at, updated_at) VALUES (?, NULL, 'global', ?, ?, ?)",
    [input.lessonId, input.version, input.lessonCreatedAt, input.updatedAt],
  );
  connection.database.run(
    "INSERT INTO lesson_versions (lesson_id, version, title, body, rationale, applicability_json, provenance_json, created_at) VALUES (?, ?, ?, ?, 'rationale', '{}', '{}', ?)",
    [input.lessonId, input.version, input.title, input.body, input.createdAt],
  );
}

// --- stale section ---

test("flags lessons untouched beyond the staleness threshold", () =>
  withDatabase((connection) => {
    insertLesson(connection, {
      id: "lesson-old",
      scope: "global",
      projectId: null,
      title: "Old lesson",
      body: "Unique stale lesson content",
      updatedAt: daysAgo(100),
    });
    insertLesson(connection, {
      id: "lesson-fresh",
      scope: "global",
      projectId: null,
      title: "Fresh lesson",
      body: "Different fresh lesson content",
      updatedAt: daysAgo(10),
    });

    const digest = buildLessonMaintenanceDigest(connection, { now: NOW });

    expect(digest.stale.map((lesson) => lesson.lessonId)).toEqual(["lesson-old"]);
    expect(digest.stale[0]!.ageDays).toBe(100);
    expect(digest.stale[0]!.lastUpdatedAt).toBe(daysAgo(100));
  }));

test("staleness threshold is configurable", () =>
  withDatabase((connection) => {
    insertLesson(connection, {
      id: "lesson-old",
      scope: "global",
      projectId: null,
      title: "Old lesson",
      body: "Unique stale lesson content",
      updatedAt: daysAgo(100),
    });

    const lenient = buildLessonMaintenanceDigest(connection, { now: NOW, staleAfterDays: 200 });
    expect(lenient.stale).toEqual([]);
    expect(lenient.thresholds.staleAfterDays).toBe(200);
    expect(DEFAULT_STALE_AFTER_DAYS).toBe(90);
  }));

test("stale lessons are ordered newest-in list by age then id", () =>
  withDatabase((connection) => {
    insertLesson(connection, {
      id: "lesson-aaa",
      scope: "global",
      projectId: null,
      title: "A",
      body: "Body alpha content one",
      updatedAt: daysAgo(95),
    });
    insertLesson(connection, {
      id: "lesson-zzz",
      scope: "global",
      projectId: null,
      title: "Z",
      body: "Body zulu content two",
      updatedAt: daysAgo(120),
    });

    const digest = buildLessonMaintenanceDigest(connection, { now: NOW });
    expect(digest.stale.map((lesson) => lesson.lessonId)).toEqual(["lesson-zzz", "lesson-aaa"]);
  }));

// --- unused section ---

test("flags never-retrieved lessons once the active version ages past the threshold", () =>
  withDatabase((connection) => {
    insertLesson(connection, {
      id: "lesson-unused",
      scope: "global",
      projectId: null,
      title: "Unused lesson",
      body: "Never retrieved unique content",
      versionCreatedAt: daysAgo(60),
    });
    insertLesson(connection, {
      id: "lesson-new",
      scope: "global",
      projectId: null,
      title: "New lesson",
      body: "Brand new unique content",
      versionCreatedAt: daysAgo(5),
    });

    const digest = buildLessonMaintenanceDigest(connection, { now: NOW });

    expect(digest.unused.map((lesson) => lesson.lessonId)).toEqual(["lesson-unused"]);
    expect(digest.unused[0]!.lastRetrievalDay).toBeNull();
    expect(digest.unused[0]!.ageDays).toBe(60);
  }));

test("lessons retrieved within the threshold window are not unused", () =>
  withDatabase((connection) => {
    insertLesson(connection, {
      id: "lesson-recent-hit",
      scope: "global",
      projectId: null,
      title: "Recently used",
      body: "Retrieved yesterday unique content",
      versionCreatedAt: daysAgo(60),
    });
    recordLessonRetrievalHits(connection, {
      hits: [{ lessonId: "lesson-recent-hit", version: 1 }],
      now: new Date(daysAgo(1)),
    });

    const digest = buildLessonMaintenanceDigest(connection, { now: NOW });
    expect(digest.unused).toEqual([]);
  }));

test("lessons whose last retrieval predates the threshold window are unused", () =>
  withDatabase((connection) => {
    insertLesson(connection, {
      id: "lesson-stale-hit",
      scope: "global",
      projectId: null,
      title: "Stale hit",
      body: "Retrieved long ago unique content",
      versionCreatedAt: daysAgo(60),
    });
    recordLessonRetrievalHits(connection, {
      hits: [{ lessonId: "lesson-stale-hit", version: 1 }],
      now: new Date(daysAgo(45)),
    });

    const digest = buildLessonMaintenanceDigest(connection, { now: NOW });
    expect(digest.unused).toHaveLength(1);
    expect(digest.unused[0]!.lastRetrievalDay).toBe(daysAgo(45).slice(0, 10));
  }));

test("a freshly superseded version resets the usage clock", () =>
  withDatabase((connection) => {
    insertActiveVersion(connection, {
      lessonId: "lesson-superseded",
      version: 1,
      title: "Old version",
      body: "Old version body content",
      createdAt: daysAgo(100),
      lessonCreatedAt: daysAgo(100),
      updatedAt: daysAgo(3),
    });
    insertActiveVersion(connection, {
      lessonId: "lesson-superseded",
      version: 2,
      title: "New version",
      body: "New version body content",
      createdAt: daysAgo(3),
      lessonCreatedAt: daysAgo(100),
      updatedAt: daysAgo(3),
    });
    recordLessonRetrievalHits(connection, {
      hits: [{ lessonId: "lesson-superseded", version: 1 }],
      now: new Date(daysAgo(50)),
    });

    const digest = buildLessonMaintenanceDigest(connection, { now: NOW });
    expect(digest.unused).toEqual([]);
  }));

// --- duplicate and conflict sections ---

test("pairs near-identical lessons as duplicates within the same project", () =>
  withDatabase((connection) => {
    insertProject(connection, "project-a");
    insertLesson(connection, {
      id: "lesson-one",
      scope: "project",
      projectId: "project-a",
      title: "Run tests first",
      body: "always run the full bun test suite before pushing changes",
    });
    insertLesson(connection, {
      id: "lesson-two",
      scope: "project",
      projectId: "project-a",
      title: "Run tests before push",
      body: "always run the full bun test suite before pushing changes",
    });
    insertLesson(connection, {
      id: "lesson-other",
      scope: "project",
      projectId: "project-a",
      title: "Prefer components",
      body: "prefer functional components over class components",
    });

    const digest = buildLessonMaintenanceDigest(connection, { now: NOW });

    expect(digest.duplicates).toHaveLength(1);
    expect(digest.duplicates[0]).toMatchObject({ lessonIdA: "lesson-one", lessonIdB: "lesson-two" });
    expect(digest.duplicates[0]!.bodyOverlap).toBeGreaterThanOrEqual(0.5);
    expect(digest.potentialConflicts).toEqual([]);
  }));

test("pairs topically-overlapping lessons as potential conflicts", () =>
  withDatabase((connection) => {
    insertLesson(connection, {
      id: "lesson-tests",
      scope: "global",
      projectId: null,
      title: "Test before push",
      body: "run the bun test suite before pushing",
    });
    insertLesson(connection, {
      id: "lesson-lint",
      scope: "global",
      projectId: null,
      title: "Lint before commit",
      body: "run the lint suite before committing",
    });

    const digest = buildLessonMaintenanceDigest(connection, { now: NOW });

    expect(digest.potentialConflicts).toHaveLength(1);
    expect(digest.potentialConflicts[0]).toMatchObject({
      lessonIdA: "lesson-lint",
      lessonIdB: "lesson-tests",
    });
    expect(digest.duplicates).toEqual([]);
  }));

test("identical lessons in different projects or scopes are not paired", () =>
  withDatabase((connection) => {
    insertProject(connection, "project-a");
    insertProject(connection, "project-b");
    const body = "always run the full bun test suite before pushing changes";
    insertLesson(connection, {
      id: "lesson-project-a",
      scope: "project",
      projectId: "project-a",
      title: "Run tests",
      body,
    });
    insertLesson(connection, {
      id: "lesson-project-b",
      scope: "project",
      projectId: "project-b",
      title: "Run tests",
      body,
    });
    insertLesson(connection, {
      id: "lesson-global",
      scope: "global",
      projectId: null,
      title: "Run tests",
      body,
    });

    const digest = buildLessonMaintenanceDigest(connection, { now: NOW });

    expect(digest.duplicates).toEqual([]);
    expect(digest.potentialConflicts).toEqual([]);
  }));

test("only active versions participate in overlap detection", () =>
  withDatabase((connection) => {
    insertActiveVersion(connection, {
      lessonId: "lesson-evolved",
      version: 1,
      title: "Old topic",
      body: "always run the full bun test suite before pushing changes",
      createdAt: daysAgo(100),
      lessonCreatedAt: daysAgo(100),
      updatedAt: daysAgo(10),
    });
    insertActiveVersion(connection, {
      lessonId: "lesson-evolved",
      version: 2,
      title: "New topic",
      body: "prefer functional components over class components",
      createdAt: daysAgo(10),
      lessonCreatedAt: daysAgo(100),
      updatedAt: daysAgo(10),
    });
    insertLesson(connection, {
      id: "lesson-tests",
      scope: "global",
      projectId: null,
      title: "Run tests",
      body: "always run the full bun test suite before pushing changes",
    });

    const digest = buildLessonMaintenanceDigest(connection, { now: NOW });

    expect(digest.duplicates).toEqual([]);
    expect(digest.potentialConflicts).toEqual([]);
  }));

// --- pairwise scan bound ---

test("pairwise scan truncates deterministically beyond the lesson cap", () =>
  withDatabase((connection) => {
    const body = "always run the full bun test suite before pushing changes";
    insertLesson(connection, {
      id: "lesson-1",
      scope: "global",
      projectId: null,
      title: "One",
      body,
    });
    insertLesson(connection, {
      id: "lesson-2",
      scope: "global",
      projectId: null,
      title: "Two",
      body,
    });

    const digest = buildLessonMaintenanceDigest(connection, { now: NOW, maxPairwiseLessons: 1 });

    expect(digest.activeLessonCount).toBe(2);
    expect(digest.pairwiseScanTruncated).toBe(true);
    expect(digest.duplicates).toEqual([]);
  }));

// --- input validation ---

test("rejects invalid thresholds and timestamps", () =>
  withDatabase((connection) => {
    expect(() => buildLessonMaintenanceDigest(connection, { now: NOW, staleAfterDays: 0 })).toThrow(
      LessonMaintenanceDigestError,
    );
    expect(() => buildLessonMaintenanceDigest(connection, { now: NOW, unusedAfterDays: -1 })).toThrow(
      LessonMaintenanceDigestError,
    );
    expect(() => buildLessonMaintenanceDigest(connection, { now: NOW, maxPairwiseLessons: 0 })).toThrow(
      LessonMaintenanceDigestError,
    );
    expect(() => buildLessonMaintenanceDigest(connection, { now: new Date("not-a-date") })).toThrow(
      LessonMaintenanceDigestError,
    );
  }));

test("digest over an empty store reports zero activity", () =>
  withDatabase((connection) => {
    const digest = buildLessonMaintenanceDigest(connection, { now: NOW });

    expect(digest).toMatchObject({
      generatedAt: NOW.toISOString(),
      thresholds: { staleAfterDays: 90, unusedAfterDays: 30 },
      activeLessonCount: 0,
      pairwiseScanTruncated: false,
    });
    expect(digest.stale).toEqual([]);
    expect(digest.unused).toEqual([]);
    expect(digest.duplicates).toEqual([]);
    expect(digest.potentialConflicts).toEqual([]);
  }));
