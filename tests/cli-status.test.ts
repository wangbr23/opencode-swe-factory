import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  migrateSqliteSchema,
  openSqliteConnection,
  releaseSchemaMigrations,
} from "../src/core/index.js";
import { main } from "../src/cli/index.js";

function withTestDir(run: (dir: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-cli-status-"));
  try {
    run(directory);
  } finally {
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

test("status shows paths and health with existing database", () => {
  withTestDir((dir) => {
    const dbPath = join(dir, "memory.sqlite");
    const connection = openSqliteConnection(dbPath);
    migrateSqliteSchema(connection, releaseSchemaMigrations);
    connection.close();

    const console_ = captureConsole();
    try {
      const code = main(["status", "--database", dbPath]);
      expect(code).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain("Database:");
      expect(output).toContain(dbPath);
      expect(output).toContain("Status: exists");
      expect(output).toContain("Migrations: up to date");
      expect(output).toContain("Health: healthy");
    } finally {
      console_.restore();
    }
  });
});

test("status handles non-existent database", () => {
  withTestDir((dir) => {
    const dbPath = join(dir, "nonexistent.sqlite");

    const console_ = captureConsole();
    try {
      const code = main(["status", "--database", dbPath]);
      expect(code).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain("Status: not created yet");
      expect(output).toContain("Health: healthy");
    } finally {
      console_.restore();
    }
  });
});

test("status shows OpenCode compatibility manifest", () => {
  withTestDir((dir) => {
    const dbPath = join(dir, "nonexistent.sqlite");

    const console_ = captureConsole();
    try {
      expect(main(["status", "--database", dbPath])).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain("OpenCode compatibility:");
      expect(output).toContain("Minimum version: 1.18.27");
      expect(output).toContain("Tested versions: 1.18.27");
    } finally {
      console_.restore();
    }
  });
});

test("status shows paths section", () => {
  withTestDir((dir) => {
    const dbPath = join(dir, "memory.sqlite");

    const console_ = captureConsole();
    try {
      expect(main(["status", "--database", dbPath])).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain("Paths:");
      expect(output).toContain("Config:");
      expect(output).toContain("Data:");
      expect(output).toContain("Cache:");
      expect(output).toContain("Backups:");
    } finally {
      console_.restore();
    }
  });
});

test("status shows no diagnostics when none recorded", () => {
  withTestDir((dir) => {
    const dbPath = join(dir, "nonexistent.sqlite");

    const console_ = captureConsole();
    try {
      expect(main(["status", "--database", dbPath])).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain("No diagnostics recorded.");
    } finally {
      console_.restore();
    }
  });
});

test("status shows database component in health checks", () => {
  withTestDir((dir) => {
    const dbPath = join(dir, "memory.sqlite");
    const connection = openSqliteConnection(dbPath);
    migrateSqliteSchema(connection, releaseSchemaMigrations);
    connection.close();

    const console_ = captureConsole();
    try {
      expect(main(["status", "--database", dbPath])).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain("database: healthy");
    } finally {
      console_.restore();
    }
  });
});
