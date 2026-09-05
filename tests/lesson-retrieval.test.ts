import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LessonRetrievalDataError,
  LessonRetrievalInputError,
  MAX_LEXICAL_LESSON_LIMIT,
  migrateSqliteSchema,
  openSqliteConnection,
  releaseSchemaMigrations,
  retrieveConfirmedLessonsLexically,
  type LessonScope,
  type SqliteConnection,
} from "../src/core/index.js";

const NOW = "2026-09-05T00:00:00.000Z";

function withDatabase(run: (connection: SqliteConnection) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-lesson-retrieval-"));
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
    NOW,
    NOW,
  ]);
}

function insertLesson(
  connection: SqliteConnection,
  input: Readonly<{
    id: string;
    scope: LessonScope;
    projectId: string | null;
    title: string;
    body: string;
    activeVersion?: number | null;
    applicability?: string;
    provenance?: string;
  }>,
): void {
  const activeVersion = input.activeVersion === undefined ? 1 : input.activeVersion;
  connection.database.run(
    "INSERT INTO lessons (id, project_id, scope, active_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    [input.id, input.projectId, input.scope, activeVersion, NOW, NOW],
  );
  connection.database.run(
    "INSERT INTO lesson_versions (lesson_id, version, title, body, rationale, applicability_json, provenance_json, created_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?)",
    [
      input.id,
      input.title,
      input.body,
      `Rationale for ${input.id}`,
      input.applicability ?? JSON.stringify({ activity: "test" }),
      input.provenance ?? JSON.stringify({ source: "correction" }),
      NOW,
    ],
  );
}

test("retrieves matching global and current-project lessons without crossing project boundaries", () => {
  withDatabase((connection) => {
    insertProject(connection, "project-a");
    insertProject(connection, "project-b");
    insertLesson(connection, {
      id: "global-lesson",
      scope: "global",
      projectId: null,
      title: "Verify rollback behavior",
      body: "Run migration rollback tests before release.",
    });
    insertLesson(connection, {
      id: "project-a-lesson",
      scope: "project",
      projectId: "project-a",
      title: "Project rollback command",
      body: "Use the repository rollback fixture.",
    });
    insertLesson(connection, {
      id: "project-b-lesson",
      scope: "project",
      projectId: "project-b",
      title: "Other rollback command",
      body: "Use the other repository fixture.",
    });
    insertLesson(connection, {
      id: "inactive-lesson",
      scope: "global",
      projectId: null,
      title: "Inactive rollback rule",
      body: "This lesson is not confirmed.",
      activeVersion: null,
    });

    const results = retrieveConfirmedLessonsLexically(connection, {
      projectId: "project-a",
      query: "rollback",
    });

    expect(results.map((result) => result.lessonId).sort()).toEqual(["global-lesson", "project-a-lesson"]);
    expect(results.map((result) => result.lexicalRank)).toEqual([1, 2]);
    expect(results.every((result) => result.projectId === null || result.projectId === "project-a")).toBe(true);
  });
});

test("returns only the active unsuperseded version", () => {
  withDatabase((connection) => {
    insertProject(connection, "project-a");
    insertLesson(connection, {
      id: "versioned-lesson",
      scope: "project",
      projectId: "project-a",
      title: "Old rollback workflow",
      body: "Use the legacy rollback command.",
      activeVersion: 2,
    });
    connection.database.run(
      "INSERT INTO lesson_versions (lesson_id, version, title, body, rationale, applicability_json, provenance_json, created_at) VALUES (?, 2, ?, ?, ?, '{}', '{}', ?)",
      ["versioned-lesson", "Use atomic migrations", "Run the transactional migration command.", "Updated rule.", NOW],
    );
    connection.database.run(
      "UPDATE lesson_versions SET superseded_by_version = 2 WHERE lesson_id = ? AND version = 1",
      ["versioned-lesson"],
    );

    expect(
      retrieveConfirmedLessonsLexically(connection, { projectId: "project-a", query: "legacy rollback" }),
    ).toEqual([]);
    expect(
      retrieveConfirmedLessonsLexically(connection, { projectId: "project-a", query: "transactional" }),
    ).toEqual([
      expect.objectContaining({
        lessonId: "versioned-lesson",
        version: 2,
        title: "Use atomic migrations",
        applicability: {},
        provenance: {},
        lexicalRank: 1,
      }),
    ]);
  });
});

test("treats arbitrary task punctuation and FTS operators as literal search input", () => {
  withDatabase((connection) => {
    insertLesson(connection, {
      id: "safe-query-lesson",
      scope: "global",
      projectId: null,
      title: "Rollback safely",
      body: "Verify the database rollback path.",
    });

    const results = retrieveConfirmedLessonsLexically(connection, {
      projectId: "project-a",
      query: 'rollback" OR * NOT (database):',
    });
    expect(results.map((result) => result.lessonId)).toEqual(["safe-query-lesson"]);
    expect(retrieveConfirmedLessonsLexically(connection, { projectId: "project-a", query: "!?---" })).toEqual([]);
  });
});

test("enforces deterministic limits and validates retrieval input", () => {
  withDatabase((connection) => {
    insertLesson(connection, {
      id: "lesson-b",
      scope: "global",
      projectId: null,
      title: "Shared verification rule",
      body: "Run verification.",
    });
    insertLesson(connection, {
      id: "lesson-a",
      scope: "global",
      projectId: null,
      title: "Shared verification rule",
      body: "Run verification.",
    });

    const first = retrieveConfirmedLessonsLexically(connection, {
      projectId: "project-a",
      query: "verification",
      limit: 1,
    });
    expect(first).toEqual([expect.objectContaining({ lessonId: "lesson-a", lexicalRank: 1 })]);
    expect(first).toEqual(
      retrieveConfirmedLessonsLexically(connection, {
        projectId: "project-a",
        query: "verification",
        limit: 1,
      }),
    );

    expect(() => retrieveConfirmedLessonsLexically(connection, { projectId: "", query: "verification" })).toThrow(
      LessonRetrievalInputError,
    );
    expect(() =>
      retrieveConfirmedLessonsLexically(connection, {
        projectId: "project-a",
        query: "verification",
        limit: MAX_LEXICAL_LESSON_LIMIT + 1,
      }),
    ).toThrow(/limit/);
    expect(() =>
      retrieveConfirmedLessonsLexically(connection, { projectId: "project-a", query: 42 as unknown as string }),
    ).toThrow(/query/);
  });
});

test("rejects malformed persisted lesson metadata without exposing its contents", () => {
  withDatabase((connection) => {
    insertLesson(connection, {
      id: "invalid-metadata",
      scope: "global",
      projectId: null,
      title: "Validate rollback metadata",
      body: "Run rollback verification.",
      applicability: "[]",
    });

    expect(() =>
      retrieveConfirmedLessonsLexically(connection, { projectId: "project-a", query: "rollback" }),
    ).toThrow(LessonRetrievalDataError);
  });
});
