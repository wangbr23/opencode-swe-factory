import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EXPORT_SCHEMA_VERSION,
  DatabaseRestoreError,
  exportDatabaseToJsonl,
  migrateSqliteSchema,
  openSqliteConnection,
  proposeLessonCandidate,
  releaseSchemaMigrations,
  restoreDatabaseFromJsonl,
  reviewLessonCandidate,
  supersedeLesson,
  type SecretScanResult,
  type SqliteConnection,
} from "../src/core/index.js";
import { main } from "../src/cli/index.js";

const clearScan = {
  disposition: "clear",
  findings: [],
  redactedText: "",
} as const satisfies SecretScanResult;

function seedProjectAndLesson(connection: SqliteConnection): string {
  connection.database.run("INSERT INTO projects (id, path, created_at, updated_at) VALUES (?, ?, ?, ?)", [
    "project-1",
    "/repos/project-1",
    "2026-09-04T00:00:00.000Z",
    "2026-09-04T00:00:00.000Z",
  ]);
  const candidate = proposeLessonCandidate(connection, {
    projectId: "project-1",
    scope: "project",
    draft: {
      title: "Run tests before commits",
      body: "Always run bun test before committing.",
      rationale: "User corrected a commit without tests.",
      applicability: { taskTypes: ["commit"] },
      provenance: { source: "correction" },
    },
    secretScan: clearScan,
  });
  const outcome = reviewLessonCandidate(connection, { candidateId: candidate.id, decision: "approve" });
  if (outcome.status !== "approved") {
    throw new Error("Expected approval to succeed.");
  }
  supersedeLesson(connection, {
    lessonId: outcome.lesson.lessonId,
    draft: {
      title: "Run tests and typecheck before commits",
      body: "Always run bun test and bun run typecheck before committing.",
      rationale: "Type errors slipped through once.",
      applicability: { taskTypes: ["commit"] },
      provenance: { source: "correction" },
    },
  });
  return outcome.lesson.lessonId;
}

function expectApprovedLesson(connection: SqliteConnection, lessonId: string): void {
  const lesson = connection.database
    .query<Record<string, unknown>, [string]>("SELECT * FROM lessons WHERE id = ?")
    .get(lessonId);
  expect(lesson).toMatchObject({ project_id: "project-1", scope: "project", active_version: 2 });
  const versions = connection.database
    .query<Record<string, unknown>, [string]>("SELECT * FROM lesson_versions WHERE lesson_id = ? ORDER BY version")
    .all(lessonId);
  expect(versions).toHaveLength(2);
  expect(versions[0]).toMatchObject({ version: 1, superseded_by_version: 2 });
  expect(versions[1]).toMatchObject({ version: 2, superseded_by_version: null });
}

