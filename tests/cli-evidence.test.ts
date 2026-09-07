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
  proposeLessonCandidate,
  recordCorrectionLessonEvidence,
  recordExecutionProfile,
  recordExplicitFeedback,
  recordOutcomeSignal,
  releaseSchemaMigrations,
  resolveProjectIdentity,
  reviewLessonCandidate,
  type SqliteConnection,
} from "../src/core/index.js";
import type { SecretScanResult } from "../src/core/secrets.js";

const NOW = new Date("2026-09-06T12:00:00.000Z");

const clearScan = {
  disposition: "clear",
  findings: [],
  redactedText: "",
} as const satisfies SecretScanResult;

function withTestDatabase(run: (databasePath: string, connection: SqliteConnection) => void | Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-cli-evidence-"));
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

function createBareTask(connection: SqliteConnection): string {
  const { project } = resolveProjectIdentity(connection, { projectPath: "/repos/evidence-project" });
  const task = createTask(connection, {
    projectId: project.id,
    sessionId: "session-1",
    boundary: "top-level",
    now: NOW,
  });
  return task.taskId;
}

function createTaskWithProfile(connection: SqliteConnection): string {
  const taskId = createBareTask(connection);
  persistTaskProfile(connection, {
    taskId,
    profile: {
      taxonomyVersion: 1,
      activity: "implement",
      domain: "backend",
      complexity: "medium",
      risk: "low",
      stack: ["typescript"],
      signals: ["activity-lexical"],
      summary: "Add the evidence inspection command.",
    },
    now: NOW,
  });
  return taskId;
}

function createExecution(connection: SqliteConnection, taskId: string): string {
  const { executionId } = recordExecutionProfile(connection, {
    taskId,
    provider: "openrouter",
    model: "test-model",
    agent: "build",
    selectionSource: "host",
    startedAt: NOW,
    completedAt: NOW,
    latencyMs: 1200,
    tokens: { input: 10, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0.01,
    finishState: "stop",
    now: NOW,
  });
  return executionId;
}

function confirmLesson(connection: SqliteConnection, projectId: string): {
  lessonId: string;
  version: number;
} {
  const candidate = proposeLessonCandidate(connection, {
    projectId,
    scope: "project",
    draft: {
      title: "Run tests before commits",
      body: "Always run bun test before committing.",
      rationale: "User corrected a commit without tests.",
      applicability: {},
      provenance: { source: "correction" },
    },
    secretScan: clearScan,
    now: NOW,
  });
  const outcome = reviewLessonCandidate(connection, {
    candidateId: candidate.id,
    decision: "approve",
    now: NOW,
  });
  if (outcome.status !== "approved") {
    throw new Error("Expected the lesson candidate to be approved in the test fixture.");
  }
  return { lessonId: outcome.lesson.lessonId, version: outcome.lesson.version };
}

test("evidence inspects a task's mixed outcome and feedback signals", async () => {
  await withTestDatabase(async (databasePath, connection) => {
    const taskId = createBareTask(connection);
    recordOutcomeSignal(connection, {
      taskId,
      dimension: "reliability",
      kind: "tool-failure",
      source: "tool-outcome",
      confidence: 1,
      value: 0,
      metadata: { failureKind: "local-tool" },
      now: NOW,
    });
    recordExplicitFeedback(connection, { taskId, feedbackKind: "acceptance", now: NOW });
    recordExplicitFeedback(connection, { taskId, feedbackKind: "rework", now: NOW });
    connection.close();

    const console_ = captureConsole();
    try {
      expect(await main(["evidence", taskId, "--database", databasePath])).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain(`Evidence for task ${taskId}`);
      expect(output).toContain("[1]");
      expect(output).toContain("[2]");
      expect(output).toContain("[3]");
      expect(output).toContain("Dimension:  reliability");
      expect(output).toContain("Kind:       tool-failure");
      expect(output).toContain("Value:      0");
      expect(output).toContain("Kind:       explicit-feedback");
      expect(output).toContain("Value:      1");
      expect(output).toContain("Metadata:   feedbackKind=acceptance");
      expect(output).toContain("Metadata:   feedbackKind=rework");
      expect(output).toContain("Retracts:   ");
      expect(output).toContain("Retracted:  by ");
    } finally {
      console_.restore();
    }
  });
});

test("evidence shows a message when a task has no signals", async () => {
  await withTestDatabase(async (databasePath, connection) => {
    const taskId = createBareTask(connection);
    connection.close();

    const console_ = captureConsole();
    try {
      expect(await main(["evidence", taskId, "--database", databasePath])).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain(`Evidence for task ${taskId}`);
      expect(output).toContain("No outcome signals recorded.");
    } finally {
      console_.restore();
    }
  });
});

test("evidence shows execution and lesson links when present", async () => {
  await withTestDatabase(async (databasePath, connection) => {
    const taskId = createTaskWithProfile(connection);
    const executionId = createExecution(connection, taskId);
    const { project } = resolveProjectIdentity(connection, { projectPath: "/repos/evidence-project" });
    const lesson = confirmLesson(connection, project.id);
    recordCorrectionLessonEvidence(connection, {
      taskId,
      lessonId: lesson.lessonId,
      lessonVersion: lesson.version,
      executionId,
      now: NOW,
    });
    connection.close();

    const console_ = captureConsole();
    try {
      expect(await main(["evidence", taskId, "--database", databasePath])).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain(`Execution:  ${executionId}`);
      expect(output).toContain(`Lesson:     ${lesson.lessonId}@v${lesson.version}`);
      expect(output).toContain("Kind:       correction-lesson");
      expect(output).toContain("Source:     confirmed-lesson");
    } finally {
      console_.restore();
    }
  });
});

test("evidence fails for nonexistent task", async () => {
  await withTestDatabase(async (databasePath, connection) => {
    connection.close();

    const console_ = captureConsole();
    try {
      expect(await main(["evidence", "nonexistent-task", "--database", databasePath])).toBe(1);
      expect(console_.errors.join("\n")).toContain("not found");
    } finally {
      console_.restore();
    }
  });
});

test("evidence fails without a task id", async () => {
  await withTestDatabase(async (databasePath, connection) => {
    connection.close();

    const console_ = captureConsole();
    try {
      expect(await main(["evidence", "--database", databasePath])).toBe(1);
      expect(console_.errors.join("\n")).toContain("Usage: evidence <task-id>");
    } finally {
      console_.restore();
    }
  });
});
