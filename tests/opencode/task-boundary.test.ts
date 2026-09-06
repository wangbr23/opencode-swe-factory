import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getTaskWithProfile,
  migrateSqliteSchema,
  openSqliteConnection,
  releaseSchemaMigrations,
  type SqliteConnection,
} from "../../src/core/index.js";
import type { TaskProfile } from "../../src/types/task-profile-types.js";
import type { ResolvedFeatureToggles } from "../../src/types/feature-toggle-types.js";
import type { ProfileTaskFn } from "../../src/types/task-boundary-types.js";
import {
  completeActiveTask,
  completeSessionTasks,
  createTaskBoundaryState,
  extractMessageText,
  getActiveTask,
  handleTaskBoundary,
} from "../../src/opencode/task-boundary.js";

function withDatabase(
  run: (connection: SqliteConnection) => void | Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(
    join(tmpdir(), "opencode-swe-factory-task-boundary-"),
  );
  const connection = openSqliteConnection(join(directory, "memory.sqlite"));
  migrateSqliteSchema(connection, releaseSchemaMigrations);
  const result = run(connection);
  const cleanup = () => {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  };
  if (result instanceof Promise) {
    return result.finally(cleanup);
  }
  cleanup();
  return Promise.resolve();
}

function insertProject(connection: SqliteConnection, id: string): void {
  connection.database.run(
    "INSERT INTO projects (id, path, created_at, updated_at) VALUES (?, ?, ?, ?)",
    [id, `/repos/${id}`, "2026-09-06T00:00:00.000Z", "2026-09-06T00:00:00.000Z"],
  );
}

const enabledToggles: ResolvedFeatureToggles = {
  privateMode: false,
  retrieval: true,
  recording: true,
  modelTelemetry: true,
  routing: false,
};

const privateModeToggles: ResolvedFeatureToggles = {
  privateMode: true,
  retrieval: false,
  recording: false,
  modelTelemetry: false,
  routing: false,
};

const recordingDisabledToggles: ResolvedFeatureToggles = {
  privateMode: false,
  retrieval: true,
  recording: false,
  modelTelemetry: true,
  routing: false,
};

function stubProfile(overrides?: Partial<TaskProfile>): TaskProfile {
  return {
    taxonomyVersion: 1,
    boundary: "top-level",
    activity: "implement",
    domain: "backend",
    complexity: "medium",
    risk: "medium",
    stack: [],
    signals: ["activity-lexical"],
    summary: "stub summary",
    ...overrides,
  };
}

function createProfileFn(profile?: TaskProfile): ProfileTaskFn {
  return async () => profile ?? stubProfile();
}

// --- extractMessageText ---

test("extractMessageText joins text parts and trims outer whitespace", () => {
  const parts = [
    { type: "text", text: "Fix the login bug" },
    { type: "reasoning", text: "thinking..." },
    { type: "text", text: "in the auth module" },
  ];
  expect(extractMessageText(parts)).toBe(
    "Fix the login bug\nin the auth module",
  );
});

test("extractMessageText returns empty string for no text parts", () => {
  const parts = [
    { type: "reasoning", text: "thinking..." },
    { type: "tool", text: "result" },
  ];
  expect(extractMessageText(parts)).toBe("");
});

test("extractMessageText handles empty array", () => {
  expect(extractMessageText([])).toBe("");
});

test("extractMessageText skips parts without text field", () => {
  const parts = [
    { type: "text" },
    { type: "text", text: "actual content" },
  ];
  expect(extractMessageText(parts)).toBe("actual content");
});

// --- handleTaskBoundary: toggle checks ---

test("handleTaskBoundary skips in private mode", () =>
  withDatabase(async (connection) => {
    insertProject(connection, "proj-1");
    const state = createTaskBoundaryState();
    const result = await handleTaskBoundary(
      state,
      connection,
      privateModeToggles,
      {
        sessionId: "s1",
        messageText: "Fix something",
        projectId: "proj-1",
        now: "2026-09-06T00:00:00.000Z",
      },
      createProfileFn(),
    );
    expect(result).toEqual({ status: "skipped", reason: "private-mode" });
  }));

test("handleTaskBoundary skips when recording disabled", () =>
  withDatabase(async (connection) => {
    insertProject(connection, "proj-1");
    const state = createTaskBoundaryState();
    const result = await handleTaskBoundary(
      state,
      connection,
      recordingDisabledToggles,
      {
        sessionId: "s1",
        messageText: "Fix something",
        projectId: "proj-1",
        now: "2026-09-06T00:00:00.000Z",
      },
      createProfileFn(),
    );
    expect(result).toEqual({
      status: "skipped",
      reason: "recording-disabled",
    });
  }));