function readExportLines(inputPath: string): Array<Record<string, unknown>> {
  return readFileSync(inputPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function writeExportLines(outputPath: string, lines: ReadonlyArray<Record<string, unknown>>): void {
  writeFileSync(outputPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, { mode: 0o600 });
}

describe("restoreDatabaseFromJsonl", () => {
  test("round-trips an export into a new database and over the live database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-restore-"));
    try {
      const dbPath = join(directory, "memory.sqlite");
      const exportPath = join(directory, "export.jsonl");
      const connection = openSqliteConnection(dbPath);
      migrateSqliteSchema(connection, releaseSchemaMigrations);
      const lessonId = seedProjectAndLesson(connection);
      const exportResult = await exportDatabaseToJsonl(connection, exportPath);
      connection.close();

      const freshPath = join(directory, "restored.sqlite");
      const freshResult = restoreDatabaseFromJsonl({ inputPath: exportPath, databasePath: freshPath });
      expect(freshResult.databasePath).toBe(freshPath);
      expect(freshResult.sqliteSchemaVersion).toBe(releaseSchemaMigrations.length);
      expect(freshResult.tables.find((table) => table.table === "lesson_versions")?.rowCount).toBe(2);
      expect(statSync(freshPath).mode & 0o777).toBe(0o600);

      const freshConnection = openSqliteConnection(freshPath);
      try {
        expectApprovedLesson(freshConnection, lessonId);
      } finally {
        freshConnection.close();
      }

      const overwriteResult = restoreDatabaseFromJsonl({ inputPath: exportPath, databasePath: dbPath });
      expect(overwriteResult.tables.reduce((sum, table) => sum + table.rowCount, 0)).toBeGreaterThan(0);
      const reopened = openSqliteConnection(dbPath);
      try {
        expectApprovedLesson(reopened, lessonId);
      } finally {
        reopened.close();
      }

      const leftovers = readdirSync(directory).filter(
        (name) => name.includes(".restore-") || name.includes("restore-prev"),
      );
      expect(leftovers).toEqual([]);
      expect(exportResult.tables.length).toBeGreaterThan(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("refuses a newer export schema and leaves the live database untouched", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-restore-"));
    try {
      const dbPath = join(directory, "memory.sqlite");
      const exportPath = join(directory, "export.jsonl");
      const connection = openSqliteConnection(dbPath);
      migrateSqliteSchema(connection, releaseSchemaMigrations);
      const lessonId = seedProjectAndLesson(connection);
      await exportDatabaseToJsonl(connection, exportPath);
      const lines = readExportLines(exportPath);
      connection.close();

      const newer = lines.map((line) =>
        line.type === "header"
          ? { ...line, sqliteSchemaVersion: releaseSchemaMigrations.length + 1 }
          : line,
      );
      writeExportLines(exportPath, newer);

      let failure: unknown;
      try {
        restoreDatabaseFromJsonl({ inputPath: exportPath, databasePath: dbPath });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(DatabaseRestoreError);
      const restoreError = failure as DatabaseRestoreError;
      expect(restoreError.stage).toBe("parse");
      expect(restoreError.message).toContain("newer than supported");

      const reopened = openSqliteConnection(dbPath);
      try {
        expectApprovedLesson(reopened, lessonId);
      } finally {
        reopened.close();
      }
      expect(readdirSync(directory).filter((name) => name.includes(".restore-"))).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("upgrades an older export to the current schema inside the replacement", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-restore-"));
    try {
      const dbPath = join(directory, "memory.sqlite");
      const exportPath = join(directory, "export-v1.jsonl");
      const connection = openSqliteConnection(dbPath);
      migrateSqliteSchema(connection, releaseSchemaMigrations);
      seedProjectAndLesson(connection);
      await exportDatabaseToJsonl(connection, exportPath);
      const lines = readExportLines(exportPath);
      connection.close();

      // Simulate a v1 export: header says schema v1 and only projects rows exist.
      const older = lines
        .filter((line) => line.type === "header" || line.type === "projects")
        .map((line) =>
          line.type === "header" ? { ...line, sqliteSchemaVersion: 1 } : line,
        );
      writeExportLines(exportPath, older);

      const result = restoreDatabaseFromJsonl({ inputPath: exportPath, databasePath: dbPath });
      expect(result.sqliteSchemaVersion).toBe(releaseSchemaMigrations.length);

      const reopened = openSqliteConnection(dbPath);
      try {
        const projects = reopened.database.query<Record<string, unknown>, []>("SELECT * FROM projects").all();
        expect(projects).toHaveLength(1);
        expect(projects[0]).toMatchObject({ id: "project-1" });
        const version = reopened.database.query<Record<string, unknown>, []>("PRAGMA user_version").get();
        expect(version?.user_version).toBe(releaseSchemaMigrations.length);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects malformed exports and unknown columns without touching the live database", () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-restore-"));
    try {
      const dbPath = join(directory, "memory.sqlite");
      const connection = openSqliteConnection(dbPath);
      migrateSqliteSchema(connection, releaseSchemaMigrations);
      const lessonId = seedProjectAndLesson(connection);
      connection.close();

      const restoreTo = join(directory, "target.sqlite");
      const header = {
        type: "header",
        exportSchemaVersion: EXPORT_SCHEMA_VERSION,
        sqliteSchemaVersion: releaseSchemaMigrations.length,
        packageName: "opencode-swe-factory",
        exportedAt: "2026-09-06T00:00:00.000Z",
      };

      const cases: Array<Record<string, unknown>[]> = [
        [{ ...header, packageName: "someone-else" }],
        [{ ...header, exportSchemaVersion: EXPORT_SCHEMA_VERSION + 1 }],
        [{ type: "header", exportSchemaVersion: EXPORT_SCHEMA_VERSION }],
        [{ ...header }, { type: "not_a_table", record: { id: "x" } }],
        [{ ...header }, { type: "projects", record: "not-an-object" }],
      ];

      for (const [index, lines] of cases.entries()) {
        const badPath = join(directory, `bad-${index}.jsonl`);
        writeExportLines(badPath, lines);
        let failed = false;
        try {
          restoreDatabaseFromJsonl({ inputPath: badPath, databasePath: restoreTo });
        } catch (error) {
          failed = true;
          expect(error).toBeInstanceOf(DatabaseRestoreError);
          expect((error as DatabaseRestoreError).stage).toBe("parse");
        }
        expect(failed).toBe(true);
      }

      // An unknown column is valid JSON but fails while building the
      // replacement database.
      const unknownColumnPath = join(directory, "bad-column.jsonl");
      writeExportLines(unknownColumnPath, [
        header,
        {
          type: "projects",
          record: { id: "project-1", path: "/repos/p", created_at: "2026-09-04T00:00:00.000Z", updated_at: "2026-09-04T00:00:00.000Z", bogus_column: 1 },
        },
      ]);
      try {
        restoreDatabaseFromJsonl({ inputPath: unknownColumnPath, databasePath: restoreTo });
        throw new Error("Expected restore to fail.");
      } catch (error) {
        if (!(error instanceof DatabaseRestoreError)) {
          throw error;
        }
        expect(error.stage).toBe("build");
        expect(error.message).toContain("bogus_column");
      }

      // A foreign-key-violating record fails inside the replacement build.
      const fkPath = join(directory, "bad-fk.jsonl");
      writeExportLines(fkPath, [
        header,
        {
          type: "lessons",
          record: {
            id: "lesson-orphan",
            project_id: "missing-project",
            scope: "project",
            active_version: 1,
            created_at: "2026-09-04T00:00:00.000Z",
            updated_at: "2026-09-04T00:00:00.000Z",
          },
        },
      ]);
      try {
        restoreDatabaseFromJsonl({ inputPath: fkPath, databasePath: restoreTo });
        throw new Error("Expected restore to fail.");
      } catch (error) {
        if (!(error instanceof DatabaseRestoreError)) {
          throw error;
        }
        expect(error.stage).toBe("build");
      }

      expect(readdirSync(directory).filter((name) => name.includes(".restore-"))).toEqual([]);
      expect(existsSync(restoreTo)).toBe(false);

      const reopened = openSqliteConnection(dbPath);
      try {
        expectApprovedLesson(reopened, lessonId);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("restore CLI", () => {
  test("restore command replaces the live database from an export", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-restore-cli-"));
    try {
      const dbPath = join(directory, "memory.sqlite");
      const exportPath = join(directory, "export.jsonl");
      const connection = openSqliteConnection(dbPath);
      migrateSqliteSchema(connection, releaseSchemaMigrations);
      const lessonId = seedProjectAndLesson(connection);
      await exportDatabaseToJsonl(connection, exportPath);
      connection.database.run("DELETE FROM lesson_versions");
      connection.database.run("DELETE FROM lessons");
      connection.close();

      const logged: string[] = [];
      const originalLog = console.log;
      console.log = (message?: unknown) => {
        logged.push(String(message));
      };
      let code: number;
      try {
        code = await main(["restore", exportPath, "--database", dbPath]);
      } finally {
        console.log = originalLog;
      }
      expect(code).toBe(0);
      expect(logged.join("\n")).toContain(`Restored`);

      const reopened = openSqliteConnection(dbPath);
      try {
        expectApprovedLesson(reopened, lessonId);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("restore requires an input path", async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (message?: unknown) => {
      errors.push(String(message));
    };
    try {
      expect(await main(["restore"])).toBe(1);
    } finally {
      console.error = originalError;
    }
    expect(errors.join("\n")).toContain("Usage: restore <input-path>");
  });
});
