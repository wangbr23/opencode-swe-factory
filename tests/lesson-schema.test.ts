import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migrateSqliteSchema, openSqliteConnection, releaseSchemaMigrations } from "../src/core/index.js";

function withMigratedDatabase(run: (connection: ReturnType<typeof openSqliteConnection>["database"]) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-lesson-schema-"));
  const connection = openSqliteConnection(join(directory, "memory.sqlite"));
  migrateSqliteSchema(connection, releaseSchemaMigrations);
  try {
    run(connection.database);
  } finally {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function insertProject(database: ReturnType<typeof openSqliteConnection>["database"], id: string): void {
  database.run("INSERT INTO projects (id, path, created_at, updated_at) VALUES (?, ?, ?, ?)", [
    id,
    `/repos/${id}`,
    "2026-09-04T00:00:00.000Z",
    "2026-09-04T00:00:00.000Z",
  ]);
}

function insertConfirmedLesson(database: ReturnType<typeof openSqliteConnection>["database"], lessonId: string): void {
  database.run("INSERT INTO lessons (id, project_id, scope, active_version, created_at, updated_at) VALUES (?, NULL, 'global', 1, ?, ?)", [
    lessonId,
    "2026-09-04T00:00:00.000Z",
    "2026-09-04T00:00:00.000Z",
  ]);
  database.run(
    "INSERT INTO lesson_versions (lesson_id, version, title, body, rationale, applicability_json, provenance_json, created_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?)",
    [
      lessonId,
      "Run tests before commits",
      "Always run bun test before committing.",
      "User corrected a commit without tests.",
      '{"taskTypes":["commit"]}',
      '{"source":"correction"}',
      "2026-09-04T00:00:00.000Z",
    ],
  );
}

test("creates the lesson schema at version 2 and upgrades version-1 databases in place", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-lesson-schema-"));
  const connection = openSqliteConnection(join(directory, "memory.sqlite"));
  try {
    expect(migrateSqliteSchema(connection, releaseSchemaMigrations.slice(0, 1))).toEqual({
      status: "ready",
      schemaVersion: 1,
      appliedVersions: [1],
    });

    expect(migrateSqliteSchema(connection, releaseSchemaMigrations)).toEqual({
      status: "ready",
      schemaVersion: 3,
      appliedVersions: [2, 3],
    });
    expect(
      connection.database.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all(),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "lessons" }),
        expect.objectContaining({ name: "lesson_versions" }),
        expect.objectContaining({ name: "pending_lesson_candidates" }),
      ]),
    );
  } finally {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stores a confirmed lesson with an active immutable version", () => {
  withMigratedDatabase((database) => {
    insertConfirmedLesson(database, "lesson-1");

    const lesson = database
      .query<{ scope: string; active_version: number }, [string]>("SELECT scope, active_version FROM lessons WHERE id = ?")
      .get("lesson-1");
    expect(lesson).toEqual({ scope: "global", active_version: 1 });

    const version = database
      .query<{ title: string; superseded_by_version: number | null }, [string]>(
        "SELECT title, superseded_by_version FROM lesson_versions WHERE lesson_id = ?",
      )
      .get("lesson-1");
    expect(version).toEqual({ title: "Run tests before commits", superseded_by_version: null });
  });
});

test("keeps superseded versions and points the active version at the replacement", () => {
  withMigratedDatabase((database) => {
    insertConfirmedLesson(database, "lesson-1");
    insertConfirmedLesson(database, "lesson-target");
    database.run("UPDATE lessons SET active_version = 3 WHERE id = 'lesson-target'");
    // Insert the replacement version it points at, then record the pointer.
    database.run(
      "INSERT INTO lesson_versions (lesson_id, version, title, body, rationale, applicability_json, provenance_json, superseded_by_version, created_at) VALUES (?, 3, ?, ?, ?, ?, ?, NULL, ?)",
      [
        "lesson-1",
        "Run tests before commits (v3)",
        "Always run bun test before committing.",
        "Refined after review.",
        '{"taskTypes":["commit"]}',
        '{"source":"correction"}',
        "2026-09-04T01:00:00.000Z",
      ],
    );
    database.run(
      "INSERT INTO lesson_versions (lesson_id, version, title, body, rationale, applicability_json, provenance_json, superseded_by_version, created_at) VALUES (?, 2, ?, ?, ?, ?, ?, 3, ?)",
      [
        "lesson-1",
        "Run tests before commits",
        "Always run bun test before committing.",
        "Refined after review.",
        '{"taskTypes":["commit"]}',
        '{"source":"correction"}',
        "2026-09-04T01:00:00.000Z",
      ],
    );
    database.run("UPDATE lessons SET active_version = 2, updated_at = ? WHERE id = ?", [
      "2026-09-04T01:00:00.000Z",
      "lesson-1",
    ]);

    expect(
      database
        .query<{ version: number; superseded_by_version: number | null }, [string]>(
          "SELECT version, superseded_by_version FROM lesson_versions WHERE lesson_id = ? ORDER BY version",
        )
        .all("lesson-1"),
    ).toEqual([
      { version: 1, superseded_by_version: null },
      { version: 2, superseded_by_version: 3 },
      { version: 3, superseded_by_version: null },
    ]);
    expect(
      database.query<{ active_version: number }, [string]>("SELECT active_version FROM lessons WHERE id = ?").get("lesson-1"),
    ).toEqual({ active_version: 2 });
  });
});

