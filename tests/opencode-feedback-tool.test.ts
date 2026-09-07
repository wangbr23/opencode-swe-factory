import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createTask,
  migrateSqliteSchema,
  openSqliteConnection,
  profileTask,
  releaseSchemaMigrations,
  resolveProjectIdentity,
  type SqliteConnection,
} from "../src/core/index.js";
import {
  createTaskBoundaryState,
  handleTaskBoundary,
} from "../src/opencode/index.js";
import {
  describeFeedbackResult,
  handleRecordFeedback,
} from "../src/opencode/feedback-tool.js";
import type { ResolvedFeatureToggles } from "../src/types/feature-toggle-types.js";

async function withTestDatabase(
  run: (connection: SqliteConnection, projectId: string) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(
    join(tmpdir(), "opencode-swe-factory-feedback-tool-"),
  );
  const connection = openSqliteConnection(join(directory, "memory.sqlite"));
  migrateSqliteSchema(connection, releaseSchemaMigrations);
  const { project } = resolveProjectIdentity(connection, {
    projectPath: "/repos/feedback-tool-test",
  });
  try {
    await run(connection, project.id);
  } finally {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const enabledToggles: ResolvedFeatureToggles = {
  retrieval: true,
  recording: true,
  modelTelemetry: true,
  routing: true,
  privateMode: false,
};

const recordingDisabledToggles: ResolvedFeatureToggles = {
  ...enabledToggles,
  recording: false,
};

const privateModeToggles: ResolvedFeatureToggles = {
  ...enabledToggles,
  privateMode: true,
};

async function startSessionTask(
  state: ReturnType<typeof createTaskBoundaryState>,
  connection: SqliteConnection,
  projectId: string,
  sessionId = "session-1",
): Promise<string> {
  const result = await handleTaskBoundary(
    state,
    connection,
    enabledToggles,
    {
      sessionId,
      messageText: "Fix the flaky test in the retrieval module.",
      projectId,
    },
    profileTask,
  );
  if (result.status !== "started") {
    const error = result.status === "failed" ? `: ${result.error}` : "";
    throw new Error(`Expected task boundary to start, got: ${result.status}${error}`);
  }
  return result.taskId;
}

function readSignalRow(
  connection: SqliteConnection,
  signalId: string,
): Record<string, unknown> {
  const row = connection.database
    .query<Record<string, unknown>, [string]>(
      "SELECT * FROM outcome_signals WHERE id = ?",
    )
    .get(signalId);
  if (!row) {
    throw new Error(`Expected an outcome signal row for ${signalId}`);
  }
  return row;
}

test("records acceptance feedback against the active session task", async () => {
  await withTestDatabase(async (connection, projectId) => {
    const state = createTaskBoundaryState();
    const taskId = await startSessionTask(state, connection, projectId);

    const result = handleRecordFeedback(
      state,
      connection,
      enabledToggles,
      { sessionId: "session-1", feedbackKind: "acceptance" },
    );

    expect(result.status).toBe("recorded");
    if (result.status !== "recorded") return;
    expect(result.taskId).toBe(taskId);
    expect(result.feedbackKind).toBe("acceptance");
    expect(result.value).toBe(1);
    expect(result.supersededSignalId).toBeUndefined();

    const row = readSignalRow(connection, result.signalId);
    expect(row.dimension).toBe("quality");
    expect(row.kind).toBe("explicit-feedback");
    expect(row.source).toBe("explicit-user-feedback");
  });
});

test("explicit taskId overrides the active session task", async () => {
  await withTestDatabase(async (connection, projectId) => {
    const state = createTaskBoundaryState();
    await startSessionTask(state, connection, projectId);

    const otherTask = createTask(connection, {
      projectId,
      sessionId: "session-other",
      boundary: "top-level",
    });

    const result = handleRecordFeedback(
      state,
      connection,
      enabledToggles,
      {
        sessionId: "session-1",
        feedbackKind: "rework",
        taskId: otherTask.taskId,
      },
    );

    expect(result.status).toBe("recorded");
    if (result.status !== "recorded") return;
    expect(result.taskId).toBe(otherTask.taskId);
    expect(result.value).toBe(0);
  });
});

test("skips when there is no active task and no task ID was provided", async () => {
  await withTestDatabase(async (connection) => {
    const state = createTaskBoundaryState();

    const result = handleRecordFeedback(
      state,
      connection,
      enabledToggles,
      { sessionId: "session-1", feedbackKind: "acceptance" },
    );

    expect(result).toEqual({ status: "skipped", reason: "no-active-task" });
  });
});

test("skips in private mode before touching the task state", async () => {
  await withTestDatabase(async (connection, projectId) => {
    const state = createTaskBoundaryState();
    await startSessionTask(state, connection, projectId);

    const result = handleRecordFeedback(
      state,
      connection,
      privateModeToggles,
      { sessionId: "session-1", feedbackKind: "acceptance" },
    );

    expect(result).toEqual({ status: "skipped", reason: "private-mode" });
  });
});

test("skips when the recording toggle is disabled", async () => {
  await withTestDatabase(async (connection, projectId) => {
    const state = createTaskBoundaryState();
    await startSessionTask(state, connection, projectId);

    const result = handleRecordFeedback(
      state,
      connection,
      recordingDisabledToggles,
      { sessionId: "session-1", feedbackKind: "acceptance" },
    );

    expect(result).toEqual({ status: "skipped", reason: "recording-disabled" });
  });
});

test("correction feedback retracts the task's latest acceptance signal", async () => {
  await withTestDatabase(async (connection, projectId) => {
    const state = createTaskBoundaryState();
    await startSessionTask(state, connection, projectId);

    const acceptance = handleRecordFeedback(
      state,
      connection,
      enabledToggles,
      { sessionId: "session-1", feedbackKind: "acceptance" },
    );
    if (acceptance.status !== "recorded") {
      throw new Error("Expected acceptance feedback to be recorded.");
    }

    const correction = handleRecordFeedback(
      state,
      connection,
      enabledToggles,
      { sessionId: "session-1", feedbackKind: "correction" },
    );

    expect(correction.status).toBe("recorded");
    if (correction.status !== "recorded") return;
    expect(correction.value).toBe(0);
    expect(correction.supersededSignalId).toBe(acceptance.signalId);

    const correctionRow = readSignalRow(connection, correction.signalId);
    expect(correctionRow.supersedes_signal_id).toBe(acceptance.signalId);
  });
});

test("reports failures from core validation as failed results", async () => {
  await withTestDatabase(async (connection, projectId) => {
    const state = createTaskBoundaryState();
    await startSessionTask(state, connection, projectId);

    const result = handleRecordFeedback(
      state,
      connection,
      enabledToggles,
      { sessionId: "session-1", feedbackKind: "correction", taskId: "missing-task" },
    );

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error).toContain("missing-task");
  });
});

test("describeFeedbackResult renders each outcome shape", async () => {
  expect(
    describeFeedbackResult({ status: "skipped", reason: "no-active-task" }),
  ).toContain("no active task");
  expect(
    describeFeedbackResult({ status: "skipped", reason: "private-mode" }),
  ).toContain("private mode");
  expect(
    describeFeedbackResult({ status: "skipped", reason: "recording-disabled" }),
  ).toContain("recording is disabled");
  expect(
    describeFeedbackResult({
      status: "failed",
      error: "Task not found.",
    }),
  ).toContain("Feedback failed: Task not found.");
  expect(
    describeFeedbackResult({
      status: "recorded",
      signalId: "signal-1",
      taskId: "task-1",
      feedbackKind: "acceptance",
      value: 1,
    }),
  ).toContain("Recorded acceptance feedback for task task-1.");
  expect(
    describeFeedbackResult({
      status: "recorded",
      signalId: "signal-1",
      taskId: "task-1",
      feedbackKind: "correction",
      value: 0,
      supersededSignalId: "signal-0",
    }),
  ).toContain("Retracted prior acceptance signal signal-0.");
});
