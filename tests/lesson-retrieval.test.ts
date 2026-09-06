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

test("project-scoped lessons rank above global lessons at equal relevance", () => {
  withDatabase((connection) => {
    insertProject(connection, "project-a");
    insertLesson(connection, {
      id: "global-deploy",
      scope: "global",
      projectId: null,
      title: "Deploy checklist",
      body: "Verify deployment steps before release.",
    });
    insertLesson(connection, {
      id: "project-deploy",
      scope: "project",
      projectId: "project-a",
      title: "Deploy checklist",
      body: "Verify deployment steps before release.",
    });

    const results = retrieveConfirmedLessonsLexically(connection, {
      projectId: "project-a",
      query: "deploy checklist",
    });

    expect(results.map((r) => r.lessonId)).toEqual(["project-deploy", "global-deploy"]);
    expect(results[0]!.lexicalRank).toBe(1);
    expect(results[1]!.lexicalRank).toBe(2);
  });
});

test("project-scoped lesson ranks first even when global has stronger BM25 match", () => {
  withDatabase((connection) => {
    insertProject(connection, "project-a");
    insertLesson(connection, {
      id: "global-migration",
      scope: "global",
      projectId: null,
      title: "Migration migration migration",
      body: "Migration migration migration migration migration.",
    });
    insertLesson(connection, {
      id: "project-migration",
      scope: "project",
      projectId: "project-a",
      title: "Run migration",
      body: "Execute the migration script.",
    });

    const results = retrieveConfirmedLessonsLexically(connection, {
      projectId: "project-a",
      query: "migration",
    });

    expect(results[0]!.lessonId).toBe("project-migration");
    expect(results[0]!.scope).toBe("project");
    expect(results[1]!.lessonId).toBe("global-migration");
    expect(results[1]!.scope).toBe("global");
  });
});

test("global lessons sort among themselves by BM25 when no project lessons match", () => {
  withDatabase((connection) => {
    insertLesson(connection, {
      id: "global-lint-a",
      scope: "global",
      projectId: null,
      title: "Lint configuration",
      body: "Set up lint rules.",
    });
    insertLesson(connection, {
      id: "global-lint-b",
      scope: "global",
      projectId: null,
      title: "Lint lint lint",
      body: "Lint lint lint lint lint.",
    });

    const results = retrieveConfirmedLessonsLexically(connection, {
      projectId: "project-a",
      query: "lint",
    });

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.scope === "global")).toBe(true);
  });
});

test("project lessons sort among themselves by BM25 within project tier", () => {
  withDatabase((connection) => {
    insertProject(connection, "project-a");
    insertLesson(connection, {
      id: "project-test-brief",
      scope: "project",
      projectId: "project-a",
      title: "Test setup",
      body: "Run the test suite.",
    });
    insertLesson(connection, {
      id: "project-test-heavy",
      scope: "project",
      projectId: "project-a",
      title: "Test test test test",
      body: "Test test test test test.",
    });
    insertLesson(connection, {
      id: "global-test",
      scope: "global",
      projectId: null,
      title: "Test practices",
      body: "Follow testing best practices.",
    });

    const results = retrieveConfirmedLessonsLexically(connection, {
      projectId: "project-a",
      query: "test",
    });

    const projectResults = results.filter((r) => r.scope === "project");
    const globalResults = results.filter((r) => r.scope === "global");

    expect(projectResults.length).toBe(2);
    expect(globalResults.length).toBe(1);
    expect(results.indexOf(projectResults[0]!)).toBeLessThan(results.indexOf(globalResults[0]!));
    expect(results.indexOf(projectResults[1]!)).toBeLessThan(results.indexOf(globalResults[0]!));
  });
});

test("limit applies after project-over-global ordering", () => {
  withDatabase((connection) => {
    insertProject(connection, "project-a");
    insertLesson(connection, {
      id: "global-build",
      scope: "global",
      projectId: null,
      title: "Build process",
      body: "Run the build step.",
    });
    insertLesson(connection, {
      id: "project-build",
      scope: "project",
      projectId: "project-a",
      title: "Build process",
      body: "Run the project build step.",
    });

    const results = retrieveConfirmedLessonsLexically(connection, {
      projectId: "project-a",
      query: "build",
      limit: 1,
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.lessonId).toBe("project-build");
    expect(results[0]!.scope).toBe("project");
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
