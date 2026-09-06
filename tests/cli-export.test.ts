import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../src/cli/index.js";
import {
  EXPORT_SCHEMA_VERSION,
  EXPORTED_TABLE_NAMES,
  type ExportedTableName,
  migrateSqliteSchema,
  openSqliteConnection,
  proposeLessonCandidate,
  releaseSchemaMigrations,
  reviewLessonCandidate,
  supersedeLesson,
  type SecretScanResult,
  type SqliteConnection,
} from "../src/core/index.js";

async function withTestDatabase(run: (dbPath: string, connection: SqliteConnection) => void | Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-cli-export-"));
  const dbPath = join(directory, "memory.sqlite");
  const connection = openSqliteConnection(dbPath);
  migrateSqliteSchema(connection, releaseSchemaMigrations);
  try {
    await run(dbPath, connection);
  } finally {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function captureConsole() {
  const logged: string[] = [];
  const errors: string[] = [];
  const log = spyOn(console, "log").mockImplementation((message: string) => {
    logged.push(message);
  });
  const error = spyOn(console, "error").mockImplementation((message: string) => {
    errors.push(message);
  });
  return {
    logged,
    errors,
    restore() {
      log.mockRestore();
      error.mockRestore();
    },
  };
}

const clearScan = {
  disposition: "clear",
  findings: [],
  redactedText: "",
} as const satisfies SecretScanResult;

function seedLessonWithTwoVersions(connection: SqliteConnection): string {
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

type ExportLine =
  | Readonly<{ type: "header"; exportSchemaVersion: number; sqliteSchemaVersion: number; packageName: string; exportedAt: string }>
  | Readonly<{ type: ExportedTableName; record: Record<string, unknown> }>;

function readExportLines(outputPath: string): ExportLine[] {
  return readFileSync(outputPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as ExportLine);
}

test("export writes a schema-versioned JSONL snapshot preserving supersession tombstones", async () => {
  await withTestDatabase(async (dbPath, connection) => {
    const lessonId = seedLessonWithTwoVersions(connection);
    const outputPath = join(dbPath, "..", "export.jsonl");

    const console_ = captureConsole();
    try {
      expect(await main(["export", outputPath, "--database", dbPath])).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain(`Exported schema v${releaseSchemaMigrations.length} data to`);
    } finally {
      console_.restore();
    }

    const lines = readExportLines(outputPath);
    const header = lines[0];
    if (header?.type !== "header") {
      throw new Error("First export line must be the header.");
    }
    expect(header.exportSchemaVersion).toBe(EXPORT_SCHEMA_VERSION);
    expect(header.sqliteSchemaVersion).toBe(releaseSchemaMigrations.length);
    expect(header.packageName).toBe("opencode-swe-factory");

    const records = lines.slice(1) as Array<Readonly<{ type: string; record: Record<string, unknown> }>>;
    const tableOrder = [...new Set(records.map((line) => line.type))];
    expect(tableOrder).toEqual(EXPORTED_TABLE_NAMES.filter((table) => records.some((line) => line.type === table)));

    const lesson = records.find((line) => line.type === "lessons");
    expect(lesson?.record).toMatchObject({ id: lessonId, project_id: "project-1", scope: "project", active_version: 2 });

    const versions = records.filter((line) => line.type === "lesson_versions");
    expect(versions).toHaveLength(2);
    expect(versions[0]?.record).toMatchObject({ lesson_id: lessonId, version: 1, superseded_by_version: 2 });
    expect(versions[1]?.record).toMatchObject({ lesson_id: lessonId, version: 2, superseded_by_version: null });

    // No transient or derived tables are exported.
    expect(records.some((line) => line.type === "pending_lesson_candidates")).toBe(false);

    expect(statSync(outputPath).mode & 0o777).toBe(0o600);
  });
});

test("export redacts secret-looking content and reports the redaction", async () => {
  await withTestDatabase(async (dbPath, connection) => {
    const lessonId = seedLessonWithTwoVersions(connection);
    connection.database.run(
      "UPDATE lesson_versions SET body = ? WHERE lesson_id = ? AND version = 2",
      ["Use token ghp_abcdefghij1234567890abcdefghij1234567890 for the sandbox.", lessonId],
    );
    const outputPath = join(dbPath, "..", "export.jsonl");

    const console_ = captureConsole();
    try {
      expect(await main(["export", outputPath, "--database", dbPath])).toBe(0);
      expect(console_.logged.join("\n")).toContain("Redacted 1 field(s) with potential secrets.");
    } finally {
      console_.restore();
    }

    const lines = readExportLines(outputPath);
    const records = lines.slice(1) as Array<Readonly<{ type: string; record: Record<string, unknown> }>>;
    const version = records.find((line) => line.type === "lesson_versions" && line.record.version === 2);
    expect(String(version?.record.body)).toContain("[REDACTED]");
    expect(String(version?.record.body)).not.toContain("ghp_abcdefghij1234567890");
  });
});

test("export still runs against a newer-schema database with a warning", async () => {
  await withTestDatabase(async (dbPath, connection) => {
    seedLessonWithTwoVersions(connection);
    connection.database.run(`PRAGMA user_version = ${releaseSchemaMigrations.length + 1}`);
    const outputPath = join(dbPath, "..", "export.jsonl");

    const console_ = captureConsole();
    try {
      expect(await main(["export", outputPath, "--database", dbPath])).toBe(0);
      expect(console_.errors.join("\n")).toContain("is newer than supported");
    } finally {
      console_.restore();
    }

    const lines = readExportLines(outputPath);
    expect(lines.some((line) => line.type === "lessons")).toBe(true);
  });
});

test("export requires an output path", async () => {
  const console_ = captureConsole();
  try {
    expect(await main(["export"])).toBe(1);
    expect(console_.errors.join("\n")).toContain("Usage: export <output-path>");
  } finally {
    console_.restore();
  }
});
