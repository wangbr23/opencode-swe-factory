import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createTask,
  FeedbackSignalError,
  migrateSqliteSchema,
  openSqliteConnection,
  persistTaskProfile,
  proposeLessonCandidate,
  recordCorrectionLessonEvidence,
  recordExecutionProfile,
  recordExplicitFeedback,
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

function withTestDatabase(
  run: (connection: SqliteConnection, projectId: string) => void,
): void {
  const directory = mkdtempSync(
    join(tmpdir(), "opencode-swe-factory-feedback-signals-"),
  );
  const connection = openSqliteConnection(join(directory, "memory.sqlite"));
  migrateSqliteSchema(connection, releaseSchemaMigrations);
  const { project } = resolveProjectIdentity(connection, { projectPath: "/repos/feedback-test" });
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
      summary: "Add the feedback signal module.",
    },
    now: NOW,
  });
  return task.taskId;
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

function confirmLesson(connection: SqliteConnection, projectId: string | null): {
  lessonId: string;
  version: number;
} {
  const candidate = proposeLessonCandidate(connection, {
    projectId,
    scope: projectId === null ? "global" : "project",
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

function readSignalRow(connection: SqliteConnection, signalId: string): Record<string, unknown> {
  const row = connection.database
    .query<Record<string, unknown>, [string]>("SELECT * FROM outcome_signals WHERE id = ?")
    .get(signalId);
  expect(row).toBeDefined();
  return row as Record<string, unknown>;
}

test("recordExplicitFeedback persists acceptance as a positive high-confidence quality signal", () => {
  withTestDatabase((connection, projectId) => {
    const taskId = createTaskWithProfile(connection, projectId);

    const result = recordExplicitFeedback(connection, {
      taskId,
      feedbackKind: "acceptance",
      now: NOW,
    });

    expect(result.status).toBe("recorded");
    expect(result.taskId).toBe(taskId);
    expect(result.feedbackKind).toBe("acceptance");
    expect(result.value).toBe(1);
    expect(result.supersededSignalId).toBeUndefined();

    const row = readSignalRow(connection, result.signalId);
    expect(row.task_id).toBe(taskId);
    expect(row.execution_id).toBeNull();
    expect(row.dimension).toBe("quality");
    expect(row.kind).toBe("explicit-feedback");
    expect(row.source).toBe("explicit-user-feedback");
    expect(row.confidence).toBe(1);
    expect(row.value).toBe(1);
    expect(row.lesson_id).toBeNull();
    expect(row.supersedes_signal_id).toBeNull();
    expect(JSON.parse(String(row.metadata_json))).toEqual({ feedbackKind: "acceptance" });
  });
});

test("recordExplicitFeedback persists correction and rework as negative quality signals", () => {
  withTestDatabase((connection, projectId) => {
    const taskId = createTaskWithProfile(connection, projectId);

    const correction = recordExplicitFeedback(connection, {
      taskId,
      feedbackKind: "correction",
      now: NOW,
    });
    const rework = recordExplicitFeedback(connection, {
      taskId,
      feedbackKind: "rework",
      now: NOW,
    });

    expect(correction.value).toBe(0);
    expect(rework.value).toBe(0);
    expect(readSignalRow(connection, correction.signalId).metadata_json).toContain("correction");
    expect(readSignalRow(connection, rework.signalId).metadata_json).toContain("rework");
  });
});

test("recordExplicitFeedback rejects unknown feedback kinds and missing tasks", () => {
  withTestDatabase((connection, projectId) => {
    const taskId = createTaskWithProfile(connection, projectId);

    expect(() =>
      recordExplicitFeedback(connection, {
        taskId,
        feedbackKind: "praise" as never,
        now: NOW,
      }),
    ).toThrow(FeedbackSignalError);
    expect(() =>
      recordExplicitFeedback(connection, { taskId: "missing-task", feedbackKind: "acceptance" }),
    ).toThrow(FeedbackSignalError);
  });
});

test("recordExplicitFeedback supersedes the latest acceptance when correction arrives later", () => {
  withTestDatabase((connection, projectId) => {
    const taskId = createTaskWithProfile(connection, projectId);

    const acceptance = recordExplicitFeedback(connection, {
      taskId,
      feedbackKind: "acceptance",
      now: NOW,
    });
    const correction = recordExplicitFeedback(connection, {
      taskId,
      feedbackKind: "correction",
      now: NOW,
    });

    expect(correction.supersededSignalId).toBe(acceptance.signalId);
    expect(
      readSignalRow(connection, correction.signalId).supersedes_signal_id,
    ).toBe(acceptance.signalId);
  });
});

test("recordExplicitFeedback supersedes only the latest of several acceptances", () => {
  withTestDatabase((connection, projectId) => {
    const taskId = createTaskWithProfile(connection, projectId);

    const first = recordExplicitFeedback(connection, { taskId, feedbackKind: "acceptance", now: NOW });
    const second = recordExplicitFeedback(connection, { taskId, feedbackKind: "acceptance", now: NOW });
    const correction = recordExplicitFeedback(connection, { taskId, feedbackKind: "rework", now: NOW });

    expect(correction.supersededSignalId).toBe(second.signalId);
    expect(first.signalId).not.toBe(second.signalId);
    expect(readSignalRow(connection, first.signalId).supersedes_signal_id).toBeNull();
  });
});

test("recordExplicitFeedback never supersedes an acceptance that was already retracted", () => {
  withTestDatabase((connection, projectId) => {
    const taskId = createTaskWithProfile(connection, projectId);

    recordExplicitFeedback(connection, { taskId, feedbackKind: "acceptance", now: NOW });
    const first = recordExplicitFeedback(connection, { taskId, feedbackKind: "correction", now: NOW });
    const second = recordExplicitFeedback(connection, { taskId, feedbackKind: "correction", now: NOW });

    expect(first.supersededSignalId).toBeDefined();
    expect(second.supersededSignalId).toBeUndefined();
    expect(readSignalRow(connection, second.signalId).supersedes_signal_id).toBeNull();
  });
});

test("recordExplicitFeedback never supersedes for positive feedback or without a prior acceptance", () => {
  withTestDatabase((connection, projectId) => {
    const taskId = createTaskWithProfile(connection, projectId);

    const correctionWithoutAcceptance = recordExplicitFeedback(connection, {
      taskId,
      feedbackKind: "correction",
      now: NOW,
    });
    const acceptance = recordExplicitFeedback(connection, {
      taskId,
      feedbackKind: "acceptance",
      now: NOW,
    });

    expect(correctionWithoutAcceptance.supersededSignalId).toBeUndefined();
    expect(acceptance.supersededSignalId).toBeUndefined();
  });
});

test("recordCorrectionLessonEvidence links a confirmed lesson version and execution as strong negative quality evidence", () => {
  withTestDatabase((connection, projectId) => {
    const taskId = createTaskWithProfile(connection, projectId);
    const executionId = createExecution(connection, taskId);
    const lesson = confirmLesson(connection, projectId);

    const result = recordCorrectionLessonEvidence(connection, {
      taskId,
      lessonId: lesson.lessonId,
      lessonVersion: lesson.version,
      executionId,
      now: NOW,
    });

    expect(result.signalId).toBeDefined();
    expect(result.taskId).toBe(taskId);
    expect(result.lessonId).toBe(lesson.lessonId);
    expect(result.lessonVersion).toBe(lesson.version);
    expect(result.executionId).toBe(executionId);

    const row = readSignalRow(connection, result.signalId);
    expect(row.task_id).toBe(taskId);
    expect(row.execution_id).toBe(executionId);
    expect(row.dimension).toBe("quality");
    expect(row.kind).toBe("correction-lesson");
    expect(row.source).toBe("confirmed-lesson");
    expect(row.confidence).toBe(1);
    expect(row.value).toBe(0);
    expect(row.lesson_id).toBe(lesson.lessonId);
    expect(row.lesson_version).toBe(lesson.version);
    expect(JSON.parse(String(row.metadata_json))).toEqual({});
  });
});

test("recordCorrectionLessonEvidence works at task level without an execution", () => {
  withTestDatabase((connection, projectId) => {
    const taskId = createTaskWithProfile(connection, projectId);
    const lesson = confirmLesson(connection, projectId);

    const result = recordCorrectionLessonEvidence(connection, {
      taskId,
      lessonId: lesson.lessonId,
      lessonVersion: lesson.version,
      now: NOW,
    });

    expect(result.executionId).toBeUndefined();
    expect(readSignalRow(connection, result.signalId).execution_id).toBeNull();
  });
});

test("recordCorrectionLessonEvidence rejects executions from another task, missing lesson versions, and missing tasks", () => {
  withTestDatabase((connection, projectId) => {
    const taskId = createTaskWithProfile(connection, projectId);
    const otherTaskId = createTaskWithProfile(connection, projectId);
    const executionId = createExecution(connection, otherTaskId);
    const lesson = confirmLesson(connection, projectId);

    expect(() =>
      recordCorrectionLessonEvidence(connection, {
        taskId,
        lessonId: lesson.lessonId,
        lessonVersion: lesson.version,
        executionId,
      }),
    ).toThrow(FeedbackSignalError);
    expect(() =>
      recordCorrectionLessonEvidence(connection, {
        taskId,
        lessonId: lesson.lessonId,
        lessonVersion: lesson.version + 1,
      }),
    ).toThrow(FeedbackSignalError);
    expect(() =>
      recordCorrectionLessonEvidence(connection, {
        taskId: "missing-task",
        lessonId: lesson.lessonId,
        lessonVersion: lesson.version,
      }),
    ).toThrow(FeedbackSignalError);
  });
});

test("feedback signals persist observedAt separately from created_at", () => {
  withTestDatabase((connection, projectId) => {
    const taskId = createTaskWithProfile(connection, projectId);
    const observedAt = new Date("2026-09-06T08:30:00.000Z");

    const result = recordExplicitFeedback(connection, {
      taskId,
      feedbackKind: "acceptance",
      observedAt,
      now: NOW,
    });

    const row = readSignalRow(connection, result.signalId);
    expect(row.observed_at).toBe("2026-09-06T08:30:00.000Z");
    expect(row.created_at).toBe("2026-09-06T12:00:00.000Z");
  });
});