test("handleTaskBoundary skips empty text", () =>
  withDatabase(async (connection) => {
    insertProject(connection, "proj-1");
    const state = createTaskBoundaryState();
    const result = await handleTaskBoundary(
      state,
      connection,
      enabledToggles,
      {
        sessionId: "s1",
        messageText: "   ",
        projectId: "proj-1",
        now: "2026-09-06T00:00:00.000Z",
      },
      createProfileFn(),
    );
    expect(result).toEqual({ status: "skipped", reason: "empty-text" });
  }));

// --- handleTaskBoundary: top-level tasks ---

test("first message in session creates top-level task", () =>
  withDatabase(async (connection) => {
    insertProject(connection, "proj-1");
    const state = createTaskBoundaryState();
    const profile = stubProfile();

    const result = await handleTaskBoundary(
      state,
      connection,
      enabledToggles,
      {
        sessionId: "s1",
        agent: "build",
        messageId: "msg-1",
        messageText: "Add a new feature for user authentication",
        projectId: "proj-1",
        now: "2026-09-06T01:00:00.000Z",
      },
      createProfileFn(profile),
    );

    expect(result.status).toBe("started");
    if (result.status !== "started") return;
    expect(result.boundary).toBe("top-level");
    expect(result.profile).toEqual(profile);
    expect(result.previousTaskCompleted).toBe(false);

    const persisted = getTaskWithProfile(connection, result.taskId);
    expect(persisted).not.toBeNull();
    expect(persisted!.boundary).toBe("top-level");
    expect(persisted!.projectId).toBe("proj-1");
    expect(persisted!.sessionId).toBe("s1");
    expect(persisted!.hostTaskId).toBe("msg-1");
    expect(persisted!.parentTaskId).toBeNull();
    expect(persisted!.activeProfile).not.toBeNull();
    expect(persisted!.completedAt).toBeNull();
  }));

test("second message from same agent creates new top-level and completes previous", () =>
  withDatabase(async (connection) => {
    insertProject(connection, "proj-1");
    const state = createTaskBoundaryState();

    const first = await handleTaskBoundary(
      state,
      connection,
      enabledToggles,
      {
        sessionId: "s1",
        agent: "build",
        messageText: "First task text",
        projectId: "proj-1",
        now: "2026-09-06T01:00:00.000Z",
      },
      createProfileFn(),
    );
    expect(first.status).toBe("started");
    if (first.status !== "started") return;
    const firstTaskId = first.taskId;

    const second = await handleTaskBoundary(
      state,
      connection,
      enabledToggles,
      {
        sessionId: "s1",
        agent: "build",
        messageText: "Second task text",
        projectId: "proj-1",
        now: "2026-09-06T02:00:00.000Z",
      },
      createProfileFn(),
    );
    expect(second.status).toBe("started");
    if (second.status !== "started") return;
    expect(second.boundary).toBe("top-level");
    expect(second.previousTaskCompleted).toBe(true);

    const firstPersisted = getTaskWithProfile(connection, firstTaskId);
    expect(firstPersisted!.completedAt).not.toBeNull();
  }));

test("message without agent treated as top-level", () =>
  withDatabase(async (connection) => {
    insertProject(connection, "proj-1");
    const state = createTaskBoundaryState();

    const result = await handleTaskBoundary(
      state,
      connection,
      enabledToggles,
      {
        sessionId: "s1",
        messageText: "Do something",
        projectId: "proj-1",
        now: "2026-09-06T01:00:00.000Z",
      },
      createProfileFn(),
    );
    expect(result.status).toBe("started");
    if (result.status !== "started") return;
    expect(result.boundary).toBe("top-level");
  }));

// --- handleTaskBoundary: subtask detection ---

test("different agent creates subtask under top-level task", () =>
  withDatabase(async (connection) => {
    insertProject(connection, "proj-1");
    const state = createTaskBoundaryState();

    const topLevel = await handleTaskBoundary(
      state,
      connection,
      enabledToggles,
      {
        sessionId: "s1",
        agent: "build",
        messageText: "Main task",
        projectId: "proj-1",
        now: "2026-09-06T01:00:00.000Z",
      },
      createProfileFn(),
    );
    expect(topLevel.status).toBe("started");
    if (topLevel.status !== "started") return;

    const subtask = await handleTaskBoundary(
      state,
      connection,
      enabledToggles,
      {
        sessionId: "s1",
        agent: "code",
        messageText: "Delegated subtask work",
        projectId: "proj-1",
        now: "2026-09-06T01:01:00.000Z",
      },
      createProfileFn(stubProfile({ boundary: "subtask" })),
    );
    expect(subtask.status).toBe("started");
    if (subtask.status !== "started") return;
    expect(subtask.boundary).toBe("subtask");
    expect(subtask.previousTaskCompleted).toBe(false);

    const persisted = getTaskWithProfile(connection, subtask.taskId);
    expect(persisted!.parentTaskId).toBe(topLevel.taskId);
    expect(persisted!.boundary).toBe("subtask");
  }));

