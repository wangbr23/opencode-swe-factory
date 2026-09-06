import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../src/cli/index.js";
import { createBackupSnapshot, openSqliteConnection } from "../src/core/index.js";

async function withTemporaryDirectory(run: (directory: string) => void | Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-cli-backup-"));
  try {
    await run(directory);
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

test("backup command creates a snapshot and backup-status reports it", async () => {
  await withTemporaryDirectory(async (directory) => {
    const databasePath = join(directory, "memory.sqlite");
    const backupDirectory = join(directory, "backups");
    const configFilePath = join(directory, "config.json");
    writeFileSync(configFilePath, JSON.stringify({ backups: { retention: { maxBackups: 5 } } }));

    const connection = openSqliteConnection(databasePath);
    connection.database.run("CREATE TABLE notes (body TEXT NOT NULL)");
    connection.close();

    const console_ = captureConsole();
    try {
      expect(await main(["backup", "--database", databasePath, "--backup-dir", backupDirectory, "--config", configFilePath])).toBe(0);
      expect(console_.logged.join("\n")).toMatch(/Created backup .*backups.*\.sqlite/);
      expect(readdirSync(backupDirectory)).toHaveLength(1);

      const statusOutput = await (async () => {
        console_.logged.length = 0;
        expect(
          await main(["backup-status", "--backup-dir", backupDirectory, "--config", configFilePath]),
        ).toBe(0);
        return console_.logged.join("\n");
      })();

      expect(statusOutput).toContain("Backups enabled: no");
      expect(statusOutput).toContain("Snapshots (1):");
      expect(statusOutput).toMatch(/Latest backup: \d{4}-\d{2}-\d{2}T/);
      expect(statusOutput).toMatch(/\(\d+ bytes\)/);
    } finally {
      console_.restore();
    }
  });
});

test("backup-status reports no snapshots for an empty backup directory", async () => {
  await withTemporaryDirectory(async (directory) => {
    const configFilePath = join(directory, "config.json");
    writeFileSync(configFilePath, "{}");
    const backupDirectory = join(directory, "backups");
    mkdirSync(backupDirectory);

    const console_ = captureConsole();
    try {
      expect(await main(["backup-status", "--backup-dir", backupDirectory, "--config", configFilePath])).toBe(0);
      const statusOutput = console_.logged.join("\n");
      expect(statusOutput).toContain("Latest backup: none");
      expect(statusOutput).toContain("Next due: now");
      expect(statusOutput).toContain("Snapshots (0):");
    } finally {
      console_.restore();
    }
  });
});

test("backup command fails cleanly for unknown options and unknown commands", async () => {
  await withTemporaryDirectory(async (directory) => {
    const console_ = captureConsole();
    try {
      expect(await main(["backup", "--nope", join(directory, "backups")])).toBe(1);
      expect(console_.errors.join("\n")).toContain("Command failed");

      console_.errors.length = 0;
      expect(await main(["frobnicate"])).toBe(1);
      expect(console_.errors.join("\n")).toContain("Unknown command: frobnicate.");
    } finally {
      console_.restore();
    }
  });
});
