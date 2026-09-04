import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  SQLITE_BUSY_TIMEOUT_MS,
  SqliteConnectionInitializationError,
  openSqliteConnection,
} from "../src/core/index.js";

function withTemporaryDatabase(run: (databasePath: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-sqlite-"));
  try {
    run(join(directory, "memory.sqlite"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function readPragma(connection: ReturnType<typeof openSqliteConnection>, pragma: string): string | number {
  const row = connection.database.query<Record<string, string | number>, []>(`PRAGMA ${pragma}`).get();
  const value = row?.[pragma === "busy_timeout" ? "timeout" : pragma];
  if (value === undefined) {
    throw new Error(`Missing SQLite pragma ${pragma}.`);
  }
  return value;
}

test("opens an owner-only SQLite database with the required connection invariants", () => {
  withTemporaryDatabase((databasePath) => {
    const connection = openSqliteConnection(databasePath);
    try {
      expect(readPragma(connection, "journal_mode")).toBe("wal");
      expect(readPragma(connection, "foreign_keys")).toBe(1);
      expect(readPragma(connection, "secure_delete")).toBe(1);
      expect(readPragma(connection, "busy_timeout")).toBe(SQLITE_BUSY_TIMEOUT_MS);

      if (process.platform !== "win32") {
        expect(statSync(databasePath).mode & 0o777).toBe(0o600);
        expect(statSync(dirname(databasePath)).mode & 0o777).toBe(0o700);
      }
    } finally {
      connection.close();
    }
  });
});

test("persists data across reopened connections and reapplies connection pragmas", () => {
  withTemporaryDatabase((databasePath) => {
    const first = openSqliteConnection(databasePath);
    first.database.run("CREATE TABLE notes (body TEXT NOT NULL)");
    first.database.run("INSERT INTO notes (body) VALUES ('persisted')");
    first.close();

    const second = openSqliteConnection(databasePath);
    try {
      expect(second.database.query<{ body: string }, []>("SELECT body FROM notes").get()).toEqual({ body: "persisted" });
      expect(readPragma(second, "journal_mode")).toBe("wal");
      expect(readPragma(second, "foreign_keys")).toBe(1);
      expect(readPragma(second, "secure_delete")).toBe(1);
      expect(readPragma(second, "busy_timeout")).toBe(SQLITE_BUSY_TIMEOUT_MS);
    } finally {
      second.close();
    }
  });
});

test("verifies FTS5 and closes safely", () => {
  withTemporaryDatabase((databasePath) => {
    const connection = openSqliteConnection(databasePath);
    connection.database.run("CREATE VIRTUAL TABLE search USING fts5(content)");
    connection.database.run("INSERT INTO search (content) VALUES ('FTS5 is available')");
    expect(connection.database.query<{ content: string }, []>("SELECT content FROM search WHERE search MATCH 'available'").get()).toEqual({ content: "FTS5 is available" });

    connection.close();
    connection.close();
    expect(connection.isClosed).toBe(true);
    expect(() => connection.database.run("SELECT 1")).toThrow(/Database has closed/);
  });
});

test("wraps setup failures with the database path", () => {
  withTemporaryDatabase((databasePath) => {
    const blockedPath = join(databasePath, "child.sqlite");
    writeFileSync(databasePath, "not a directory");

    try {
      openSqliteConnection(blockedPath);
      throw new Error("Expected SQLite initialization to fail.");
    } catch (error) {
      if (!(error instanceof SqliteConnectionInitializationError)) {
        throw error;
      }
      expect(error.databasePath).toBe(blockedPath);
    }
  });
});

test("rejects relative database paths before changing the working directory", () => {
  expect(() => openSqliteConnection("memory.sqlite")).toThrow(SqliteConnectionInitializationError);
});
