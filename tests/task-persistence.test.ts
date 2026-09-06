import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  completeTask,
  correctTaskProfile,
  createTask,
  getTaskWithProfile,
  migrateSqliteSchema,
  openSqliteConnection,
  persistTaskProfile,
  releaseSchemaMigrations,
  resolveProjectIdentity,
  TaskPersistenceError,
  type SqliteConnection,
} from "../src/core/index.js";

const NOW = new Date("2026-09-05T12:00:00.000Z");

function withTestDatabase(run: (connection: SqliteConnection, projectId: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-task-persistence-"));
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

const SAMPLE_PROFILE = {
  taxonomyVersion: 1,
  activity: "implement" as const,
  domain: "backend" as const,
  complexity: "medium" as const,
  risk: "low" as const,
  stack: ["typescript", "bun"],
  signals: ["activity-lexical" as const, "stack-lexical" as const],
  summary: "Add the task persistence module.",
};

test("createTask creates a top-level task", () => {
  withTestDatabase((connection, projectId) => {
    const result = createTask(connection, {
      projectId,
      sessionId: "session-1",
      boundary: "top-level",
      now: NOW,
    });

    expect(result.taskId).toBeTruthy();
    expect(result.boundary).toBe("top-level");
    expect(result.createdAt).toBe(NOW.toISOString());
  });
});

test("createTask creates a subtask with parent", () => {
  withTestDatabase((connection, projectId) => {
    const parent = createTask(connection, {
      projectId,
      sessionId: "session-1",
      boundary: "top-level",
      now: NOW,
    });
    const child = createTask(connection, {
      projectId,
      sessionId: "session-1",
      boundary: "subtask",
      parentTaskId: parent.taskId,
      now: NOW,
    });

    expect(child.boundary).toBe("subtask");
    const loaded = getTaskWithProfile(connection, child.taskId);
    expect(loaded).not.toBeNull();
    expect(loaded!.parentTaskId).toBe(parent.taskId);
  });
});

test("createTask with hostTaskId is persisted", () => {
  withTestDatabase((connection, projectId) => {
    const result = createTask(connection, {
      projectId,
      sessionId: "session-1",
      boundary: "top-level",
      hostTaskId: "host-task-42",
      now: NOW,
    });

    const loaded = getTaskWithProfile(connection, result.taskId);
    expect(loaded!.hostTaskId).toBe("host-task-42");
  });
});

test("persistTaskProfile stores inferred profile and sets active version", () => {
  withTestDatabase((connection, projectId) => {
    const task = createTask(connection, {
      projectId,
      sessionId: "session-1",
      boundary: "top-level",
      now: NOW,
    });
    const result = persistTaskProfile(connection, {
      taskId: task.taskId,
      profile: SAMPLE_PROFILE,
      now: NOW,
    });

    expect(result.version).toBe(1);
    expect(result.source).toBe("inferred");

    const loaded = getTaskWithProfile(connection, task.taskId);
    expect(loaded!.activeProfileVersion).toBe(1);
    expect(loaded!.activeProfile).not.toBeNull();
    expect(loaded!.activeProfile!.activity).toBe("implement");
    expect(loaded!.activeProfile!.domain).toBe("backend");
    expect(loaded!.activeProfile!.complexity).toBe("medium");
    expect(loaded!.activeProfile!.risk).toBe("low");
    expect(loaded!.activeProfile!.stack).toEqual(["typescript", "bun"]);
    expect(loaded!.activeProfile!.signals).toEqual(["activity-lexical", "stack-lexical"]);
    expect(loaded!.activeProfile!.summary).toBe("Add the task persistence module.");
    expect(loaded!.activeProfile!.source).toBe("inferred");
    expect(loaded!.activeProfile!.supersededVersion).toBeNull();
  });
});

test("correctTaskProfile applies corrections and creates new version", () => {
  withTestDatabase((connection, projectId) => {
    const task = createTask(connection, {
      projectId,
      sessionId: "session-1",
      boundary: "top-level",
      now: NOW,
    });
    persistTaskProfile(connection, { taskId: task.taskId, profile: SAMPLE_PROFILE, now: NOW });
    const correction = correctTaskProfile(connection, {
      taskId: task.taskId,
      corrections: { activity: "fix", complexity: "high" },
      now: NOW,
    });

    expect(correction.version).toBe(2);
    expect(correction.supersededVersion).toBe(1);
    expect(correction.source).toBe("corrected");

    const loaded = getTaskWithProfile(connection, task.taskId);
    expect(loaded!.activeProfileVersion).toBe(2);
    expect(loaded!.activeProfile!.activity).toBe("fix");
    expect(loaded!.activeProfile!.complexity).toBe("high");
    expect(loaded!.activeProfile!.source).toBe("corrected");
    expect(loaded!.activeProfile!.supersededVersion).toBe(1);
  });
});

test("correctTaskProfile preserves uncorrected fields", () => {
  withTestDatabase((connection, projectId) => {
    const task = createTask(connection, {
      projectId,
      sessionId: "session-1",
      boundary: "top-level",
      now: NOW,
    });
    persistTaskProfile(connection, { taskId: task.taskId, profile: SAMPLE_PROFILE, now: NOW });
    correctTaskProfile(connection, {
      taskId: task.taskId,
      corrections: { risk: "high" },
      now: NOW,
    });

    const loaded = getTaskWithProfile(connection, task.taskId);
    expect(loaded!.activeProfile!.activity).toBe("implement");
    expect(loaded!.activeProfile!.domain).toBe("backend");
    expect(loaded!.activeProfile!.complexity).toBe("medium");
    expect(loaded!.activeProfile!.risk).toBe("high");
    expect(loaded!.activeProfile!.stack).toEqual(["typescript", "bun"]);
    expect(loaded!.activeProfile!.summary).toBe("Add the task persistence module.");
  });
});

test("correctTaskProfile can set activity to null", () => {
  withTestDatabase((connection, projectId) => {
    const task = createTask(connection, {
      projectId,
      sessionId: "session-1",
      boundary: "top-level",
      now: NOW,
    });
    persistTaskProfile(connection, { taskId: task.taskId, profile: SAMPLE_PROFILE, now: NOW });
    correctTaskProfile(connection, {
      taskId: task.taskId,
      corrections: { activity: null },
      now: NOW,
    });

    const loaded = getTaskWithProfile(connection, task.taskId);
    expect(loaded!.activeProfile!.activity).toBeNull();
  });
});

test("correctTaskProfile fails without active profile", () => {
  withTestDatabase((connection, projectId) => {
    const task = createTask(connection, {
      projectId,
      sessionId: "session-1",
      boundary: "top-level",
      now: NOW,
    });

    expect(() =>
      correctTaskProfile(connection, {
        taskId: task.taskId,
        corrections: { activity: "fix" },
        now: NOW,
      }),
    ).toThrow(TaskPersistenceError);
  });
});

test("correctTaskProfile fails for nonexistent task", () => {
  withTestDatabase((connection) => {
    expect(() =>
      correctTaskProfile(connection, {
        taskId: "nonexistent",
        corrections: { activity: "fix" },
        now: NOW,
      }),
    ).toThrow("not found");
  });
});

test("multiple sequential corrections create version chain", () => {
  withTestDatabase((connection, projectId) => {
    const task = createTask(connection, {
      projectId,
      sessionId: "session-1",
      boundary: "top-level",
      now: NOW,
    });
    persistTaskProfile(connection, { taskId: task.taskId, profile: SAMPLE_PROFILE, now: NOW });
    const c1 = correctTaskProfile(connection, {
      taskId: task.taskId,
      corrections: { activity: "fix" },
      now: NOW,
    });
    const c2 = correctTaskProfile(connection, {
      taskId: task.taskId,
      corrections: { domain: "security" },
      now: NOW,
    });

    expect(c1.version).toBe(2);
    expect(c1.supersededVersion).toBe(1);
    expect(c2.version).toBe(3);
    expect(c2.supersededVersion).toBe(2);

    const loaded = getTaskWithProfile(connection, task.taskId);
    expect(loaded!.activeProfileVersion).toBe(3);
    expect(loaded!.activeProfile!.activity).toBe("fix");
    expect(loaded!.activeProfile!.domain).toBe("security");
  });
});

test("completeTask sets completed_at", () => {
  withTestDatabase((connection, projectId) => {
    const task = createTask(connection, {
      projectId,
      sessionId: "session-1",
      boundary: "top-level",
      now: NOW,
    });

    const before = getTaskWithProfile(connection, task.taskId);
    expect(before!.completedAt).toBeNull();

    completeTask(connection, { taskId: task.taskId, now: NOW });

    const after = getTaskWithProfile(connection, task.taskId);
    expect(after!.completedAt).toBe(NOW.toISOString());
  });
});

test("completeTask is idempotent", () => {
  withTestDatabase((connection, projectId) => {
    const task = createTask(connection, {
      projectId,
      sessionId: "session-1",
      boundary: "top-level",
      now: NOW,
    });
    completeTask(connection, { taskId: task.taskId, now: NOW });
    const laterTime = new Date("2026-09-05T13:00:00.000Z");
    completeTask(connection, { taskId: task.taskId, now: laterTime });

    const loaded = getTaskWithProfile(connection, task.taskId);
    expect(loaded!.completedAt).toBe(NOW.toISOString());
  });
});

test("completeTask fails for nonexistent task", () => {
  withTestDatabase((connection) => {
    expect(() =>
      completeTask(connection, { taskId: "nonexistent", now: NOW }),
    ).toThrow("not found");
  });
});

test("getTaskWithProfile returns null for nonexistent task", () => {
  withTestDatabase((connection) => {
    const result = getTaskWithProfile(connection, "nonexistent");
    expect(result).toBeNull();
  });
});

test("getTaskWithProfile returns task without profile when none persisted", () => {
  withTestDatabase((connection, projectId) => {
    const task = createTask(connection, {
      projectId,
      sessionId: "session-1",
      boundary: "top-level",
      now: NOW,
    });

    const loaded = getTaskWithProfile(connection, task.taskId);
    expect(loaded).not.toBeNull();
    expect(loaded!.activeProfileVersion).toBeNull();
    expect(loaded!.activeProfile).toBeNull();
    expect(loaded!.projectId).toBe(projectId);
    expect(loaded!.sessionId).toBe("session-1");
  });
});

test("correctTaskProfile with stack correction replaces stack array", () => {
  withTestDatabase((connection, projectId) => {
    const task = createTask(connection, {
      projectId,
      sessionId: "session-1",
      boundary: "top-level",
      now: NOW,
    });
    persistTaskProfile(connection, { taskId: task.taskId, profile: SAMPLE_PROFILE, now: NOW });
    correctTaskProfile(connection, {
      taskId: task.taskId,
      corrections: { stack: ["python", "django"] },
      now: NOW,
    });

    const loaded = getTaskWithProfile(connection, task.taskId);
    expect(loaded!.activeProfile!.stack).toEqual(["python", "django"]);
  });
});
