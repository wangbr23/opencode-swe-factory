import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createBackupSnapshot,
  createTask,
  hardDeleteAllStoredData,
  HardDeletionError,
  migrateSqliteSchema,
  openSqliteConnection,
  persistTaskProfile,
  proposeLessonCandidate,
  releaseSchemaMigrations,
  reviewLessonCandidate,
  type SecretScanResult,
  type SqliteConnection,
} from "../src/core/index.js";

const clearScan: SecretScanResult = {
  disposition: "clear",
  findings: [],
  redactedText: "",
};

const ALL_TABLES = [
  "projects",
  "project_aliases",
  "project_settings",
  "lessons",
  "lesson_versions",
  "pending_lesson_candidates",
  "document_sources",
  "document_chunks",
  "document_chunk_embeddings",
  "lesson_version_embeddings",
  "tasks",
  "task_profiles",
  "execution_profiles",
  "outcome_signals",
] as const;

function withTestDatabase(run: (directory: string, connection: SqliteConnection) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-hard-delete-"));
  const connection = openSqliteConnection(join(directory, "memory.sqlite"));
  migrateSqliteSchema(connection, releaseSchemaMigrations);
  try {
    run(directory, connection);
  } finally {
    if (!connection.isClosed) {
      connection.close();
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

function rowCount(connection: SqliteConnection, table: string): number {
  return connection.database.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count;
}

/** Seeds at least one row into every hard-deleted table, including FTS and embeddings. */
function seedAllTables(connection: SqliteConnection): void {
  const now = new Date().toISOString();
  connection.database.run("INSERT INTO projects (id, path, created_at, updated_at) VALUES (?, ?, ?, ?)", [
    "project-a",
    "/repos/project-a",
    now,
    now,
  ]);
  connection.database.run("INSERT INTO project_aliases (project_id, alias_kind, alias_value, created_at) VALUES (?, ?, ?, ?)", [
    "project-a",
    "path",
    "/repos/project-a",
    now,
  ]);
  connection.database.run("INSERT INTO project_settings (project_id, settings_version, settings_json, updated_at) VALUES (?, ?, ?, ?)", [
    "project-a",
    1,
    "{}",
    now,
  ]);

  const candidate = proposeLessonCandidate(connection, {
    projectId: "project-a",
    scope: "project",
    draft: {
      title: "Run tests before commits",
      body: "Always run bun test before committing changes to the repository",
      rationale: "User corrected a commit without tests.",
      applicability: {},
      provenance: {},
    },
    secretScan: clearScan,
    reviewWindowDays: 36500,
  });
  reviewLessonCandidate(connection, { candidateId: candidate.id, decision: "approve" });
  proposeLessonCandidate(connection, {
    projectId: null,
    scope: "global",
    draft: {
      title: "Prefer small files",
      body: "Keep modules small enough to hold in your head",
      rationale: "Maintainability.",
      applicability: {},
      provenance: {},
    },
    secretScan: clearScan,
    reviewWindowDays: 36500,
  });

  connection.database.run(
    `INSERT INTO lesson_version_embeddings (lesson_id, lesson_version, model, revision, dimensions, vector, created_at)
     SELECT lesson_id, version, 'minilm', 'v1', 384, zeroblob(1536), ? FROM lesson_versions`,
    [now],
  );

  connection.database.run(
    `INSERT INTO document_sources (id, project_id, scope, source_type, path, content_hash, indexed_at, created_at, updated_at)
     VALUES ('src-1', NULL, 'global', 'markdown', '/docs/a.md', 'hash-1', ?, ?, ?)`,
    [now, now, now],
  );
  connection.database.run(
    `INSERT INTO document_chunks (id, source_id, project_id, scope, source_type, source_path, heading_path, start_line, end_line, content_hash, text, created_at, updated_at)
     VALUES ('chunk-1', 'src-1', NULL, 'global', 'markdown', '/docs/a.md', '# A', 1, 2, 'hash-2', 'indexed text', ?, ?)`,
    [now, now],
  );
  connection.database.run(
    `INSERT INTO document_chunk_embeddings (chunk_id, model, revision, dimensions, vector, created_at)
     VALUES ('chunk-1', 'minilm', 'v1', 384, zeroblob(1536), ?)`,
    [now],
  );

  const task = createTask(connection, {
    projectId: "project-a",
    sessionId: "session-1",
    boundary: "top-level",
  });
  const profile = persistTaskProfile(connection, {
    taskId: task.taskId,
    profile: {
      taxonomyVersion: 1,
      activity: "implement",
      domain: "backend",
      complexity: "medium",
      risk: "low",
      stack: ["typescript", "bun"],
      signals: ["activity-lexical"],
      summary: "Seed task evidence.",
    },
  });
  connection.database.run(
    `INSERT INTO execution_profiles (
       id, task_id, task_profile_version, provider, model, variant, agent, selection_source,
       host_provider, host_model, host_variant, tool_profile_json, software_versions_json,
       started_at, completed_at, latency_ms, input_tokens, output_tokens, reasoning_tokens,
       cache_read_tokens, cache_write_tokens, cost_usd, finish_state, provider_error_kind,
       provider_error_code, created_at
     ) VALUES (
       'exec-1', ?, ?, 'openrouter', 'model-x', NULL, 'build', 'host',
       NULL, NULL, NULL, '{}', '{}',
       ?, ?, 10, 1, 1, 0, 0, 0, 0.0, 'success', NULL, NULL, ?
     )`,
    [task.taskId, profile.version, now, now, now],
  );
  connection.database.run(
    `INSERT INTO outcome_signals (
       id, task_id, execution_id, dimension, kind, source, confidence, value, metadata_json,
       lesson_id, lesson_version, supersedes_signal_id, observed_at, created_at
     ) VALUES ('sig-1', ?, 'exec-1', 'quality', 'test-pass', 'tool', 0.9, 1, '{}', NULL, NULL, NULL, ?, ?)`,
    [task.taskId, now, now],
  );
}

test("deletes all rows, FTS entries, and embeddings, purges backups, and creates a clean baseline", () => {
  withTestDatabase((directory, connection) => {
    const backupDirectory = join(directory, "backups");
    seedAllTables(connection);
    for (const table of ALL_TABLES) {
      expect(rowCount(connection, table)).toBeGreaterThan(0);
    }
    expect(rowCount(connection, "lesson_versions_fts")).toBeGreaterThan(0);
    expect(rowCount(connection, "document_chunks_fts")).toBeGreaterThan(0);

    const firstBackup = createBackupSnapshot(connection, { backupDirectory, now: new Date("2026-09-01T00:00:00Z") });
    const secondBackup = createBackupSnapshot(connection, { backupDirectory, now: new Date("2026-09-02T00:00:00Z") });

    const report = hardDeleteAllStoredData(connection, { backupDirectory });

    expect(report.tables.map((entry) => entry.table).sort()).toEqual([...ALL_TABLES].sort());
    expect(report.tables.reduce((sum, entry) => sum + entry.deletedRowCount, 0)).toBeGreaterThan(ALL_TABLES.length);

    for (const table of ALL_TABLES) {
      expect(rowCount(connection, table)).toBe(0);
    }
    expect(rowCount(connection, "lesson_versions_fts")).toBe(0);
    expect(rowCount(connection, "document_chunks_fts")).toBe(0);
    expect(connection.database.query<{ freelist_count: number }, []>("PRAGMA freelist_count").get()!.freelist_count).toBe(0);

    const walPath = `${connection.databasePath}-wal`;
    if (existsSync(walPath)) {
      expect(statSync(walPath).size).toBe(0);
    }

    expect([...report.purgedBackupPaths].sort()).toEqual([firstBackup.backupPath, secondBackup.backupPath].sort());
    expect(existsSync(firstBackup.backupPath)).toBe(false);
    expect(existsSync(secondBackup.backupPath)).toBe(false);

    expect(readdirSync(backupDirectory)).toEqual([report.baselineBackup.backupPath.split("/").pop()!]);
    const baseline = new Database(report.baselineBackup.backupPath, { readonly: true });
    try {
      expect(baseline.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(baseline.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM lessons").get()!.count).toBe(0);
      expect(baseline.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM lesson_versions_fts").get()!.count).toBe(0);
    } finally {
      baseline.close(true);
    }

    // The schema survives: new lessons can still be proposed after hard deletion.
    const candidate = proposeLessonCandidate(connection, {
      projectId: null,
      scope: "global",
      draft: { title: "Fresh start", body: "Works after deletion", rationale: "Check.", applicability: {}, provenance: {} },
      secretScan: clearScan,
      reviewWindowDays: 36500,
    });
    expect(candidate.id).toBeTruthy();
  });
});

test("rolls back every row deletion when the delete transaction fails", () => {
  withTestDatabase((directory, connection) => {
    seedAllTables(connection);
    connection.database.run(
      "CREATE TRIGGER block_project_delete BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT, 'blocked'); END",
    );

    try {
      hardDeleteAllStoredData(connection, { backupDirectory: join(directory, "backups") });
      expect.unreachable("hard deletion should have failed");
    } catch (error) {
      expect(error).toBeInstanceOf(HardDeletionError);
      expect((error as HardDeletionError).stage).toBe("delete-rows");
    }

    for (const table of ALL_TABLES) {
      expect(rowCount(connection, table)).toBeGreaterThan(0);
    }
  });
});

test("refuses to run on a closed connection", () => {
  withTestDatabase((_directory, connection) => {
    seedAllTables(connection);
    connection.close();

    expect(() => hardDeleteAllStoredData(connection)).toThrow("closed SQLite connection");
  });
});
