import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../src/cli/index.js";
import {
  createBackupSnapshot,
  HARD_DELETE_CONFIRMATION_PHRASE,
  migrateSqliteSchema,
  openSqliteConnection,
  proposeLessonCandidate,
  releaseSchemaMigrations,
  reviewLessonCandidate,
  type SecretScanResult,
  type SqliteConnection,
} from "../src/core/index.js";

const clearScan: SecretScanResult = {
  disposition: "clear",
  findings: [],
  redactedText: "",
};

async function withTestDatabase(
  run: (directory: string, databasePath: string, connection: SqliteConnection) => void | Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-cli-hard-delete-"));
  const databasePath = join(directory, "memory.sqlite");
  const connection = openSqliteConnection(databasePath);
  migrateSqliteSchema(connection, releaseSchemaMigrations);
  try {
    await run(directory, databasePath, connection);
  } finally {
    if (!connection.isClosed) {
      connection.close();
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

function captureConsole() {
  const logged: string[] = [];
  const log = spyOn(console, "log").mockImplementation((message: string) => {
    logged.push(message);
  });
  return {
    logged,
    restore() {
      log.mockRestore();
    },
  };
}

function seedLesson(connection: SqliteConnection): void {
  const candidate = proposeLessonCandidate(connection, {
    projectId: null,
    scope: "global",
    draft: {
      title: "Run tests before commits",
      body: "Always run bun test before committing changes",
      rationale: "User corrected a commit without tests.",
      applicability: {},
      provenance: {},
    },
    secretScan: clearScan,
    reviewWindowDays: 36500,
  });
  reviewLessonCandidate(connection, { candidateId: candidate.id, decision: "approve" });
}

function lessonCount(databasePath: string): number {
  const connection = openSqliteConnection(databasePath);
  try {
    return connection.database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM lessons").get()!.count;
  } finally {
    connection.close();
  }
}

test("hard-delete aborts without the confirmation phrase and leaves data and backups intact", async () => {
  await withTestDatabase(async (directory, databasePath, connection) => {
    seedLesson(connection);
    const backupDirectory = join(directory, "backups");
    createBackupSnapshot(connection, { backupDirectory });
    connection.close();

    const console_ = captureConsole();
    try {
      expect(await main(["hard-delete", "--database", databasePath, "--backup-dir", backupDirectory], { readLine: () => "no" })).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain("WARNING");
      expect(output).toContain("historical recovery points will be lost");
      expect(output).toContain("Aborted. Nothing was deleted.");
    } finally {
      console_.restore();
    }

    expect(lessonCount(databasePath)).toBe(1);
    expect(readdirSync(backupDirectory)).toHaveLength(1);
  });
});

test("hard-delete aborts when stdin closes without confirmation", async () => {
  await withTestDatabase(async (_directory, databasePath, connection) => {
    seedLesson(connection);
    connection.close();

    const console_ = captureConsole();
    try {
      expect(await main(["hard-delete", "--database", databasePath], { readLine: () => null })).toBe(0);
      expect(console_.logged.join("\n")).toContain("Aborted. Nothing was deleted.");
    } finally {
      console_.restore();
    }

    expect(lessonCount(databasePath)).toBe(1);
  });
});

test("hard-delete removes all data and purges managed backups after confirmation", async () => {
  await withTestDatabase(async (directory, databasePath, connection) => {
    seedLesson(connection);
    const backupDirectory = join(directory, "backups");
    createBackupSnapshot(connection, { backupDirectory });
    connection.close();

    const console_ = captureConsole();
    try {
      const code = await main(["hard-delete", "--database", databasePath, "--backup-dir", backupDirectory], {
        readLine: () => HARD_DELETE_CONFIRMATION_PHRASE,
      });
      expect(code).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain("cannot retract exports or copies");
      expect(output).toContain("Purged 1 managed backup(s).");
      expect(output).toContain("Created clean baseline backup");
    } finally {
      console_.restore();
    }

    expect(lessonCount(databasePath)).toBe(0);
    expect(readdirSync(backupDirectory)).toHaveLength(1);
    expect(existsSync(join(backupDirectory, readdirSync(backupDirectory)[0]!))).toBe(true);
  });
});