test("repeated subtask from same agent completes previous subtask", () =>
  withDatabase(async (connection) => {
    insertProject(connection, "proj-1");
    const state = createTaskBoundaryState();

    await handleTaskBoundary(
      state,
      connection,
      enabledToggles,
      {
        sessionId: "s1",
        agent: "build",
        messageText: "Main task",
        projectId: "proj-1",
        now: "2026-09-06T01:00:00.000Z",
      },
      createProfileFn(),
    );

    const first = await handleTaskBoundary(
      state,
      connection,
      enabledToggles,
      {
        sessionId: "s1",
        agent: "code",
        messageText: "First subtask",
        projectId: "proj-1",
        now: "2026-09-06T01:01:00.000Z",
      },
      createProfileFn(),
    );
    expect(first.status).toBe("started");
    if (first.status !== "started") return;

    const second = await handleTaskBoundary(
      state,
      connection,
      enabledToggles,
      {
        sessionId: "s1",
        agent: "code",
        messageText: "Second subtask",
        projectId: "proj-1",
        now: "2026-09-06T01:02:00.000Z",
      },
      createProfileFn(),
    );
    expect(second.status).toBe("started");
    if (second.status !== "started") return;
    expect(second.previousTaskCompleted).toBe(true);

    const firstPersisted = getTaskWithProfile(connection, first.taskId);
    expect(firstPersisted!.completedAt).not.toBeNull();
  }));

// --- handleTaskBoundary: profile persistence ---

test("persisted profile matches input profile", () =>
  withDatabase(async (connection) => {
    insertProject(connection, "proj-1");
    const state = createTaskBoundaryState();
    const profile = stubProfile({
      activity: "fix",
      domain: "security",
      complexity: "high",
      risk: "high",
      stack: ["typescript", "bun"],
      signals: ["activity-lexical", "domain-lexical", "stack-lexical"],
    });

    const result = await handleTaskBoundary(
      state,
      connection,
      enabledToggles,
      {
        sessionId: "s1",
        messageText: "Fix auth vulnerability in token handler",
        projectId: "proj-1",
        declaredStack: ["typescript"],
        now: "2026-09-06T01:00:00.000Z",
      },
      createProfileFn(profile),
    );
    expect(result.status).toBe("started");
    if (result.status !== "started") return;

    const persisted = getTaskWithProfile(connection, result.taskId);
    expect(persisted!.activeProfile).not.toBeNull();
    expect(persisted!.activeProfile!.activity).toBe("fix");
    expect(persisted!.activeProfile!.domain).toBe("security");
    expect(persisted!.activeProfile!.complexity).toBe("high");
    expect(persisted!.activeProfile!.source).toBe("inferred");
  }));

test("declaredStack is passed to profile function", () =>
  withDatabase(async (connection) => {
    insertProject(connection, "proj-1");
    const state = createTaskBoundaryState();
    let receivedInput: { declaredStack?: ReadonlyArray<string> } | undefined;

    const capturingProfileFn: ProfileTaskFn = async (input) => {
      receivedInput = input;
      return stubProfile();
    };

    await handleTaskBoundary(
      state,
      connection,
      enabledToggles,
      {
        sessionId: "s1",
        messageText: "Do something",
        projectId: "proj-1",
        declaredStack: ["typescript", "react"],
        now: "2026-09-06T01:00:00.000Z",
      },
      capturingProfileFn,
    );

    expect(receivedInput).toBeDefined();
    expect(receivedInput!.declaredStack).toEqual(["typescript", "react"]);
  }));

// --- handleTaskBoundary: session isolation ---

