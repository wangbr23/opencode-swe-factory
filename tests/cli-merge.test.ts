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

async function withTestDatabase(run: (dbPath: string, connection: SqliteConnection) => void | Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-cli-merge-"));
  const dbPath = join(directory, "memory.sqlite");
  const connection = openSqliteConnection(dbPath);
  migrateSqliteSchema(connection, releaseSchemaMigrations);
  try {
    await run(dbPath, connection);
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

test("merge consolidates a duplicate project into the survivor", async () => {
  await withTestDatabase(async (dbPath, connection) => {
    const survivor = resolveProjectIdentity(connection, {
      projectPath: "/repos/primary",
      remoteUrl: "https://github.com/owner/repo.git",
    }).project;
    const absorbed = resolveProjectIdentity(connection, { projectPath: "/repos/duplicate" }).project;
    connection.close();

    const console_ = captureConsole();
    try {
      const code = await main(["merge", survivor.id, absorbed.id, "--database", dbPath]);
      expect(code).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain("Path alias: /repos/duplicate");
      expect(output).toContain(`Merged ${absorbed.id} into ${survivor.id}`);
    } finally {
      console_.restore();
    }

    const verify = openSqliteConnection(dbPath);
    try {
      migrateSqliteSchema(verify, releaseSchemaMigrations);
      expect(
        verify.database.query<{ count: number }, []>("SELECT count(*) AS count FROM projects").get(),
      ).toEqual({ count: 1 });
      expect(resolveProjectIdentity(verify, { projectPath: "/repos/duplicate" }).project.id).toBe(survivor.id);
    } finally {
      verify.close();
    }
  });
});

test("merge fails without two project ids", async () => {
  await withTestDatabase(async (dbPath, connection) => {
    connection.close();

    const console_ = captureConsole();
    try {
      const code = await main(["merge", "only-one-id", "--database", dbPath]);
      expect(code).toBe(1);
      expect(console_.errors.join("\n")).toContain("Usage: merge");
    } finally {
      console_.restore();
    }
  });
});

test("merge fails for unknown projects", async () => {
  await withTestDatabase(async (dbPath, connection) => {
    const { project } = resolveProjectIdentity(connection, { projectPath: "/repos/primary" });
    connection.close();

    const console_ = captureConsole();
    try {
      const code = await main(["merge", project.id, "nonexistent-id", "--database", dbPath]);
      expect(code).toBe(1);
      expect(console_.errors.join("\n")).toContain("not found");
    } finally {
      console_.restore();
    }
  });
});
