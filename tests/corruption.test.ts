import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SqliteConnectionInitializationError,
  createBackupSnapshot,
  migrateSqliteSchema,
  openSqliteConnection,
  releaseSchemaMigrations,
  verifyBackupIntegrity,
} from "../src/core/index.js";

const SEED_TIMESTAMP = "2026-09-07T00:00:00.000Z";

function withTemporaryDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-corruption-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function buildMigratedDatabase(databasePath: string): void {
  const connection = openSqliteConnection(databasePath);
  try {
    migrateSqliteSchema(connection, releaseSchemaMigrations);
    connection.database.run(
      "INSERT INTO projects (id, path, created_at, updated_at) VALUES ('project-1', '/repos/project-1', ?, ?)",
      [SEED_TIMESTAMP, SEED_TIMESTAMP],
    );
  } finally {
    connection.close();
  }
}

function probeIntegrity(databasePath: string): string {
  const database = new Database(databasePath, { readonly: true });
  try {
    return database
      .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
      .all()
      .map((row) => row.integrity_check)
      .join(";");
  } catch (error) {
    // A damaged file can fail the check outright instead of returning rows.
    return error instanceof Error ? error.message : String(error);
  } finally {
    database.close(true);
  }
}

function corruptBytes(databasePath: string, start: number, length: number): Buffer {
  const bytes = readFileSync(databasePath);
  const corrupted = Buffer.from(bytes);
  corrupted.write("CORRUPTED!".repeat(Math.ceil(length / 10)).slice(0, length), start, "utf8");
  writeFileSync(databasePath, corrupted);
  return corrupted;
}

test("fails initialization on a corrupted database header and leaves the file untouched", () => {
  withTemporaryDirectory((directory) => {
    const databasePath = join(directory, "memory.sqlite");
    buildMigratedDatabase(databasePath);

    const corrupted = corruptBytes(databasePath, 0, 16);

    let error: unknown;
    try {
      openSqliteConnection(databasePath);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SqliteConnectionInitializationError);
    expect((error as SqliteConnectionInitializationError).databasePath).toBe(databasePath);
    expect(readFileSync(databasePath).equals(corrupted)).toBe(true);
  });
});

test("reports interior page corruption through the integrity check", () => {
  withTemporaryDirectory((directory) => {
    const databasePath = join(directory, "memory.sqlite");
    const connection = openSqliteConnection(databasePath);
    try {
      connection.database.run("CREATE TABLE padded_rows (body TEXT NOT NULL)");
      const filler = "x".repeat(400);
      const insert = connection.database.query("INSERT INTO padded_rows (body) VALUES (?)");
      for (let index = 0; index < 300; index++) {
        insert.run(`${index}-${filler}`);
      }
    } finally {
      connection.close();
    }

    const size = readFileSync(databasePath).length;
    expect(size).toBeGreaterThan(8_192);
    corruptBytes(databasePath, Math.floor(size / 2), 1_024);

    expect(probeIntegrity(databasePath)).not.toBe("ok");
  });
});

test("verifies managed snapshot integrity and rejects a corrupted backup", () => {
  withTemporaryDirectory((directory) => {
    const databasePath = join(directory, "memory.sqlite");
    const backupDirectory = join(directory, "backups");
    buildMigratedDatabase(databasePath);

    const connection = openSqliteConnection(databasePath);
    let snapshotPath: string;
    try {
      const snapshot = createBackupSnapshot(connection, { backupDirectory });
      snapshotPath = snapshot.backupPath;
    } finally {
      connection.close();
    }

    expect(() => verifyBackupIntegrity(snapshotPath)).not.toThrow();

    corruptBytes(snapshotPath, 0, 16);
    expect(() => verifyBackupIntegrity(snapshotPath)).toThrow();
  });
});