test("separate sessions have independent task tracking", () =>
  withDatabase(async (connection) => {
    insertProject(connection, "proj-1");
    const state = createTaskBoundaryState();

    const s1 = await handleTaskBoundary(
      state,
      connection,
      enabledToggles,
      {
        sessionId: "s1",
        agent: "build",
        messageText: "Session one task",
        projectId: "proj-1",
        now: "2026-09-06T01:00:00.000Z",
      },
      createProfileFn(),
    );

    const s2 = await handleTaskBoundary(
      state,
      connection,
      enabledToggles,
      {
        sessionId: "s2",
        agent: "build",
        messageText: "Session two task",
        projectId: "proj-1",
        now: "2026-09-06T01:00:00.000Z",
      },
      createProfileFn(),
    );

    expect(s1.status).toBe("started");
    expect(s2.status).toBe("started");
    if (s1.status !== "started" || s2.status !== "started") return;
    expect(s1.taskId).not.toBe(s2.taskId);
    expect(s1.previousTaskCompleted).toBe(false);
    expect(s2.previousTaskCompleted).toBe(false);
  }));

// --- handleTaskBoundary: error handling ---

test("handleTaskBoundary returns failed on profiling error", () =>
  withDatabase(async (connection) => {
    insertProject(connection, "proj-1");
    const state = createTaskBoundaryState();

    const failingProfileFn: ProfileTaskFn = async () => {
      throw new Error("Profiling failed");
    };

    const result = await handleTaskBoundary(
      state,
      connection,
      enabledToggles,
      {
        sessionId: "s1",
        messageText: "Some task",
        projectId: "proj-1",
        now: "2026-09-06T01:00:00.000Z",
      },
      failingProfileFn,
    );

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error).toContain("Profiling failed");
  }));

// --- getActiveTask ---

test("getActiveTask returns top-level task for root agent", () =>
  withDatabase(async (connection) => {
    insertProject(connection, "proj-1");
    const state = createTaskBoundaryState();

    const result = await handleTaskBoundary(
      state,
      connection,
      enabledToggles,
      {
        sessionId: "s1",
        agent: "build",
        messageText: "Main task",
        projectId: "proj-1",
        now: "2026-09-06T01:00:00.000Z",
      },
      createProfileFn(),
    );
    expect(result.status).toBe("started");
    if (result.status !== "started") return;

    const active = getActiveTask(state, "s1", "build");
    expect(active).not.toBeNull();
    expect(active!.taskId).toBe(result.taskId);
    expect(active!.boundary).toBe("top-level");
  }));

test("getActiveTask returns subtask for non-root agent", () =>
  withDatabase(async (connection) => {
    insertProject(connection, "proj-1");
    const state = createTaskBoundaryState();

    await handleTaskBoundary(
      state,
      connection,
      enabledToggles,
      {
        sessionId: "s1",
        agent: "build",
        messageText: "Main task",
        projectId: "proj-1",
        now: "2026-09-06T01:00:00.000Z",
      },
      createProfileFn(),
    );

    const subtask = await handleTaskBoundary(
      state,
      connection,
      enabledToggles,
      {
        sessionId: "s1",
        agent: "code",
        messageText: "Subtask work",
        projectId: "proj-1",
        now: "2026-09-06T01:01:00.000Z",
      },
      createProfileFn(),
    );
    expect(subtask.status).toBe("started");
    if (subtask.status !== "started") return;

    const active = getActiveTask(state, "s1", "code");
    expect(active).not.toBeNull();
    expect(active!.taskId).toBe(subtask.taskId);
    expect(active!.boundary).toBe("subtask");
  }));

test("getActiveTask returns null for unknown session", () => {
  const state = createTaskBoundaryState();
  expect(getActiveTask(state, "nonexistent")).toBeNull();
});

// --- completeActiveTask ---

test("completeActiveTask marks top-level task as completed", () =>
  withDatabase(async (connection) => {
    insertProject(connection, "proj-1");
    const state = createTaskBoundaryState();

    const started = await handleTaskBoundary(
      state,
      connection,
      enabledToggles,
      {
        sessionId: "s1",
        agent: "build",
        messageText: "Task to complete",
        projectId: "proj-1",
        now: "2026-09-06T01:00:00.000Z",
      },
      createProfileFn(),
    );
    expect(started.status).toBe("started");
    if (started.status !== "started") return;

    const result = completeActiveTask(
      state,
      connection,
      "s1",
      "build",
      "2026-09-06T02:00:00.000Z",
    );
    expect(result).toEqual({ status: "completed", taskId: started.taskId });

    const persisted = getTaskWithProfile(connection, started.taskId);
    expect(persisted!.completedAt).not.toBeNull();

    expect(getActiveTask(state, "s1", "build")).toBeNull();
  }));

