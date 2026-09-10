import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  aggregateDecayedEvidence,
  createTask,
  listTaskEvidenceSignals,
  migrateSqliteSchema,
  openSqliteConnection,
  OutcomeReclassificationError,
  persistTaskProfile,
  recordExecutionProfile,
  recordExplicitFeedback,
  recordOutcomeSignal,
  recordToolOutcomeSignal,
  reclassifyOutcomeFailure,
  releaseSchemaMigrations,
  resolveProjectIdentity,
  type SqliteConnection,
} from "../src/core/index.js";

const NOW = new Date("2026-09-06T12:00:00.000Z");

function withTestDatabase(run: (connection: SqliteConnection, projectId: string) => void): void {
  const directory = mkdtempSync(
    join(tmpdir(), "opencode-swe-factory-outcome-reclassification-"),
  );
  const dbPath = join(directory, "memory.sqlite");
  const connection = openSqliteConnection(dbPath);
  migrateSqliteSchema(connection, releaseSchemaMigrations);
  const { project } = resolveProjectIdentity(connection, { projectPath: "/repos/reclassify-project" });
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
      summary: "Fix the failing provider call.",
    },
    now: NOW,
  });
  return task.taskId;
}

function createExecution(connection: SqliteConnection, taskId: string): string {
  const { executionId } = recordExecutionProfile(connection, {
    taskId,
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
  return executionId;
}

function recordFinishFailure(
  connection: SqliteConnection,
  taskId: string,
  executionId: string,
): string {
  return recordOutcomeSignal(connection, {
    taskId,
    executionId,
    dimension: "reliability",
    kind: "assistant-finish",
    source: "assistant-message",
    confidence: 1,
    value: 0,
    metadata: { finishState: "error", errorKind: "APIError" },
    observedAt: NOW,
    now: NOW,
  }).signalId;
}

function reliabilityEstimate(summary: ReturnType<typeof aggregateDecayedEvidence>) {
  return summary.estimates.find((estimate) => estimate.dimension === "reliability");
}

test("reclassification corrects the failure kind and supersedes the original signal", () => {
  withTestDatabase((connection, projectId) => {
    const taskId = createTaskWithProfile(connection, projectId);
    const executionId = createExecution(connection, taskId);
    const originalSignalId = recordFinishFailure(connection, taskId, executionId);

    const result = reclassifyOutcomeFailure(connection, {
      taskId,
      signalId: originalSignalId,
      failureKind: "provider",
      now: NOW,
    });

    expect(result.supersededSignalId).toBe(originalSignalId);
    expect(result.failureKind).toBe("provider");
    expect(result.previousFailureKind).toBeUndefined();
    expect(result.attribution).toBe("unchanged");

    const signals = listTaskEvidenceSignals(connection, taskId);
    expect(signals).toHaveLength(2);
    const original = signals[0]!;
    expect(original.id).toBe(originalSignalId);
    expect(original.supersededBy).toBe(result.signalId);
    const corrected = signals[1]!;
    expect(corrected.id).toBe(result.signalId);
    expect(corrected.executionId).toBe(executionId);
    expect(corrected.value).toBe(0);
    expect(corrected.observedAt).toBe(NOW.toISOString());
    expect(corrected.supersedesSignalId).toBe(originalSignalId);
    expect(corrected.metadata).toEqual({
      finishState: "error",
      errorKind: "APIError",
      failureKind: "provider",
    });
  });
});

test("withdrawing model attribution recomputes aggregation without the failure", () => {
  withTestDatabase((connection, projectId) => {
    const taskId = createTaskWithProfile(connection, projectId);
    const executionId = createExecution(connection, taskId);
    const signalId = recordFinishFailure(connection, taskId, executionId);

    const before = aggregateDecayedEvidence(connection, {
      provider: "openai",
      model: "gpt-4.1",
      now: NOW,
    });
    expect(reliabilityEstimate(before)?.sampleCount).toBe(1);
    expect(reliabilityEstimate(before)?.mean).toBe(0);

    const result = reclassifyOutcomeFailure(connection, {
      taskId,
      signalId,
      notModelCaused: true,
      now: NOW,
    });
    expect(result.attribution).toBe("withdrawn");

    const after = aggregateDecayedEvidence(connection, {
      provider: "openai",
      model: "gpt-4.1",
      now: NOW,
    });
    const reliability = reliabilityEstimate(after);
    expect(reliability?.sampleCount).toBe(0);
    expect(reliability?.mean).toBeNull();

    const signals = listTaskEvidenceSignals(connection, taskId);
    expect(signals).toHaveLength(2);
    const corrected = signals[1]!;
    expect(corrected.executionId).toBeNull();
    expect(corrected.metadata.notModelCaused).toBe(true);
    expect(corrected.metadata.originalExecutionId).toBe(executionId);
  });
});

test("re-reclassifying a withdrawn failure restores its model attribution", () => {
  withTestDatabase((connection, projectId) => {
    const taskId = createTaskWithProfile(connection, projectId);
    const executionId = createExecution(connection, taskId);
    const signalId = recordFinishFailure(connection, taskId, executionId);

    const withdrawn = reclassifyOutcomeFailure(connection, {
      taskId,
      signalId,
      notModelCaused: true,
      now: NOW,
    });
    const restored = reclassifyOutcomeFailure(connection, {
      taskId,
      signalId: withdrawn.signalId,
      failureKind: "command",
      now: NOW,
    });

    expect(restored.attribution).toBe("restored");
    expect(restored.failureKind).toBe("command");

    const signals = listTaskEvidenceSignals(connection, taskId);
    expect(signals).toHaveLength(3);
    const corrected = signals[2]!;
    expect(corrected.executionId).toBe(executionId);
    expect(corrected.metadata.notModelCaused).toBeUndefined();
    expect(corrected.metadata.originalExecutionId).toBeUndefined();
    expect(corrected.metadata.failureKind).toBe("command");
    expect(corrected.metadata.reclassifiedFailureKind).toBeUndefined();

    const after = aggregateDecayedEvidence(connection, {
      provider: "openai",
      model: "gpt-4.1",
      now: NOW,
    });
    expect(reliabilityEstimate(after)?.sampleCount).toBe(1);
    expect(reliabilityEstimate(after)?.mean).toBe(0);
  });
});

test("tool-outcome failures can be reclassified but not withdrawn", () => {
  withTestDatabase((connection, projectId) => {
    const taskId = createTaskWithProfile(connection, projectId);
    const recorded = recordToolOutcomeSignal(connection, {
      taskId,
      record: { tool: "bash", exitCode: 1, commandText: "bun run test" },
      now: NOW,
    });
    expect(recorded.status).toBe("recorded");
    if (recorded.status !== "recorded") return;
    const { signalId } = recorded;

    const result = reclassifyOutcomeFailure(connection, {
      taskId,
      signalId,
      failureKind: "local-tool",
      now: NOW,
    });
    expect(result.failureKind).toBe("local-tool");
    expect(result.previousFailureKind).toBe("command");

    const signals = listTaskEvidenceSignals(connection, taskId);
    const corrected = signals[1]!;
    expect(corrected.metadata).toEqual({
      tool: "bash",
      category: "test",
      failureKind: "local-tool",
      reclassifiedFailureKind: "command",
    });

    expect(() =>
      reclassifyOutcomeFailure(connection, { taskId, signalId: result.signalId, notModelCaused: true }),
    ).toThrow(OutcomeReclassificationError);
  });
});

test("reclassification validates signals and inputs", () => {
  withTestDatabase((connection, projectId) => {
    const taskId = createTaskWithProfile(connection, projectId);
    const executionId = createExecution(connection, taskId);
    const signalId = recordFinishFailure(connection, taskId, executionId);

    expect(() =>
      reclassifyOutcomeFailure(connection, { taskId, signalId, failureKind: "nonsense" as never }),
    ).toThrow("Unknown failure kind");
    expect(() =>
      reclassifyOutcomeFailure(connection, { taskId, signalId: "missing", failureKind: "provider" }),
    ).toThrow("was not found for task");
    const providerResult = reclassifyOutcomeFailure(connection, {
      taskId,
      signalId,
      failureKind: "provider",
      now: NOW,
    });
    expect(() =>
      reclassifyOutcomeFailure(connection, { taskId, signalId, failureKind: "authentication" }),
    ).toThrow("already been superseded");

    const recordedSuccess = recordToolOutcomeSignal(connection, {
      taskId,
      record: { tool: "bash", exitCode: 0 },
      now: NOW,
    });
    expect(recordedSuccess.status).toBe("recorded");
    if (recordedSuccess.status !== "recorded") return;
    const { signalId: successSignalId } = recordedSuccess;
    expect(() =>
      reclassifyOutcomeFailure(connection, { taskId, signalId: successSignalId, failureKind: "provider" }),
    ).toThrow("not a failure");

    const feedback = recordExplicitFeedback(connection, { taskId, feedbackKind: "correction", now: NOW });
    expect(() =>
      reclassifyOutcomeFailure(connection, { taskId, signalId: feedback.signalId, failureKind: "provider" }),
    ).toThrow("cannot be reclassified");

    const noChange = reclassifyOutcomeFailure(connection, {
      taskId,
      signalId: providerResult.signalId,
      notModelCaused: true,
      now: NOW,
    });
    expect(() =>
      reclassifyOutcomeFailure(connection, { taskId, signalId: noChange.signalId, notModelCaused: true }),
    ).toThrow("Nothing to reclassify");
  });
});
