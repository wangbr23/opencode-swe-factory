import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../src/cli/index.js";
import {
  createTask,
  migrateSqliteSchema,
  openSqliteConnection,
  persistTaskProfile,
  recordExecutionProfile,
  recordOutcomeSignal,
  releaseSchemaMigrations,
  resolveProjectIdentity,
  type SqliteConnection,
} from "../src/core/index.js";

const NOW = new Date("2026-09-06T12:00:00.000Z");

function withTestDatabase(
  run: (databasePath: string, connection: SqliteConnection) => void | Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-cli-reclassify-"));
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

function createTaskWithFailedExecution(connection: SqliteConnection): {
  taskId: string;
  executionId: string;
  signalId: string;
} {
  const { project } = resolveProjectIdentity(connection, { projectPath: "/repos/reclassify-cli" });
  const task = createTask(connection, {
    projectId: project.id,
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
      summary: "Fix the failing provider call.",
    },
    now: NOW,
  });
  const { executionId } = recordExecutionProfile(connection, {
    taskId: task.taskId,
    provider: "openai",
    model: "gpt-4.1",
    agent: "build",
    selectionSource: "host",
    startedAt: NOW,
    completedAt: NOW,
    latencyMs: 1200,
    tokens: { input: 10, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0.01,
    finishState: "error",
    now: NOW,
  });
  const { signalId } = recordOutcomeSignal(connection, {
    taskId: task.taskId,
    executionId,
    dimension: "reliability",
    kind: "assistant-finish",
    source: "assistant-message",
    confidence: 1,
    value: 0,
    metadata: { finishState: "error", errorKind: "APIError" },
    observedAt: NOW,
    now: NOW,
  });
  return { taskId: task.taskId, executionId, signalId };
}

test("reclassify corrects a failure kind and withdraws model attribution", async () => {
  await withTestDatabase(async (databasePath, connection) => {
    const { taskId, signalId } = createTaskWithFailedExecution(connection);
    connection.close();

    const console_ = captureConsole();
    try {
      expect(
        await main([
          "reclassify",
          taskId,
          signalId,
          "--failure-kind",
          "authentication",
          "--not-model-caused",
          "--database",
          databasePath,
        ]),
      ).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain(`Reclassified failure signal ${signalId} for task ${taskId}`);
      expect(output).toContain("Failure kind: authentication (none recorded)");
      expect(output).toContain("Attribution:  model attribution withdrawn");

      console_.logged.length = 0;
      expect(await main(["evidence", taskId, "--database", databasePath])).toBe(0);
      const evidence = console_.logged.join("\n");
      expect(evidence).toContain("Retracts:   ");
      expect(evidence).toContain("Execution:  (none)");
      expect(evidence).toContain("notModelCaused=true");
    } finally {
      console_.restore();
    }
  });
});

test("reclassify restores attribution when re-run without the flag", async () => {
  await withTestDatabase(async (databasePath, connection) => {
    const { taskId, signalId } = createTaskWithFailedExecution(connection);
    connection.close();

    const console_ = captureConsole();
    try {
      expect(
        await main(["reclassify", taskId, signalId, "--not-model-caused", "--database", databasePath]),
      ).toBe(0);
      const withdrawnSignalId = console_.logged
        .join("\n")
        .match(/Signal:       ([a-f0-9-]+)/)?.[1];

      console_.logged.length = 0;
      expect(
        await main([
          "reclassify",
          taskId,
          withdrawnSignalId!,
          "--failure-kind",
          "cancellation",
          "--database",
          databasePath,
        ]),
      ).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain("Failure kind: cancellation");
      expect(output).toContain("Attribution:  model attribution restored");
    } finally {
      console_.restore();
    }
  });
});

test("reclassify fails without a correction or withdrawal", async () => {
  await withTestDatabase(async (databasePath, connection) => {
    const { taskId } = createTaskWithFailedExecution(connection);
    connection.close();

    const console_ = captureConsole();
    try {
      expect(await main(["reclassify", taskId, "signal-1", "--database", databasePath])).toBe(1);
      expect(console_.errors.join("\n")).toContain("Usage: reclassify <task-id> <signal-id>");
    } finally {
      console_.restore();
    }
  });
});

test("reclassify rejects unknown failure kinds and missing signals", async () => {
  await withTestDatabase(async (databasePath, connection) => {
    const { taskId, signalId } = createTaskWithFailedExecution(connection);
    connection.close();

    const console_ = captureConsole();
    try {
      expect(
        await main([
          "reclassify",
          taskId,
          signalId,
          "--failure-kind",
          "nonsense",
          "--database",
          databasePath,
        ]),
      ).toBe(1);
      expect(console_.errors.join("\n")).toContain('Invalid --failure-kind value "nonsense"');

      console_.errors.length = 0;
      expect(
        await main([
          "reclassify",
          taskId,
          "missing-signal",
          "--failure-kind",
          "provider",
          "--database",
          databasePath,
        ]),
      ).toBe(1);
      expect(console_.errors.join("\n")).toContain("was not found for task");
    } finally {
      console_.restore();
    }
  });
});
