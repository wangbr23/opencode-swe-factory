import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createTask,
  ExecutionProfileError,
  getExecutionProfile,
  migrateSqliteSchema,
  openSqliteConnection,
  persistTaskProfile,
  recordExecutionProfile,
  recordOutcomeSignal,
  releaseSchemaMigrations,
  resolveProjectIdentity,
  TaskPersistenceError,
  type SqliteConnection,
} from "../src/core/index.js";

const NOW = new Date("2026-09-06T12:00:00.000Z");

function withTestDatabase(
  run: (connection: SqliteConnection, projectId: string) => void,
): void {
  const directory = mkdtempSync(
    join(tmpdir(), "opencode-swe-factory-execution-profiles-"),
  );
  const dbPath = join(directory, "memory.sqlite");
  const connection = openSqliteConnection(dbPath);
  migrateSqliteSchema(connection, releaseSchemaMigrations);
  const { project } = resolveProjectIdentity(connection, { projectPath: "/repos/test-project" });
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
      summary: "Add the execution profile module.",
    },
    now: NOW,
  });
  return task.taskId;
}

function executionInput(overrides?: Partial<Parameters<typeof recordExecutionProfile>[1]>) {
  return {
    taskId: "task-placeholder",
    provider: "openai",
    model: "gpt-4.1",
    agent: "build",
    selectionSource: "host",
    startedAt: new Date("2026-09-06T12:00:00.000Z"),
    completedAt: new Date("2026-09-06T12:00:05.000Z"),
    latencyMs: 5000,
    tokens: { input: 100, output: 50, reasoning: 10, cacheRead: 20, cacheWrite: 5 },
    costUsd: 0.01,
    finishState: "stop",
    ...overrides,
  };
}

test("recordExecutionProfile inserts a profile linked to the task's active profile version", () => {
  withTestDatabase((connection, projectId) => {
    const taskId = createTaskWithProfile(connection, projectId);

    const result = recordExecutionProfile(
      connection,
      executionInput({ taskId }),
    );

    const stored = getExecutionProfile(connection, result.executionId);
    expect(stored).not.toBeNull();
    expect(stored?.task_id).toBe(taskId);
    expect(stored?.task_profile_version).toBe(1);
    expect(stored?.provider).toBe("openai");
    expect(stored?.model).toBe("gpt-4.1");
    expect(stored?.variant).toBeNull();
    expect(stored?.agent).toBe("build");
    expect(stored?.selection_source).toBe("host");
    expect(stored?.latency_ms).toBe(5000);
    expect(stored?.input_tokens).toBe(100);
    expect(stored?.cost_usd).toBe(0.01);
    expect(stored?.finish_state).toBe("stop");
    expect(stored?.provider_error_kind).toBeNull();
    expect(JSON.parse(stored?.tool_profile_json ?? "{}")).toEqual({});
    expect(JSON.parse(stored?.software_versions_json ?? "{}")).toEqual({});
    expect(stored?.signals).toEqual([]);
  });
});

test("recordExecutionProfile stores optional variant, host model, and metadata", () => {
  withTestDatabase((connection, projectId) => {
    const taskId = createTaskWithProfile(connection, projectId);

    const result = recordExecutionProfile(
      connection,
      executionInput({
        taskId,
        variant: "thinking",
        hostProvider: "openai",
        hostModel: "gpt-4.1",
        hostVariant: "thinking",
        toolProfile: { tools: ["bash", "edit"] },
        softwareVersions: { opencode: "1.18.27" },
        providerErrorKind: "APIError",
        providerErrorCode: "429",
      }),
    );

    const stored = getExecutionProfile(connection, result.executionId);
    expect(stored?.variant).toBe("thinking");
    expect(stored?.host_provider).toBe("openai");
    expect(stored?.host_model).toBe("gpt-4.1");
    expect(stored?.host_variant).toBe("thinking");
    expect(JSON.parse(stored?.tool_profile_json ?? "{}")).toEqual({ tools: ["bash", "edit"] });
    expect(JSON.parse(stored?.software_versions_json ?? "{}")).toEqual({
      opencode: "1.18.27",
    });
    expect(stored?.provider_error_kind).toBe("APIError");
    expect(stored?.provider_error_code).toBe("429");
  });
});

