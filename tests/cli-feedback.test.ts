import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../src/cli/index.js";
import {
  createTask,
  migrateSqliteSchema,
  openSqliteConnection,
  recordExplicitFeedback,
  releaseSchemaMigrations,
  resolveProjectIdentity,
  type SqliteConnection,
} from "../src/core/index.js";

const NOW = new Date("2026-09-06T12:00:00.000Z");

function withTestDatabase(run: (databasePath: string, connection: SqliteConnection) => void | Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-cli-feedback-"));
  const databasePath = join(directory, "memory.sqlite");
  const connection = openSqliteConnection(databasePath);
  migrateSqliteSchema(connection, releaseSchemaMigrations);
  return Promise.resolve(run(databasePath, connection)).finally(() => {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  });
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

function createTestTask(connection: SqliteConnection): string {
  const { project } = resolveProjectIdentity(connection, { projectPath: "/repos/feedback-project" });
  const task = createTask(connection, {
    projectId: project.id,
    sessionId: "session-1",
    boundary: "top-level",
    now: NOW,
  });
  return task.taskId;
}

test("feedback records acceptance as a high-confidence quality signal", async () => {
  await withTestDatabase(async (databasePath, connection) => {
    const taskId = createTestTask(connection);
    connection.close();

    const console_ = captureConsole();
    try {
      expect(await main(["feedback", taskId, "--kind", "acceptance", "--database", databasePath])).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain(`Recorded acceptance feedback for task ${taskId}.`);
      expect(output).toContain("Value:  1");
      expect(output).not.toContain("Retracted");
    } finally {
      console_.restore();
    }

    const verify = openSqliteConnection(databasePath);
    try {
      const row = verify.database
        .query<Record<string, unknown>, [string]>("SELECT * FROM outcome_signals WHERE task_id = ?")
        .get(taskId);
      expect(row?.kind).toBe("explicit-feedback");
      expect(row?.source).toBe("explicit-user-feedback");
      expect(row?.confidence).toBe(1);
      expect(row?.value).toBe(1);
      expect(JSON.parse(String(row?.metadata_json))).toEqual({ feedbackKind: "acceptance" });
    } finally {
      verify.close();
    }
  });
});

test("feedback records correction and retracts the latest acceptance", async () => {
  await withTestDatabase(async (databasePath, connection) => {
    const taskId = createTestTask(connection);
    const acceptance = recordExplicitFeedback(connection, { taskId, feedbackKind: "acceptance", now: NOW });
    connection.close();

    const console_ = captureConsole();
    try {
      expect(await main(["feedback", taskId, "--kind", "correction", "--database", databasePath])).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain(`Recorded correction feedback for task ${taskId}.`);
      expect(output).toContain("Value:  0");
      expect(output).toContain(`Retracted prior acceptance signal ${acceptance.signalId}.`);
    } finally {
      console_.restore();
    }
  });
});

test("feedback rejects unknown kinds", async () => {
  await withTestDatabase(async (databasePath, connection) => {
    const taskId = createTestTask(connection);
    connection.close();

    const console_ = captureConsole();
    try {
      expect(await main(["feedback", taskId, "--kind", "praise", "--database", databasePath])).toBe(1);
      expect(console_.errors.join("\n")).toContain('Invalid --kind value "praise"');
      expect(console_.errors.join("\n")).toContain("acceptance, correction, rework");
    } finally {
      console_.restore();
    }
  });
});

test("feedback fails for a missing task", async () => {
  await withTestDatabase(async (databasePath, connection) => {
    connection.close();

    const console_ = captureConsole();
    try {
      expect(await main(["feedback", "nonexistent-task", "--kind", "acceptance", "--database", databasePath])).toBe(1);
      expect(console_.errors.join("\n")).toContain("Task nonexistent-task not found.");
    } finally {
      console_.restore();
    }
  });
});

test("feedback fails without --kind", async () => {
  await withTestDatabase(async (databasePath, connection) => {
    const taskId = createTestTask(connection);
    connection.close();

    const console_ = captureConsole();
    try {
      expect(await main(["feedback", taskId, "--database", databasePath])).toBe(1);
      expect(console_.errors.join("\n")).toContain("Usage: feedback <task-id> --kind <acceptance|correction|rework>");
    } finally {
      console_.restore();
    }
  });
});

test("feedback fails without a task id", async () => {
  await withTestDatabase(async (databasePath, connection) => {
    connection.close();

    const console_ = captureConsole();
    try {
      expect(await main(["feedback", "--database", databasePath])).toBe(1);
      expect(console_.errors.join("\n")).toContain("Usage: feedback <task-id> --kind <acceptance|correction|rework>");
    } finally {
      console_.restore();
    }
  });
});
