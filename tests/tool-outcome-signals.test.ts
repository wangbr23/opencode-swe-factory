import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createTask,
  migrateSqliteSchema,
  openSqliteConnection,
  persistTaskProfile,
  recordToolOutcomeSignal,
  releaseSchemaMigrations,
  resolveProjectIdentity,
  resolveToolOutcomeCategory,
  deriveToolOutcomeSignals,
  type SqliteConnection,
} from "../src/core/index.js";

const NOW = new Date("2026-09-06T12:00:00.000Z");

function withTestDatabase(
  run: (connection: SqliteConnection, projectId: string) => void,
): void {
  const directory = mkdtempSync(
    join(tmpdir(), "opencode-swe-factory-tool-outcome-"),
  );
  const connection = openSqliteConnection(join(directory, "memory.sqlite"));
  migrateSqliteSchema(connection, releaseSchemaMigrations);
  const { project } = resolveProjectIdentity(connection, { projectPath: "/repos/outcome-test" });
  try {
    run(connection, project.id);
  } finally {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function createTaskWithProfile(connection: SqliteConnection, projectId: string): string {
  const task = createTask(connection, {
    projectId,
    sessionId: "session-1",
    boundary: "top-level",
    now: NOW,
  });
  persistTaskProfile(connection, {
    taskId: task.taskId,
    profile: {
      taxonomyVersion: 1,
      activity: "implement",
      domain: "backend",
      complexity: "medium",
      risk: "low",
      stack: ["typescript"],
      signals: ["activity-lexical"],
      summary: "Add the tool outcome module.",
    },
    now: NOW,
  });
  return task.taskId;
}

test("resolveToolOutcomeCategory maps command prefixes to configured categories", () => {
  expect(resolveToolOutcomeCategory({ tool: "bash", commandText: "bun test tests/" })).toBe("test");
  expect(resolveToolOutcomeCategory({ tool: "bash", commandText: "npm run lint" })).toBe("lint");
  expect(resolveToolOutcomeCategory({ tool: "bash", commandText: "bun run typecheck" })).toBe("typecheck");
  expect(resolveToolOutcomeCategory({ tool: "bash", commandText: "cargo build --release" })).toBe("build");
  expect(resolveToolOutcomeCategory({ tool: "bash", commandText: "  TSC --noEmit" })).toBe("typecheck");
});

test("resolveToolOutcomeCategory falls back to generic for unmatched commands and tools", () => {
  expect(resolveToolOutcomeCategory({ tool: "bash", commandText: "echo hello" })).toBe("generic");
  expect(resolveToolOutcomeCategory({ tool: "bash" })).toBe("generic");
  expect(resolveToolOutcomeCategory({ tool: "read", exitCode: 0 })).toBe("generic");
});

test("deriveToolOutcomeSignals maps a zero exit code to a success signal", () => {
  const [signal] = deriveToolOutcomeSignals({
    tool: "bash",
    exitCode: 0,
    commandText: "bun test",
  });

  expect(signal).toBeDefined();
  expect(signal?.dimension).toBe("reliability");
  expect(signal?.kind).toBe("tool-outcome");
  expect(signal?.source).toBe("tool-completion");
  expect(signal?.confidence).toBe(1);
  expect(signal?.value).toBe(1);
  expect(signal?.metadata).toEqual({ tool: "bash", category: "test" });
});

test("deriveToolOutcomeSignals maps a nonzero exit code to a command failure", () => {
  const [signal] = deriveToolOutcomeSignals({
    tool: "bash",
    exitCode: 1,
    commandText: "npm run lint",
  });

  expect(signal?.value).toBe(0);
  expect(signal?.metadata).toEqual({
    tool: "bash",
    category: "lint",
    failureKind: "command",
  });
});

test("deriveToolOutcomeSignals preserves the host-classified failure kind over the exit code", () => {
  const [signal] = deriveToolOutcomeSignals({
    tool: "bash",
    exitCode: 1,
    errorKind: "cancellation",
  });

  expect(signal?.value).toBe(0);
  expect(signal?.metadata.failureKind).toBe("cancellation");
});

test("deriveToolOutcomeSignals returns no signal when the status is indeterminate", () => {
  expect(deriveToolOutcomeSignals({ tool: "read" })).toEqual([]);
});

test("recordToolOutcomeSignal persists the derived signal without command text or output", () => {
  withTestDatabase((connection, projectId) => {
    const taskId = createTaskWithProfile(connection, projectId);

    const result = recordToolOutcomeSignal(connection, {
      taskId,
      record: { tool: "bash", exitCode: 1, commandText: "bun test --grep secret-token=abc123" },
      now: NOW,
    });

    expect(result.status).toBe("recorded");
    if (result.status !== "recorded") return;

    const row = connection.database
      .query<Record<string, unknown>, [string]>(
        "SELECT * FROM outcome_signals WHERE id = ?",
      )
      .get(result.signalId);
    expect(row).toBeDefined();
    expect(row?.task_id).toBe(taskId);
    expect(row?.execution_id).toBeNull();
    expect(row?.dimension).toBe("reliability");
    expect(row?.kind).toBe("tool-outcome");
    expect(row?.source).toBe("tool-completion");
    expect(row?.confidence).toBe(1);
    expect(row?.value).toBe(0);
    expect(JSON.parse(String(row?.metadata_json))).toEqual({
      tool: "bash",
      category: "test",
      failureKind: "command",
    });
    expect(String(row?.metadata_json)).not.toContain("secret-token");
    expect(String(row?.metadata_json)).not.toContain("bun test");
  });
});

test("recordToolOutcomeSignal skips persistence when the tool status is indeterminate", () => {
  withTestDatabase((connection, projectId) => {
    const taskId = createTaskWithProfile(connection, projectId);

    const result = recordToolOutcomeSignal(connection, {
      taskId,
      record: { tool: "read" },
      now: NOW,
    });

    expect(result).toEqual({ status: "skipped", reason: "indeterminate-status" });
    const count = connection.database
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM outcome_signals WHERE task_id = ?",
      )
      .get(taskId);
    expect(count?.count).toBe(0);
  });
});

test("recordToolOutcomeSignal rejects tasks that do not exist", () => {
  withTestDatabase((connection) => {
    expect(() =>
      recordToolOutcomeSignal(connection, {
        taskId: "missing-task",
        record: { tool: "bash", exitCode: 0 },
        now: NOW,
      }),
    ).toThrow();
  });
});