test("recordExecutionProfile rejects missing task and task without active profile", () => {
  withTestDatabase((connection, projectId) => {
    expect(() =>
      recordExecutionProfile(connection, executionInput({ taskId: "no-such-task" })),
    ).toThrow(TaskPersistenceError);

    const bareTask = createTask(connection, {
      projectId,
      sessionId: "session-2",
      boundary: "top-level",
      now: NOW,
    });
    expect(() =>
      recordExecutionProfile(connection, executionInput({ taskId: bareTask.taskId })),
    ).toThrow(TaskPersistenceError);
  });
});

test("recordExecutionProfile rejects host fields provided without their pair", () => {
  withTestDatabase((connection, projectId) => {
    const taskId = createTaskWithProfile(connection, projectId);

    expect(() =>
      recordExecutionProfile(
        connection,
        executionInput({ taskId, hostProvider: "openai" }),
      ),
    ).toThrow(ExecutionProfileError);
    expect(() =>
      recordExecutionProfile(
        connection,
        executionInput({ taskId, hostModel: "gpt-4.1" }),
      ),
    ).toThrow(ExecutionProfileError);
  });
});

test("recordExecutionProfile rejects negative latency", () => {
  withTestDatabase((connection, projectId) => {
    const taskId = createTaskWithProfile(connection, projectId);

    expect(() =>
      recordExecutionProfile(connection, executionInput({ taskId, latencyMs: -1 })),
    ).toThrow(ExecutionProfileError);
  });
});

test("recordOutcomeSignal stores a signal linked to the execution", () => {
  withTestDatabase((connection, projectId) => {
    const taskId = createTaskWithProfile(connection, projectId);
    const execution = recordExecutionProfile(connection, executionInput({ taskId }));

    const result = recordOutcomeSignal(connection, {
      taskId,
      executionId: execution.executionId,
      dimension: "cost",
      kind: "assistant-cost",
      source: "assistant-message",
      confidence: 1,
      value: 0.01,
      metadata: { finishState: "stop" },
      observedAt: NOW,
      now: NOW,
    });

    const stored = getExecutionProfile(connection, execution.executionId);
    expect(stored?.signals).toHaveLength(1);
    expect(stored?.signals[0]?.id).toBe(result.signalId);
    expect(stored?.signals[0]?.dimension).toBe("cost");
    expect(stored?.signals[0]?.kind).toBe("assistant-cost");
    expect(stored?.signals[0]?.value).toBe(0.01);
    expect(stored?.signals[0]?.confidence).toBe(1);
    expect(JSON.parse(stored?.signals[0]?.metadata_json ?? "{}")).toEqual({
      finishState: "stop",
    });
  });
});

test("recordOutcomeSignal rejects lesson fields provided without their pair", () => {
  withTestDatabase((connection, projectId) => {
    const taskId = createTaskWithProfile(connection, projectId);

    expect(() =>
      recordOutcomeSignal(connection, {
        taskId,
        dimension: "quality",
        kind: "correction",
        source: "explicit-feedback",
        confidence: 1,
        value: -1,
        lessonId: "lesson-1",
        now: NOW,
      }),
    ).toThrow(ExecutionProfileError);
  });
});

test("recordExecutionProfile signals cascade when the task is deleted", () => {
  withTestDatabase((connection, projectId) => {
    const taskId = createTaskWithProfile(connection, projectId);
    const execution = recordExecutionProfile(connection, executionInput({ taskId }));
    recordOutcomeSignal(connection, {
      taskId,
      executionId: execution.executionId,
      dimension: "latency",
      kind: "assistant-latency",
      source: "assistant-message",
      confidence: 1,
      value: 5000,
      now: NOW,
    });

    connection.database.run("DELETE FROM tasks WHERE id = ?", [taskId]);

    expect(getExecutionProfile(connection, execution.executionId)).toBeNull();
    const signalCount = connection.database
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM outcome_signals")
      .get();
    expect(signalCount?.count).toBe(0);
  });
});
