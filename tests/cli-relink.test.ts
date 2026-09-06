import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  migrateSqliteSchema,
  openSqliteConnection,
  releaseSchemaMigrations,
  resolveProjectIdentity,
  type SqliteConnection,
} from "../src/core/index.js";
import { main } from "../src/cli/index.js";

function withTestDatabase(run: (dbPath: string, connection: SqliteConnection) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-cli-relink-"));
  const dbPath = join(directory, "memory.sqlite");
  const connection = openSqliteConnection(dbPath);
  migrateSqliteSchema(connection, releaseSchemaMigrations);
  try {
    run(dbPath, connection);
  } finally {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
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

test("relink updates a project path", () => {
  withTestDatabase((dbPath, connection) => {
    const { project } = resolveProjectIdentity(connection, {
      projectPath: "/repos/my-project",
    });
    connection.close();

    const console_ = captureConsole();
    try {
      const code = main(["relink", project.id, "--path", "/repos/new-location", "--database", dbPath]);
      expect(code).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain("/repos/my-project -> /repos/new-location");
      expect(output).toContain(`Relinked project ${project.id}`);
    } finally {
      console_.restore();
    }
  });
});

test("relink updates a project remote", () => {
  withTestDatabase((dbPath, connection) => {
    const { project } = resolveProjectIdentity(connection, {
      projectPath: "/repos/my-project",
      remoteUrl: "git@github.com:owner/repo.git",
    });
    connection.close();

    const console_ = captureConsole();
    try {
      const code = main(["relink", project.id, "--remote", "git@github.com:owner/new-repo.git", "--database", dbPath]);
      expect(code).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain("Remote hash:");
      expect(output).toContain(`Relinked project ${project.id}`);
    } finally {
      console_.restore();
    }
  });
});

test("relink updates both path and remote", () => {
  withTestDatabase((dbPath, connection) => {
    const { project } = resolveProjectIdentity(connection, {
      projectPath: "/repos/old-project",
      remoteUrl: "git@github.com:owner/old-repo.git",
    });
    connection.close();

    const console_ = captureConsole();
    try {
      const code = main([
        "relink", project.id,
        "--path", "/repos/new-project",
        "--remote", "git@github.com:owner/new-repo.git",
        "--database", dbPath,
      ]);
      expect(code).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain("Path:");
      expect(output).toContain("Remote hash:");
      expect(output).toContain(`Relinked project ${project.id}`);
    } finally {
      console_.restore();
    }
  });
});

test("relink fails without project id", () => {
  withTestDatabase((dbPath, connection) => {
    connection.close();

    const console_ = captureConsole();
    try {
      const code = main(["relink", "--path", "/repos/new", "--database", dbPath]);
      expect(code).toBe(1);
      expect(console_.errors.join("\n")).toContain("Usage: relink");
    } finally {
      console_.restore();
    }
  });
});

test("relink fails without --path or --remote", () => {
  withTestDatabase((dbPath, connection) => {
    const { project } = resolveProjectIdentity(connection, {
      projectPath: "/repos/my-project",
    });
    connection.close();

    const console_ = captureConsole();
    try {
      const code = main(["relink", project.id, "--database", dbPath]);
      expect(code).toBe(1);
      expect(console_.errors.join("\n")).toContain("--path or --remote is required");
    } finally {
      console_.restore();
    }
  });
});

test("relink fails for nonexistent project", () => {
  withTestDatabase((dbPath, connection) => {
    connection.close();

    const console_ = captureConsole();
    try {
      const code = main(["relink", "nonexistent-id", "--path", "/repos/new", "--database", dbPath]);
      expect(code).toBe(1);
      expect(console_.errors.join("\n")).toContain("not found");
    } finally {
      console_.restore();
    }
  });
});

test("relink fails when path is used by another project", () => {
  withTestDatabase((dbPath, connection) => {
    const { project: project1 } = resolveProjectIdentity(connection, {
      projectPath: "/repos/project-one",
    });
    resolveProjectIdentity(connection, {
      projectPath: "/repos/project-two",
    });
    connection.close();

    const console_ = captureConsole();
    try {
      const code = main(["relink", project1.id, "--path", "/repos/project-two", "--database", dbPath]);
      expect(code).toBe(1);
      expect(console_.errors.join("\n")).toContain("already used");
    } finally {
      console_.restore();
    }
  });
});

test("relink to same path is a no-op", () => {
  withTestDatabase((dbPath, connection) => {
    const { project } = resolveProjectIdentity(connection, {
      projectPath: "/repos/my-project",
    });
    connection.close();

    const console_ = captureConsole();
    try {
      const code = main(["relink", project.id, "--path", "/repos/my-project", "--database", dbPath]);
      expect(code).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain(`Relinked project ${project.id}`);
      expect(output).not.toContain("->");
    } finally {
      console_.restore();
    }
  });
});
