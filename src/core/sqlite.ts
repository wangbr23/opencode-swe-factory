import { Database } from "bun:sqlite";
import { isAbsolute } from "node:path";

import { ensureOwnerOnlyFile } from "./paths.js";
import { SQLITE_BUSY_TIMEOUT_MS, type SqliteConnection } from "../types/sqlite-types.js";

export { SQLITE_BUSY_TIMEOUT_MS, type SqliteConnection } from "../types/sqlite-types.js";

export class SqliteConnectionInitializationError extends Error {
  readonly databasePath: string;
  readonly cleanupError: unknown | undefined;

  constructor(databasePath: string, cause: unknown, cleanupError?: unknown) {
    super(`Could not initialize SQLite database at ${databasePath}.`, { cause });
    this.name = "SqliteConnectionInitializationError";
    this.databasePath = databasePath;
    this.cleanupError = cleanupError;
  }
}

export class SqlitePrerequisiteError extends Error {
  readonly databasePath: string;
  readonly prerequisite = "fts5";
  readonly cleanupError: unknown | undefined;

  constructor(databasePath: string, cause: unknown, cleanupError?: unknown) {
    super(`SQLite prerequisite fts5 is unavailable for database at ${databasePath}.`, { cause });
    this.name = "SqlitePrerequisiteError";
    this.databasePath = databasePath;
    this.cleanupError = cleanupError;
  }
}

type PragmaRow = Readonly<Record<string, string | number>>;

function verifyPragma(database: Database, pragma: string, expected: string | number, field = pragma): void {
  const row = database.query<PragmaRow, []>(`PRAGMA ${pragma}`).get();
  if (row?.[field] !== expected) {
    throw new Error(`SQLite pragma ${pragma} was not set to ${String(expected)}.`);
  }
}

function verifyFts5(database: Database, databasePath: string): void {
  try {
    database.run("CREATE VIRTUAL TABLE temp.__opencode_swe_factory_fts5_check USING fts5(content)");
    database.run("DROP TABLE temp.__opencode_swe_factory_fts5_check");
  } catch (error) {
    throw new SqlitePrerequisiteError(databasePath, error);
  }
}

function closeAfterInitializationFailure(database: Database | undefined): unknown {
  try {
    database?.close(true);
  } catch (error) {
    return error;
  }
  return undefined;
}

export function openSqliteConnection(databasePath: string): SqliteConnection {
  let database: Database | undefined;

  try {
    if (!isAbsolute(databasePath)) {
      throw new Error("SQLite database path must be absolute.");
    }
    ensureOwnerOnlyFile(databasePath);
    database = new Database(databasePath, { create: true, readwrite: true });
    database.run("PRAGMA journal_mode = WAL");
    database.run("PRAGMA foreign_keys = ON");
    database.run("PRAGMA secure_delete = ON");
    database.run(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);

    verifyPragma(database, "journal_mode", "wal");
    verifyPragma(database, "foreign_keys", 1);
    verifyPragma(database, "secure_delete", 1);
    verifyPragma(database, "busy_timeout", SQLITE_BUSY_TIMEOUT_MS, "timeout");
    verifyFts5(database, databasePath);
    ensureOwnerOnlyFile(databasePath);
  } catch (error) {
    const cleanupError = closeAfterInitializationFailure(database);
    if (error instanceof SqlitePrerequisiteError) {
      throw new SqlitePrerequisiteError(databasePath, error.cause, cleanupError);
    }
    throw new SqliteConnectionInitializationError(databasePath, error, cleanupError);
  }

  let isClosed = false;
  return {
    database,
    databasePath,
    get isClosed() {
      return isClosed;
    },
    close() {
      if (!isClosed) {
        database.close(true);
        isClosed = true;
      }
    },
  };
}
