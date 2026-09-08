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

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

async function withTestDir(run: (dir: string) => void | Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-cli-status-"));
  // Isolate managed path resolution. darwin bases paths on homedir(), which
  // Bun's os.homedir() does not derive from $HOME, so the explicit data-dir
  // override is what actually isolates diagnostics and backups.
  const previous = {
    dataDir: process.env.OPENCODE_SWE_FACTORY_DATA_DIR,
    home: process.env.HOME,
    data: process.env.XDG_DATA_HOME,
    cache: process.env.XDG_CACHE_HOME,
    config: process.env.XDG_CONFIG_HOME,
  };
  process.env.OPENCODE_SWE_FACTORY_DATA_DIR = join(directory, "data");
  setEnv("HOME", directory);
  setEnv("XDG_DATA_HOME", directory);
  setEnv("XDG_CACHE_HOME", directory);
  setEnv("XDG_CONFIG_HOME", directory);
  try {
    await run(directory);
  } finally {
    setEnv("OPENCODE_SWE_FACTORY_DATA_DIR", previous.dataDir);
    setEnv("HOME", previous.home);
    setEnv("XDG_DATA_HOME", previous.data);
    setEnv("XDG_CACHE_HOME", previous.cache);
    setEnv("XDG_CONFIG_HOME", previous.config);
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

test("status shows paths and health with existing database", async () => {
  await withTestDir(async (dir) => {
    const dbPath = join(dir, "memory.sqlite");
    const connection = openSqliteConnection(dbPath);
    migrateSqliteSchema(connection, releaseSchemaMigrations);
    connection.close();

    const console_ = captureConsole();
    try {
      const code = await main(["status", "--database", dbPath]);
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

test("status handles non-existent database", async () => {
  await withTestDir(async (dir) => {
    const dbPath = join(dir, "nonexistent.sqlite");

    const console_ = captureConsole();
    try {
      const code = await main(["status", "--database", dbPath]);
      expect(code).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain("Status: not created yet");
      expect(output).toContain("Health: healthy");
    } finally {
      console_.restore();
    }
  });
});

test("status shows OpenCode compatibility manifest", async () => {
  await withTestDir(async (dir) => {
    const dbPath = join(dir, "nonexistent.sqlite");

    const console_ = captureConsole();
    try {
      expect(await main(["status", "--database", dbPath])).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain("OpenCode compatibility:");
      expect(output).toContain("Minimum version: 1.18.27");
      expect(output).toContain("Tested versions: 1.18.27");
    } finally {
      console_.restore();
    }
  });
});

test("status shows paths section", async () => {
  await withTestDir(async (dir) => {
    const dbPath = join(dir, "memory.sqlite");

    const console_ = captureConsole();
    try {
      expect(await main(["status", "--database", dbPath])).toBe(0);
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

test("status shows no diagnostics when none recorded", async () => {
  await withTestDir(async (dir) => {
    const dbPath = join(dir, "nonexistent.sqlite");

    const console_ = captureConsole();
    try {
      expect(await main(["status", "--database", dbPath])).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain("No diagnostics recorded.");
    } finally {
      console_.restore();
    }
  });
});

test("status shows database component in health checks", async () => {
  await withTestDir(async (dir) => {
    const dbPath = join(dir, "memory.sqlite");
    const connection = openSqliteConnection(dbPath);
    migrateSqliteSchema(connection, releaseSchemaMigrations);
    connection.close();

    const console_ = captureConsole();
    try {
      expect(await main(["status", "--database", dbPath])).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain("database: healthy");
    } finally {
      console_.restore();
    }
  });
});
