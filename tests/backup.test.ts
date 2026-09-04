import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  BackupSnapshotError,
  createBackupSnapshot,
  openSqliteConnection,
} from "../src/core/index.js";

function withTemporaryDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-backup-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("creates an atomic, owner-only snapshot containing committed WAL data", () => {
  withTemporaryDirectory((directory) => {
    const connection = openSqliteConnection(join(directory, "memory.sqlite"));
    const backupDirectory = join(directory, "backups");
    try {
      connection.database.run("PRAGMA wal_autocheckpoint = 0");
      connection.database.run("CREATE TABLE notes (body TEXT NOT NULL)");
      connection.database.run("INSERT INTO notes (body) VALUES ('from the WAL')");

      const snapshot = createBackupSnapshot(connection, { backupDirectory });

      expect(snapshot.backupPath).toMatch(/backup-\d{8}T\d{9}Z-[0-9a-f-]{36}\.sqlite$/);
      expect(snapshot.createdAt).toBe(new Date(snapshot.createdAt).toISOString());
      expect(snapshot.sizeBytes).toBeGreaterThan(0);
      expect(readdirSync(backupDirectory)).toEqual([basename(snapshot.backupPath)]);
      if (process.platform !== "win32") {
        expect(statSync(backupDirectory).mode & 0o777).toBe(0o700);
        expect(statSync(snapshot.backupPath).mode & 0o777).toBe(0o600);
      }

      const backup = new Database(snapshot.backupPath, { readonly: true });
      try {
        expect(backup.query<{ body: string }, []>("SELECT body FROM notes").get()).toEqual({ body: "from the WAL" });
        expect(backup.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      } finally {
        backup.close(true);
      }
    } finally {
      connection.close();
    }
  });
});

test("does not publish a partial snapshot when SQLite backup creation fails", () => {
  withTemporaryDirectory((directory) => {
    const connection = openSqliteConnection(join(directory, "memory.sqlite"));
    const backupDirectory = join(directory, "backups");
    connection.database.run("CREATE TABLE notes (body TEXT NOT NULL)");
    connection.database.run("BEGIN IMMEDIATE");

    try {
      expect(() => createBackupSnapshot(connection, { backupDirectory })).toThrow(BackupSnapshotError);
      expect(readdirSync(backupDirectory)).toEqual([]);
    } finally {
      connection.database.run("ROLLBACK");
      connection.close();
    }
  });
});

test("rejects closed connections and relative backup directories", () => {
  withTemporaryDirectory((directory) => {
    const connection = openSqliteConnection(join(directory, "memory.sqlite"));
    connection.close();

    for (const [backupDirectory, expectedCause] of [
      [join(directory, "backups"), /closed SQLite connection/],
      ["backups", /must be absolute/],
    ] as const) {
      try {
        createBackupSnapshot(connection, { backupDirectory });
        throw new Error("Expected backup creation to fail.");
      } catch (error) {
        if (!(error instanceof BackupSnapshotError) || !(error.cause instanceof Error)) {
          throw error;
        }
        expect(error.cause.message).toMatch(expectedCause);
      }
    }
  });
});
