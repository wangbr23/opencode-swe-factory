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
  releaseSchemaMigrations,
  resolveProjectIdentity,
  type SqliteConnection,
} from "../src/core/index.js";

const NOW = new Date("2026-09-06T12:00:00.000Z");

function withTestDatabase(run: (databasePath: string, connection: SqliteConnection) => void | Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-cli-task-"));
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

function createTaskWithProfile(connection: SqliteConnection): string {
  const { project } = resolveProjectIdentity(connection, { projectPath: "/repos/test-project" });
  const task = createTask(connection, {
    projectId: project.id,
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
      summary: "Add a feature module.",
    },
    now: NOW,
  });
  return task.taskId;
}

test("task inspects a task with its active profile", async () => {
  await withTestDatabase(async (databasePath, connection) => {
    const taskId = createTaskWithProfile(connection);
    connection.close();

    const console_ = captureConsole();
    try {
      expect(await main(["task", taskId, "--database", databasePath])).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain(`Task ${taskId}`);
      expect(output).toContain("Boundary:  top-level");
      expect(output).toContain("Completed: not completed");
      expect(output).toContain("Active profile (v1, inferred)");
      expect(output).toContain("Activity:    implement");
      expect(output).toContain("Domain:      backend");
      expect(output).toContain("Complexity:  medium");
      expect(output).toContain("Risk:        low");
      expect(output).toContain("Stack:       typescript");
      expect(output).toContain("Signals:     activity-lexical");
      expect(output).toContain("Summary:     Add a feature module.");
    } finally {
      console_.restore();
    }
  });
});

test("task corrects profile fields and creates a new version", async () => {
  await withTestDatabase(async (databasePath, connection) => {
    const taskId = createTaskWithProfile(connection);
    connection.close();

    const console_ = captureConsole();
    try {
      expect(
        await main([
          "task",
          taskId,
          "--activity",
          "fix",
          "--complexity",
          "high",
          "--risk",
          "high",
          "--stack",
          "bun, sqlite",
          "--database",
          databasePath,
        ]),
      ).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain("Activity: implement -> fix");
      expect(output).toContain("Complexity: medium -> high");
      expect(output).toContain("Risk: low -> high");
      expect(output).toContain("Stack: typescript -> bun, sqlite");
      expect(output).toContain("Active profile version is now v2.");
      expect(output).not.toContain("Domain:");
    } finally {
      console_.restore();
    }

    const verify = captureConsole();
    try {
      expect(await main(["task", taskId, "--database", databasePath])).toBe(0);
      const output = verify.logged.join("\n");
      expect(output).toContain("Active profile (v2, corrected)");
      expect(output).toContain("Activity:    fix");
      expect(output).toContain("Stack:       bun, sqlite");
      expect(output).toContain("Supersedes:  v1");
      expect(output).toContain("Domain:      backend");
    } finally {
      verify.restore();
    }
  });
});

test("task clears activity and domain with none", async () => {
  await withTestDatabase(async (databasePath, connection) => {
    const taskId = createTaskWithProfile(connection);
    connection.close();

    const console_ = captureConsole();
    try {
      expect(await main(["task", taskId, "--activity", "none", "--domain", "none", "--database", databasePath])).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain("Activity: implement -> (none)");
      expect(output).toContain("Domain: backend -> (none)");
    } finally {
      console_.restore();
    }

    const verify = captureConsole();
    try {
      expect(await main(["task", taskId, "--database", databasePath])).toBe(0);
      const output = verify.logged.join("\n");
      expect(output).toContain("Activity:    (none)");
      expect(output).toContain("Domain:      (none)");
    } finally {
      verify.restore();
    }
  });
});

test("task shows message when there is no active profile", async () => {
  await withTestDatabase(async (databasePath, connection) => {
    const { project } = resolveProjectIdentity(connection, { projectPath: "/repos/bare-project" });
    const task = createTask(connection, {
      projectId: project.id,
      sessionId: "session-1",
      boundary: "top-level",
      now: NOW,
    });
    connection.close();

    const console_ = captureConsole();
    try {
      expect(await main(["task", task.taskId, "--database", databasePath])).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain("No active profile.");
    } finally {
      console_.restore();
    }
  });
});

test("task correction fails for a task without a profile", async () => {
  await withTestDatabase(async (databasePath, connection) => {
    const { project } = resolveProjectIdentity(connection, { projectPath: "/repos/bare-project" });
    const task = createTask(connection, {
      projectId: project.id,
      sessionId: "session-1",
      boundary: "top-level",
      now: NOW,
    });
    connection.close();

    const console_ = captureConsole();
    try {
      expect(await main(["task", task.taskId, "--complexity", "high", "--database", databasePath])).toBe(1);
      expect(console_.errors.join("\n")).toContain("no active profile to correct");
    } finally {
      console_.restore();
    }
  });
});

test("task fails for nonexistent ID", async () => {
  await withTestDatabase(async (databasePath, connection) => {
    connection.close();

    const console_ = captureConsole();
    try {
      expect(await main(["task", "nonexistent-task", "--database", databasePath])).toBe(1);
      expect(console_.errors.join("\n")).toContain("not found");
    } finally {
      console_.restore();
    }
  });
});

test("task fails without ID argument", async () => {
  await withTestDatabase(async (databasePath, connection) => {
    connection.close();

    const console_ = captureConsole();
    try {
      expect(await main(["task", "--database", databasePath])).toBe(1);
      expect(console_.errors.join("\n")).toContain("Usage: task <task-id>");
    } finally {
      console_.restore();
    }
  });
});

test("task rejects invalid correction values", async () => {
  await withTestDatabase(async (databasePath, connection) => {
    const taskId = createTaskWithProfile(connection);
    connection.close();

    const console_ = captureConsole();
    try {
      expect(await main(["task", taskId, "--activity", "hacking", "--database", databasePath])).toBe(1);
      const output = console_.errors.join("\n");
      expect(output).toContain('Invalid --activity value "hacking"');
      expect(output).toContain("implement, fix");
    } finally {
      console_.restore();
    }
  });
});