test("completeActiveTask completes subtask without affecting top-level", () =>
  withDatabase(async (connection) => {
    insertProject(connection, "proj-1");
    const state = createTaskBoundaryState();

    const topLevel = await handleTaskBoundary(
      state,
      connection,
      enabledToggles,
      {
        sessionId: "s1",
        agent: "build",
        messageText: "Main task",
        projectId: "proj-1",
        now: "2026-09-06T01:00:00.000Z",
      },
      createProfileFn(),
    );

    const subtask = await handleTaskBoundary(
      state,
      connection,
      enabledToggles,
      {
        sessionId: "s1",
        agent: "code",
        messageText: "Subtask",
        projectId: "proj-1",
        now: "2026-09-06T01:01:00.000Z",
      },
      createProfileFn(),
    );
    expect(subtask.status).toBe("started");
    if (subtask.status !== "started") return;

    completeActiveTask(state, connection, "s1", "code");

    expect(getActiveTask(state, "s1", "code")).toBeNull();
    expect(getActiveTask(state, "s1", "build")).not.toBeNull();
    if (topLevel.status !== "started") return;
    const topPersisted = getTaskWithProfile(connection, topLevel.taskId);
    expect(topPersisted!.completedAt).toBeNull();
  }));

test("completeActiveTask returns skipped for unknown session", () =>
  withDatabase((connection) => {
    const state = createTaskBoundaryState();
    const result = completeActiveTask(state, connection, "nonexistent");
    expect(result).toEqual({ status: "skipped", reason: "no-active-task" });
  }));

// --- completeSessionTasks ---

test("completeSessionTasks completes all tasks and cleans up session", () =>
  withDatabase(async (connection) => {
    insertProject(connection, "proj-1");
    const state = createTaskBoundaryState();

    const topLevel = await handleTaskBoundary(
      state,
      connection,
      enabledToggles,
      {
        sessionId: "s1",
        agent: "build",
        messageText: "Main task",
        projectId: "proj-1",
        now: "2026-09-06T01:00:00.000Z",
      },
      createProfileFn(),
    );

    await handleTaskBoundary(
      state,
      connection,
      enabledToggles,
      {
        sessionId: "s1",
        agent: "code",
        messageText: "Subtask",
        projectId: "proj-1",
        now: "2026-09-06T01:01:00.000Z",
      },
      createProfileFn(),
    );

    const completed = completeSessionTasks(
      state,
      connection,
      "s1",
      "2026-09-06T02:00:00.000Z",
    );

    expect(completed).toHaveLength(2);
    expect(getActiveTask(state, "s1")).toBeNull();
    expect(state.sessions.has("s1")).toBe(false);

    if (topLevel.status !== "started") return;
    const topPersisted = getTaskWithProfile(connection, topLevel.taskId);
    expect(topPersisted!.completedAt).not.toBeNull();
  }));

test("completeSessionTasks returns empty array for unknown session", () =>
  withDatabase((connection) => {
    const state = createTaskBoundaryState();
    const completed = completeSessionTasks(state, connection, "nonexistent");
    expect(completed).toEqual([]);
  }));

// --- boundary edge cases ---

test("undefined agent followed by named agent treats named as subtask", () =>
  withDatabase(async (connection) => {
    insertProject(connection, "proj-1");
    const state = createTaskBoundaryState();

    await handleTaskBoundary(
      state,
      connection,
      enabledToggles,
      {
        sessionId: "s1",
        messageText: "Top-level with no agent",
        projectId: "proj-1",
        now: "2026-09-06T01:00:00.000Z",
      },
      createProfileFn(),
    );

    const subtask = await handleTaskBoundary(
      state,
      connection,
      enabledToggles,
      {
        sessionId: "s1",
        agent: "code",
        messageText: "Delegated work",
        projectId: "proj-1",
        now: "2026-09-06T01:01:00.000Z",
      },
      createProfileFn(),
    );
    expect(subtask.status).toBe("started");
    if (subtask.status !== "started") return;
    expect(subtask.boundary).toBe("subtask");
  }));

test("undefined agent after named root agent is treated as top-level", () =>
  withDatabase(async (connection) => {
    insertProject(connection, "proj-1");
    const state = createTaskBoundaryState();

    await handleTaskBoundary(
      state,
      connection,
      enabledToggles,
      {
        sessionId: "s1",
        agent: "build",
        messageText: "Root agent task",
        projectId: "proj-1",
        now: "2026-09-06T01:00:00.000Z",
      },
      createProfileFn(),
    );

    const result = await handleTaskBoundary(
      state,
      connection,
      enabledToggles,
      {
        sessionId: "s1",
        messageText: "Subsequent no-agent message",
        projectId: "proj-1",
        now: "2026-09-06T01:01:00.000Z",
      },
      createProfileFn(),
    );
    expect(result.status).toBe("started");
    if (result.status !== "started") return;
    expect(result.boundary).toBe("top-level");
    expect(result.previousTaskCompleted).toBe(true);
  }));
