import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getExecutionProfile,
  migrateSqliteSchema,
  openSqliteConnection,
  releaseSchemaMigrations,
  resolveProjectIdentity,
  type SqliteConnection,
} from "../../src/core/index.js";
import type { ResolvedFeatureToggles } from "../../src/types/feature-toggle-types.js";
import type { AssistantCompletionInput } from "../../src/types/execution-capture-types.js";
import type { ProfileTaskFn } from "../../src/types/task-boundary-types.js";
import {
  createExecutionCaptureState,
  handleAssistantCompletion,
} from "../../src/opencode/execution-capture.js";
import {
  createTaskBoundaryState,
  handleTaskBoundary,
} from "../../src/opencode/task-boundary.js";

function withDatabase(
  run: (connection: SqliteConnection, projectId: string) => void | Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(
    join(tmpdir(), "opencode-swe-factory-execution-capture-"),
  );
  const connection = openSqliteConnection(join(directory, "memory.sqlite"));
  migrateSqliteSchema(connection, releaseSchemaMigrations);
  const { project } = resolveProjectIdentity(connection, { projectPath: "/repos/capture-test" });
  const result = run(connection, project.id);
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

const enabledToggles: ResolvedFeatureToggles = {
  privateMode: false,
  retrieval: true,
  recording: true,
  modelTelemetry: true,
  routing: false,
};

const telemetryDisabledToggles: ResolvedFeatureToggles = {
  privateMode: false,
  retrieval: true,
  recording: true,
  modelTelemetry: false,
  routing: false,
};

const privateModeToggles: ResolvedFeatureToggles = {
  privateMode: true,
  retrieval: false,
  recording: false,
  modelTelemetry: false,
  routing: false,
};

const profileFn: ProfileTaskFn = async () => ({
  taxonomyVersion: 1,
  boundary: "top-level",
  activity: "implement",
  domain: "backend",
  complexity: "medium",
  risk: "low",
  stack: ["typescript"],
  signals: ["activity-lexical"],
  summary: "stub summary",
});

type Session = {
  connection: SqliteConnection;
  projectId: string;
  taskId: string;
  boundaryState: ReturnType<typeof createTaskBoundaryState>;
};

async function startTask(
  connection: SqliteConnection,
  projectId: string,
  sessionId = "s1",
): Promise<Session> {
  const boundaryState = createTaskBoundaryState();
  const boundary = await handleTaskBoundary(
    boundaryState,
    connection,
    enabledToggles,
    {
      sessionId,
      messageText: "Fix the login bug",
      projectId,
      agent: "build",
    },
    profileFn,
  );
  if (boundary.status !== "started") {
    throw new Error(`expected task to start, got ${boundary.status}`);
  }
  return { connection, projectId, taskId: boundary.taskId, boundaryState };
}

function completionInput(overrides?: {
  agent?: string;
  startedAtMs?: number;
  error?: AssistantCompletionInput["error"];
}) {
  return {
    sessionId: "s1",
    messageId: "assistant-1",
    agent: overrides?.agent ?? "build",
    provider: "openai",
    model: "gpt-4.1",
    costUsd: 0.02,
    tokens: { input: 120, output: 80, reasoning: 15, cacheRead: 30, cacheWrite: 6 },
    startedAtMs: overrides?.startedAtMs ?? Date.parse("2026-09-06T12:00:00.000Z"),
    completedAtMs: Date.parse("2026-09-06T12:00:07.000Z"),
    finish: "stop",
    softwareVersions: { opencode: "1.18.27" },
    ...(overrides?.error ? { error: overrides.error } : {}),
  };
}

test("handleAssistantCompletion skips in private mode", () =>
  withDatabase(async (connection, projectId) => {
    await startTask(connection, projectId);
    const captureState = createExecutionCaptureState();
    const boundaryState = createTaskBoundaryState();

    const result = handleAssistantCompletion(
      captureState,
      boundaryState,
      connection,
      privateModeToggles,
      completionInput(),
    );

    expect(result).toEqual({ status: "skipped", reason: "private-mode" });
  }));

test("handleAssistantCompletion skips when model telemetry is disabled", () =>
  withDatabase(async (connection, projectId) => {
    await startTask(connection, projectId);
    const result = handleAssistantCompletion(
      createExecutionCaptureState(),
      createTaskBoundaryState(),
      connection,
      telemetryDisabledToggles,
      completionInput(),
    );

    expect(result).toEqual({ status: "skipped", reason: "model-telemetry-disabled" });
  }));

test("handleAssistantCompletion skips without an active task", () =>
  withDatabase(async (connection) => {
    const result = handleAssistantCompletion(
      createExecutionCaptureState(),
      createTaskBoundaryState(),
      connection,
      enabledToggles,
      completionInput(),
    );

    expect(result).toEqual({ status: "skipped", reason: "no-active-task" });
  }));

test("handleAssistantCompletion skips incomplete completions and duplicates", () =>
  withDatabase(async (connection, projectId) => {
    const session = await startTask(connection, projectId);
    const captureState = createExecutionCaptureState();

    const { completedAtMs: _completedAtMs, ...incompleteInput } = completionInput();
    const incomplete = handleAssistantCompletion(
      captureState,
      session.boundaryState,
      connection,
      enabledToggles,
      incompleteInput,
    );
    expect(incomplete).toEqual({ status: "skipped", reason: "incomplete-completion" });

    const first = handleAssistantCompletion(
      captureState,
      session.boundaryState,
      connection,
      enabledToggles,
      completionInput(),
    );
    expect(first.status).toBe("recorded");

    const duplicate = handleAssistantCompletion(
      captureState,
      session.boundaryState,
      connection,
      enabledToggles,
      completionInput(),
    );
    expect(duplicate).toEqual({ status: "skipped", reason: "already-recorded" });
  }));

test("handleAssistantCompletion records the execution profile and provider outcome signals", () =>
  withDatabase(async (connection, projectId) => {
    const session = await startTask(connection, projectId);
    const result = handleAssistantCompletion(
      createExecutionCaptureState(),
      session.boundaryState,
      connection,
      enabledToggles,
      completionInput(),
    );

    if (result.status !== "recorded") throw new Error(`unexpected status: ${result.status}`);
    expect(result.taskId).toBe(session.taskId);
    expect(result.signalIds).toHaveLength(3);

    const stored = getExecutionProfile(connection, result.executionId);
    expect(stored?.task_id).toBe(session.taskId);
    expect(stored?.provider).toBe("openai");
    expect(stored?.model).toBe("gpt-4.1");
    expect(stored?.agent).toBe("build");
    expect(stored?.selection_source).toBe("host");
    expect(stored?.latency_ms).toBe(7000);
    expect(stored?.finish_state).toBe("stop");
    expect(JSON.parse(stored?.software_versions_json ?? "{}")).toEqual({
      opencode: "1.18.27",
    });

    expect(stored?.signals.map((s) => s.dimension).sort()).toEqual([
      "cost",
      "latency",
      "reliability",
    ]);
    const cost = stored?.signals.find((s) => s.dimension === "cost");
    expect(cost?.kind).toBe("assistant-cost");
    expect(cost?.value).toBe(0.02);
    expect(cost?.execution_id).toBe(result.executionId);
    const latency = stored?.signals.find((s) => s.dimension === "latency");
    expect(latency?.value).toBe(7000);
    const reliability = stored?.signals.find((s) => s.dimension === "reliability");
    expect(reliability?.value).toBe(1);
    expect(JSON.parse(reliability?.metadata_json ?? "{}")).toEqual({ finishState: "stop" });
  }));

test("handleAssistantCompletion records error state and reliability signal for provider errors", () =>
  withDatabase(async (connection, projectId) => {
    const session = await startTask(connection, projectId);
    const { finish: _finish, ...errorInput } = completionInput({
      error: { name: "APIError", code: "429" },
    });
    const result = handleAssistantCompletion(
      createExecutionCaptureState(),
      session.boundaryState,
      connection,
      enabledToggles,
      errorInput,
    );

    if (result.status !== "recorded") throw new Error(`unexpected status: ${result.status}`);

    const stored = getExecutionProfile(connection, result.executionId);
    expect(stored?.finish_state).toBe("error");
    expect(stored?.provider_error_kind).toBe("APIError");
    expect(stored?.provider_error_code).toBe("429");

    const reliability = stored?.signals.find((s) => s.dimension === "reliability");
    expect(reliability?.value).toBe(0);
    expect(JSON.parse(reliability?.metadata_json ?? "{}")).toEqual({
      finishState: "error",
      errorKind: "APIError",
    });
  }));

test("handleAssistantCompletion clamps negative latency to zero", () =>
  withDatabase(async (connection, projectId) => {
    const session = await startTask(connection, projectId);
    const result = handleAssistantCompletion(
      createExecutionCaptureState(),
      session.boundaryState,
      connection,
      enabledToggles,
      completionInput({
        startedAtMs: Date.parse("2026-09-06T12:00:10.000Z"),
      }),
    );
    // completedAtMs (12:00:07) is now before startedAtMs (12:00:10).

    if (result.status !== "recorded") throw new Error(`unexpected status: ${result.status}`);
    const stored = getExecutionProfile(connection, result.executionId);
    expect(stored?.latency_ms).toBe(0);
  }));

test("handleAssistantCompletion fails open with a structured error result", () =>
  withDatabase(async (connection, projectId) => {
    const captureState = createExecutionCaptureState();
    const boundaryState = createTaskBoundaryState();
    const taskId = "no-such-task";
    // Seed an active task whose record does not exist in the database.
    boundaryState.sessions.set("s1", {
      rootAgentEstablished: true,
      rootAgent: "build",
      topLevelTask: {
        taskId,
        sessionId: "s1",
        boundary: "top-level",
        agent: "build",
        startedAt: "2026-09-06T12:00:00.000Z",
      },
      subtasks: new Map(),
    });

    const result = handleAssistantCompletion(
      captureState,
      boundaryState,
      connection,
      enabledToggles,
      completionInput(),
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain(taskId);
    }
    expect(captureState.recordedMessageIds.has("assistant-1")).toBe(false);
  }));

test("handleAssistantCompletion records subtask executions against the subtask", () =>
  withDatabase(async (connection, projectId) => {
    const state = createTaskBoundaryState();
    await handleTaskBoundary(
      state,
      connection,
      enabledToggles,
      { sessionId: "s1", messageText: "Top-level request", projectId, agent: "build" },
      profileFn,
    );
    const subtask = await handleTaskBoundary(
      state,
      connection,
      enabledToggles,
      { sessionId: "s1", messageText: "Search the codebase", projectId, agent: "explore" },
      profileFn,
    );
    if (subtask.status !== "started") throw new Error("expected subtask to start");

    const result = handleAssistantCompletion(
      createExecutionCaptureState(),
      state,
      connection,
      enabledToggles,
      completionInput({ agent: "explore" }),
    );

    if (result.status !== "recorded") throw new Error(`unexpected status: ${result.status}`);
    expect(result.taskId).toBe(subtask.taskId);
  }));