test("stores pending candidates as drafts that expire and disappear with their project", () => {
  withMigratedDatabase((database) => {
    insertProject(database, "proj-1");
    database.run(
      "INSERT INTO pending_lesson_candidates (id, project_id, scope, draft_json, created_at, expires_at) VALUES (?, ?, 'project', ?, ?, ?)",
      [
        "candidate-1",
        "proj-1",
        '{"title":"Draft","body":"Pending text"}',
        "2026-09-04T00:00:00.000Z",
        "2026-09-05T00:00:00.000Z",
      ],
    );

    expect(
      database
        .query<{ draft_json: string; expires_at: string }, [string]>(
          "SELECT draft_json, expires_at FROM pending_lesson_candidates WHERE id = ?",
        )
        .get("candidate-1"),
    ).toEqual({
      draft_json: '{"title":"Draft","body":"Pending text"}',
      expires_at: "2026-09-05T00:00:00.000Z",
    });

    database.run("DELETE FROM projects WHERE id = 'proj-1'");
    expect(database.query<{ count: number }, []>("SELECT count(*) AS count FROM pending_lesson_candidates").get()).toEqual({
      count: 0,
    });
  });
});

test("removes lesson history when the project is deleted but keeps global lessons", () => {
  withMigratedDatabase((database) => {
    insertProject(database, "proj-1");
    database.run(
      "INSERT INTO lessons (id, project_id, scope, active_version, created_at, updated_at) VALUES (?, 'proj-1', 'project', 1, ?, ?)",
      ["lesson-project", "2026-09-04T00:00:00.000Z", "2026-09-04T00:00:00.000Z"],
    );
    database.run(
      "INSERT INTO lesson_versions (lesson_id, version, title, body, rationale, applicability_json, provenance_json, created_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?)",
      ["lesson-project", "Scoped lesson", "Body", "Rationale", "{}", "{}", "2026-09-04T00:00:00.000Z"],
    );
    insertConfirmedLesson(database, "lesson-global");

    database.run("DELETE FROM projects WHERE id = 'proj-1'");
    expect(database.query<{ count: number }, []>("SELECT count(*) AS count FROM lessons").get()).toEqual({ count: 1 });
    expect(
      database.query<{ id: string }, []>("SELECT id FROM lessons").all(),
    ).toEqual([{ id: "lesson-global" }]);
  });
});

test("rejects invalid scope, non-JSON drafts, and unknown superseding versions", () => {
  withMigratedDatabase((database) => {
    expect(() =>
      database.run("INSERT INTO lessons (id, project_id, scope, active_version, created_at, updated_at) VALUES (?, NULL, 'team', NULL, ?, ?)", [
        "lesson-bad",
        "2026-09-04T00:00:00.000Z",
        "2026-09-04T00:00:00.000Z",
      ]),
    ).toThrow(/CHECK/);

    insertProject(database, "proj-1");
    expect(() =>
      database.run(
        "INSERT INTO pending_lesson_candidates (id, project_id, scope, draft_json, created_at, expires_at) VALUES (?, ?, 'project', 'not-json', ?, ?)",
        ["candidate-bad", "proj-1", "2026-09-04T00:00:00.000Z", "2026-09-05T00:00:00.000Z"],
      ),
    ).toThrow(/CHECK/);

    insertConfirmedLesson(database, "lesson-fk");
    expect(() =>
      database.run(
        "INSERT INTO lesson_versions (lesson_id, version, title, body, rationale, applicability_json, provenance_json, superseded_by_version, created_at) VALUES (?, 2, ?, ?, ?, ?, ?, 99, ?)",
        ["lesson-fk", "T", "B", "R", "{}", "{}", "2026-09-04T00:00:00.000Z"],
      ),
    ).toThrow(/FOREIGN KEY/);
  });
});
