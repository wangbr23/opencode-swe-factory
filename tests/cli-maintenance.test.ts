import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../src/cli/index.js";
import {
  migrateSqliteSchema,
  openSqliteConnection,
  releaseSchemaMigrations,
  savePackageConfig,
  type SqliteConnection,
} from "../src/core/index.js";

async function withTestDatabase(
  run: (databasePath: string, configPath: string, connection: SqliteConnection) => void | Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-cli-maintenance-"));
  const databasePath = join(directory, "memory.sqlite");
  const configPath = join(directory, "config.json");
  const connection = openSqliteConnection(databasePath);
  migrateSqliteSchema(connection, releaseSchemaMigrations);
  try {
    await run(databasePath, configPath, connection);
  } finally {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function captureConsole() {
  const logged: string[] = [];
  const log = spyOn(console, "log").mockImplementation((message: string) => {
    logged.push(message);
  });
  return {
    logged,
    restore() {
      log.mockRestore();
    },
  };
}

function insertProject(connection: SqliteConnection, projectId: string): void {
  connection.database.run(
    "INSERT INTO projects (id, path, created_at, updated_at) VALUES (?, ?, ?, ?)",
    [projectId, `/repos/${projectId}`, "2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z"],
  );
}

function insertLesson(
  connection: SqliteConnection,
  input: Readonly<{
    id: string;
    title: string;
    body: string;
    scope?: "global" | "project";
    projectId?: string | null;
  }>,
): void {
  const scope = input.scope ?? "global";
  const projectId = input.projectId ?? null;
  const createdAt = "2000-01-01T00:00:00.000Z";
  connection.database.run(
    "INSERT INTO lessons (id, project_id, scope, active_version, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
    [input.id, projectId, scope, createdAt, createdAt],
  );
  connection.database.run(
    "INSERT INTO lesson_versions (lesson_id, version, title, body, rationale, applicability_json, provenance_json, created_at) VALUES (?, 1, ?, ?, 'rationale', '{}', '{}', ?)",
    [input.id, input.title, input.body, createdAt],
  );
}

test("maintenance reports every digest section with lesson identities and titles", async () => {
  await withTestDatabase(async (databasePath, configPath, connection) => {
    insertProject(connection, "project-a");
    const duplicateBody = "always run the full bun test suite before pushing changes";
    insertLesson(connection, {
      id: "lesson-one",
      title: "Run tests first",
      body: duplicateBody,
      scope: "project",
      projectId: "project-a",
    });
    insertLesson(connection, {
      id: "lesson-two",
      title: "Run tests before push",
      body: duplicateBody,
      scope: "project",
      projectId: "project-a",
    });
    insertLesson(connection, {
      id: "lesson-tests",
      title: "Test before push",
      body: "run the bun test suite before pushing",
    });
    insertLesson(connection, {
      id: "lesson-lint",
      title: "Lint before commit",
      body: "run the lint suite before committing",
    });
    connection.close();

    const console_ = captureConsole();
    try {
      expect(await main(["maintenance", "--database", databasePath, "--config", configPath])).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain("Lesson maintenance digest");
      expect(output).toContain("Active lessons: 4");
      expect(output).toContain("Thresholds: stale after 90 days; unused after 30 days");
      expect(output).toContain("Stale (4):");
      expect(output).toContain('lesson-one v1 project:project-a "Run tests first"');
      expect(output).toContain("Unused (4):");
      expect(output).toContain("last retrieval never");
      expect(output).toContain("Duplicates (1):");
      expect(output).toContain('lesson-one "Run tests first" <-> lesson-two "Run tests before push"');
      expect(output).toContain("Potential conflicts (1):");
      expect(output).toContain('lesson-lint "Lint before commit" <-> lesson-tests "Test before push"');
    } finally {
      console_.restore();
    }
  });
});

test("maintenance honors configured age thresholds", async () => {
  await withTestDatabase(async (databasePath, configPath, connection) => {
    insertLesson(connection, {
      id: "lesson-old",
      title: "Old lesson",
      body: "unique old lesson body",
    });
    savePackageConfig(
      { maintenance: { staleLessonDays: 50_000, unusedLessonDays: 50_000 } },
      { configFilePath: configPath },
    );
    connection.close();

    const console_ = captureConsole();
    try {
      expect(await main(["maintenance", "--database", databasePath, "--config", configPath])).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain("Thresholds: stale after 50000 days; unused after 50000 days");
      expect(output).toContain("Stale (0):");
      expect(output).toContain("Unused (0):");
      expect(output).toContain("Duplicates (0):");
      expect(output).toContain("Potential conflicts (0):");
    } finally {
      console_.restore();
    }
  });
});

test("CLI help lists the maintenance command", async () => {
  const console_ = captureConsole();
  try {
    expect(await main(["--help"])).toBe(0);
    expect(console_.logged.join("\n")).toContain(
      "maintenance               Show stale, unused, duplicate, and conflicting lessons",
    );
  } finally {
    console_.restore();
  }
});
