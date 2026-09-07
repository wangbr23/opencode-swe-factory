import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createTask,
  listTaskEvidenceSignals,
  migrateSqliteSchema,
  openSqliteConnection,
  recordExplicitFeedback,
  recordOutcomeSignal,
  releaseSchemaMigrations,
  resolveProjectIdentity,
  type SqliteConnection,
} from "../src/core/index.js";

const NOW = new Date("2026-09-06T12:00:00.000Z");

function withTestDatabase(run: (connection: SqliteConnection) => void | Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-evidence-inspection-"));
  const connection = openSqliteConnection(join(directory, "memory.sqlite"));
  migrateSqliteSchema(connection, releaseSchemaMigrations);
  return Promise.resolve(run(connection)).finally(() => {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  });
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

test("listTaskEvidenceSignals returns signals in insertion order with retraction links", () => {
  withTestDatabase((connection) => {
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
    const accepted = recordExplicitFeedback(connection, { taskId, feedbackKind: "acceptance", now: NOW });
    recordExplicitFeedback(connection, { taskId, feedbackKind: "rework", now: NOW });

    const signals = listTaskEvidenceSignals(connection, taskId);
    expect(signals).toHaveLength(3);
    const toolFailure = signals[0];
    const acceptance = signals[1];
    const rework = signals[2];
    if (!toolFailure || !acceptance || !rework) {
      throw new Error("Expected three evidence signals in the test fixture.");
    }
    expect(signals.map((signal) => signal.kind)).toEqual([
      "tool-failure",
      "explicit-feedback",
      "explicit-feedback",
    ]);
    expect(toolFailure.dimension).toBe("reliability");
    expect(toolFailure.metadata).toEqual({ failureKind: "local-tool" });
    expect(acceptance.metadata).toEqual({ feedbackKind: "acceptance" });
    expect(acceptance.supersededBy).toBe(rework.id);
    expect(rework.supersedesSignalId).toBe(accepted.signalId);
    expect(rework.supersededBy).toBeNull();
    expect(signals.every((signal) => signal.executionId === null)).toBe(true);
  });
});

test("listTaskEvidenceSignals returns an empty list for a task without signals", () => {
  withTestDatabase((connection) => {
    const taskId = createBareTask(connection);
    expect(listTaskEvidenceSignals(connection, taskId)).toEqual([]);
  });
});

test("listTaskEvidenceSignals rejects a missing task", () => {
  withTestDatabase((connection) => {
    expect(() => listTaskEvidenceSignals(connection, "nonexistent-task")).toThrow("not found");
  });
});
