import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migrateSqliteSchema, openSqliteConnection, releaseSchemaMigrations } from "../src/core/index.js";

const NOW = "2026-09-05T00:00:00.000Z";

function withTemporaryDatabase(run: (database: Database) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-task-evidence-schema-"));
  const connection = openSqliteConnection(join(directory, "memory.sqlite"));
  migrateSqliteSchema(connection, releaseSchemaMigrations);
  try {
    run(connection.database);
  } finally {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function insertProject(database: Database, id: string): void {
  database.run("INSERT INTO projects (id, path, created_at, updated_at) VALUES (?, ?, ?, ?)", [
    id,
    `/repos/${id}`,
    NOW,
    NOW,
  ]);
}

function insertTask(
  database: Database,
  input: Readonly<{
    id: string;
    projectId?: string;
    sessionId?: string;
    boundary?: "top-level" | "subtask";
    parentTaskId?: string | null;
  }>,
): void {
  const boundary = input.boundary ?? "top-level";
  database.run(
    "INSERT INTO tasks (id, project_id, parent_task_id, session_id, host_task_id, boundary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [
      input.id,
      input.projectId ?? "project-1",
      input.parentTaskId ?? null,
      input.sessionId ?? "session-1",
      `host-${input.id}`,
      boundary,
      NOW,
      NOW,
    ],
  );
}

function insertTaskProfile(
  database: Database,
  taskId: string,
  version = 1,
  source: "inferred" | "corrected" = "inferred",
  supersedesVersion: number | null = null,
): void {
  database.run(
    "INSERT INTO task_profiles (task_id, version, taxonomy_version, activity, domain, complexity, risk, stack_json, required_capabilities_json, signals_json, summary, source, supersedes_version, created_at) VALUES (?, ?, 1, 'implement', 'data', 'high', 'medium', ?, ?, ?, ?, ?, ?, ?)",
    [
      taskId,
      version,
      '["bun","sqlite","typescript"]',
      '["tool-use"]',
      '["activity-lexical","domain-lexical"]',
      "Add the task evidence schema migration.",
      source,
      supersedesVersion,
      NOW,
    ],
  );
}

function insertExecution(database: Database, executionId: string, taskId: string): void {
  database.run(
    "INSERT INTO execution_profiles (id, task_id, task_profile_version, provider, model, variant, agent, selection_source, host_provider, host_model, host_variant, tool_profile_json, software_versions_json, started_at, completed_at, latency_ms, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, cost_usd, finish_state, provider_error_kind, provider_error_code, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)",
    [
      executionId,
      taskId,
      "openai",
      "gpt-5.6-sol",
      "high",
      "build",
      "host",
      "openai",
      "gpt-5.6-sol",
      "high",
      '{"tools":["bash"]}',
      '{"bun":"1.4.0","typescript":"6.0.0"}',
      NOW,
      NOW,
      1250,
      1200,
      300,
      100,
      25,
      10,
      0.0125,
      "stop",
      NOW,
    ],
  );
}

function insertOutcomeSignal(
  database: Database,
  input: Readonly<{
    id: string;
    taskId: string;
    executionId?: string | null;
    supersedesSignalId?: string | null;
  }>,
): void {
  database.run(
    "INSERT INTO outcome_signals (id, task_id, execution_id, dimension, kind, source, confidence, value, metadata_json, supersedes_signal_id, observed_at, created_at) VALUES (?, ?, ?, 'quality', 'test-pass', 'tool', 0.9, 1, ?, ?, ?, ?)",
    [input.id, input.taskId, input.executionId ?? null, '{"command":"bun test"}', input.supersedesSignalId ?? null, NOW, NOW],
  );
}

test("upgrades version 3 with task evidence tables", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-task-evidence-upgrade-"));
  const connection = openSqliteConnection(join(directory, "memory.sqlite"));
  try {
    migrateSqliteSchema(connection, releaseSchemaMigrations.slice(0, 3));

    expect(migrateSqliteSchema(connection, releaseSchemaMigrations)).toEqual({
      status: "ready",
      schemaVersion: releaseSchemaMigrations.length,
      appliedVersions: releaseSchemaMigrations.slice(3).map((migration) => migration.version),
    });
    expect(
      connection.database
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('tasks', 'task_profiles', 'execution_profiles', 'outcome_signals') ORDER BY name",
        )
        .all(),
    ).toEqual([
      { name: "execution_profiles" },
      { name: "outcome_signals" },
      { name: "task_profiles" },
      { name: "tasks" },
    ]);
  } finally {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stores redacted profile history and exact execution evidence without raw input columns", () => {
  withTemporaryDatabase((database) => {
    insertProject(database, "project-1");
    insertTask(database, { id: "task-1" });
    insertTaskProfile(database, "task-1");
    database.run("UPDATE tasks SET active_profile_version = 1, updated_at = ? WHERE id = 'task-1'", [NOW]);
    insertTaskProfile(database, "task-1", 2, "corrected", 1);
    database.run("UPDATE tasks SET active_profile_version = 2, updated_at = ? WHERE id = 'task-1'", [NOW]);
    insertExecution(database, "execution-1", "task-1");
    insertOutcomeSignal(database, { id: "signal-1", taskId: "task-1", executionId: "execution-1" });

    expect(
      database
        .query<{ active_profile_version: number }, []>("SELECT active_profile_version FROM tasks WHERE id = 'task-1'")
        .get(),
    ).toEqual({ active_profile_version: 2 });
    expect(
      database
        .query<{ version: number; source: string; supersedes_version: number | null }, []>(
          "SELECT version, source, supersedes_version FROM task_profiles ORDER BY version",
        )
        .all(),
    ).toEqual([
      { version: 1, source: "inferred", supersedes_version: null },
      { version: 2, source: "corrected", supersedes_version: 1 },
    ]);
    expect(
      database
        .query<{ provider: string; model: string; variant: string; latency_ms: number; cost_usd: number }, []>(
          "SELECT provider, model, variant, latency_ms, cost_usd FROM execution_profiles",
        )
        .get(),
    ).toEqual({ provider: "openai", model: "gpt-5.6-sol", variant: "high", latency_ms: 1250, cost_usd: 0.0125 });

    const persistedColumns = ["tasks", "task_profiles", "execution_profiles", "outcome_signals"].flatMap((table) =>
      database
        .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
        .all()
        .map((column) => column.name),
    );
    expect(persistedColumns).not.toContain("prompt");
    expect(persistedColumns).not.toContain("task_text");
    expect(persistedColumns).not.toContain("raw_output");
    expect(persistedColumns).not.toContain("error_message");
  });
});

