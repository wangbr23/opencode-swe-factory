import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  migrateSqliteSchema,
  openSqliteConnection,
  releaseSchemaMigrations,
  resolveProjectIdentity,
  type SqliteConnection,
} from "../../src/core/index.js";
import type { ResolvedFeatureToggles } from "../../src/types/feature-toggle-types.js";
import {
  createToolOutcomeCaptureState,
  handleToolCompletion,
} from "../../src/opencode/tool-outcome-capture.js";
import {
  createTaskBoundaryState,
  handleTaskBoundary,
} from "../../src/opencode/task-boundary.js";
import type { ProfileTaskFn } from "../../src/types/task-boundary-types.js";

function withDatabase(
  run: (connection: SqliteConnection, projectId: string) => void | Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(
    join(tmpdir(), "opencode-swe-factory-tool-outcome-capture-"),
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
  return { taskId: boundary.taskId, boundaryState };
}

function toolCompletionInput(overrides?: {
  callId?: string;
  tool?: string;
  args?: unknown;
  metadata?: unknown;
}) {
  return {
    sessionId: "s1",
    callId: "call-1",
    tool: "bash",
    args: { command: "bun test" },
    metadata: { exit: 0 },
    ...overrides,
  };
}

test("records a successful bash completion as a reliability signal on the active task", async () => {
  await withDatabase(async (connection, projectId) => {
    const { taskId, boundaryState } = await startTask(connection, projectId);
    const state = createToolOutcomeCaptureState();

    const result = handleToolCompletion(
      state,
      boundaryState,
      connection,
      enabledToggles,
      toolCompletionInput(),
    );

    expect(result.status).toBe("recorded");
    if (result.status !== "recorded") return;
    expect(result.taskId).toBe(taskId);
    expect(result.category).toBe("test");
    expect(result.value).toBe(1);

    const row = connection.database
      .query<Record<string, unknown>, [string]>(
        "SELECT * FROM outcome_signals WHERE id = ?",
      )
      .get(result.signalId);
    expect(row?.dimension).toBe("reliability");
    expect(row?.value).toBe(1);
    expect(JSON.parse(String(row?.metadata_json))).toEqual({
      tool: "bash",
      category: "test",
    });
  });
});

test("records a failed bash completion with the command failure kind", async () => {
  await withDatabase(async (connection, projectId) => {
    const { boundaryState } = await startTask(connection, projectId);
    const state = createToolOutcomeCaptureState();

    const result = handleToolCompletion(
      state,
      boundaryState,
      connection,
      enabledToggles,
      toolCompletionInput({
        metadata: { exit: 2 },
        args: { command: "bun run lint" },
      }),
    );

    expect(result.status).toBe("recorded");
    if (result.status !== "recorded") return;
    expect(result.value).toBe(0);
    expect(result.category).toBe("lint");

    const row = connection.database
      .query<Record<string, unknown>, [string]>(
        "SELECT metadata_json FROM outcome_signals WHERE id = ?",
      )
      .get(result.signalId);
    expect(JSON.parse(String(row?.metadata_json)).failureKind).toBe("command");
  });
});

test("classifies aborted tool completions as cancellation failures", async () => {
  await withDatabase(async (connection, projectId) => {
    const { boundaryState } = await startTask(connection, projectId);
    const state = createToolOutcomeCaptureState();

    const result = handleToolCompletion(
      state,
      boundaryState,
      connection,
      enabledToggles,
      toolCompletionInput({
        tool: "bash",
        args: { command: "bun test" },
        metadata: { aborted: true },
      }),
    );

    expect(result.status).toBe("recorded");
    if (result.status !== "recorded") return;
    expect(result.value).toBe(0);

    const row = connection.database
      .query<Record<string, unknown>, [string]>(
        "SELECT metadata_json FROM outcome_signals WHERE id = ?",
      )
      .get(result.signalId);
    expect(JSON.parse(String(row?.metadata_json)).failureKind).toBe("cancellation");
  });
});

test("classifies authentication and provider status codes separately from local tool errors", async () => {
  await withDatabase(async (connection, projectId) => {
    const { boundaryState } = await startTask(connection, projectId);
    const state = createToolOutcomeCaptureState();

    const classify = (statusCode: number) => {
      const result = handleToolCompletion(
        state,
        boundaryState,
        connection,
        enabledToggles,
        toolCompletionInput({
          callId: `call-${statusCode}`,
          metadata: { error: { name: "ToolError", statusCode } },
        }),
      );
      if (result.status !== "recorded") return `unrecorded:${result.status}`;
      const row = connection.database
        .query<Record<string, unknown>, [string]>(
          "SELECT metadata_json FROM outcome_signals WHERE id = ?",
        )
        .get(result.signalId);
      return String(JSON.parse(String(row?.metadata_json)).failureKind);
    };

    expect(classify(401)).toBe("authentication");
    expect(classify(403)).toBe("authentication");
    expect(classify(429)).toBe("provider");
    expect(classify(500)).toBe("provider");
    expect(classify(400)).toBe("local-tool");
  });
});

test("skips tool completions without an objective status", async () => {
  await withDatabase(async (connection, projectId) => {
    const { boundaryState } = await startTask(connection, projectId);
    const state = createToolOutcomeCaptureState();

    const result = handleToolCompletion(
      state,
      boundaryState,
      connection,
      enabledToggles,
      toolCompletionInput({ metadata: {} }),
    );

    expect(result).toEqual({ status: "skipped", reason: "indeterminate-status" });
  });
});

test("private mode and recording disabled skip capture before touching the database", async () => {
  await withDatabase(async (connection, projectId) => {
    const { boundaryState } = await startTask(connection, projectId);
    const state = createToolOutcomeCaptureState();

    expect(
      handleToolCompletion(
        state,
        boundaryState,
        connection,
        privateModeToggles,
        toolCompletionInput(),
      ),
    ).toEqual({ status: "skipped", reason: "private-mode" });

    expect(
      handleToolCompletion(
        state,
        boundaryState,
        connection,
        recordingDisabledToggles,
        toolCompletionInput(),
      ),
    ).toEqual({ status: "skipped", reason: "recording-disabled" });
  });
});

test("skips tool completions when no task is active and deduplicates repeat deliveries", async () => {
  await withDatabase(async (connection, projectId) => {
    const boundaryState = createTaskBoundaryState();
    const state = createToolOutcomeCaptureState();

    expect(
      handleToolCompletion(
        state,
        boundaryState,
        connection,
        enabledToggles,
        toolCompletionInput(),
      ),
    ).toEqual({ status: "skipped", reason: "no-active-task" });

    const { boundaryState: activeBoundaryState } = await startTask(connection, projectId);

    expect(
      handleToolCompletion(
        state,
        activeBoundaryState,
        connection,
        enabledToggles,
        toolCompletionInput(),
      ).status,
    ).toBe("recorded");

    expect(
      handleToolCompletion(
        state,
        activeBoundaryState,
        connection,
        enabledToggles,
        toolCompletionInput(),
      ),
    ).toEqual({ status: "skipped", reason: "already-recorded" });
  });
});

test("returns a failed result without marking the call recorded on persistence errors", async () => {
  await withDatabase(async (connection, projectId) => {
    const { boundaryState } = await startTask(connection, projectId);
    const state = createToolOutcomeCaptureState();
    connection.close();

    const result = handleToolCompletion(
      state,
      boundaryState,
      connection,
      enabledToggles,
      toolCompletionInput(),
    );

    expect(result.status).toBe("failed");
    expect(state.recordedCallIds.has("call-1")).toBe(false);
  });
});