test("enforces task boundaries and immutable profile identity", () => {
  withTemporaryDatabase((database) => {
    insertProject(database, "project-1");
    insertProject(database, "project-2");
    insertTask(database, { id: "parent" });
    insertTask(database, { id: "child", boundary: "subtask", parentTaskId: "parent" });

    expect(() => insertTask(database, { id: "missing-parent", boundary: "subtask" })).toThrow(/CHECK/);
    expect(() =>
      insertTask(database, {
        id: "cross-project-child",
        projectId: "project-2",
        boundary: "subtask",
        parentTaskId: "parent",
      }),
    ).toThrow(/same project/);
    insertTask(database, {
      id: "child-session-task",
      sessionId: "session-2",
      boundary: "subtask",
      parentTaskId: "parent",
    });
    expect(
      database.query<{ parent_task_id: string; session_id: string }, []>(
        "SELECT parent_task_id, session_id FROM tasks WHERE id = 'child-session-task'",
      ).get(),
    ).toEqual({ parent_task_id: "parent", session_id: "session-2" });
    expect(() => database.run("UPDATE tasks SET session_id = 'session-2' WHERE id = 'parent'")).toThrow(/immutable/);

    insertTaskProfile(database, "parent");
    expect(() => database.run("UPDATE tasks SET active_profile_version = 99 WHERE id = 'parent'")).toThrow(
      /profile does not exist/,
    );
    expect(() => database.run("UPDATE task_profiles SET summary = 'rewritten' WHERE task_id = 'parent'")).toThrow(
      /immutable/,
    );
    expect(() =>
      database.run(
        "INSERT INTO task_profiles (task_id, version, taxonomy_version, complexity, risk, stack_json, required_capabilities_json, signals_json, summary, source, created_at) VALUES ('parent', 2, 1, 'low', 'low', '{}', '[]', '[]', 'bad', 'corrected', ?)",
        [NOW],
      ),
    ).toThrow(/CHECK/);
  });
});

test("prevents cross-task evidence and cascades project evidence atomically", () => {
  withTemporaryDatabase((database) => {
    insertProject(database, "project-1");
    insertTask(database, { id: "task-1" });
    insertTask(database, { id: "task-2" });
    insertTaskProfile(database, "task-1");
    insertTaskProfile(database, "task-2");
    insertExecution(database, "execution-1", "task-1");
    insertOutcomeSignal(database, { id: "signal-1", taskId: "task-1", executionId: "execution-1" });
    insertOutcomeSignal(database, {
      id: "signal-2",
      taskId: "task-1",
      executionId: "execution-1",
      supersedesSignalId: "signal-1",
    });

    expect(() =>
      insertOutcomeSignal(database, { id: "cross-task", taskId: "task-2", executionId: "execution-1" }),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      database.run(
        "INSERT INTO outcome_signals (id, task_id, dimension, kind, source, confidence, value, metadata_json, observed_at, created_at) VALUES ('bad-confidence', 'task-1', 'quality', 'review', 'tool', 1.1, 1, '{}', ?, ?)",
        [NOW, NOW],
      ),
    ).toThrow(/CHECK/);
    expect(() => database.run("UPDATE outcome_signals SET value = 0 WHERE id = 'signal-1'")).toThrow(/immutable/);
    expect(() =>
      insertOutcomeSignal(database, {
        id: "duplicate-supersession",
        taskId: "task-1",
        executionId: "execution-1",
        supersedesSignalId: "signal-1",
      }),
    ).toThrow(/UNIQUE/);

    database.run("DELETE FROM projects WHERE id = 'project-1'");
    for (const table of ["tasks", "task_profiles", "execution_profiles", "outcome_signals"]) {
      expect(database.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
  });
});
