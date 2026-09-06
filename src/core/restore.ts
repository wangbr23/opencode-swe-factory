import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { SQLQueryBindings } from "bun:sqlite";

import { PACKAGE_NAME } from "./constants.js";
import { migrateSqliteSchema } from "./migrations.js";
import { ensureOwnerOnlyFile } from "./paths.js";
import { releaseSchemaMigrations } from "./schema.js";
import { openSqliteConnection, type SqliteConnection } from "./sqlite.js";
import {
  EXPORT_SCHEMA_VERSION,
  EXPORTED_TABLE_NAMES,
  type ExportedTableName,
} from "../types/export-types.js";
import type {
  DatabaseRestoreResult,
  ParsedExportLine,
  RestoreDatabaseInput,
  RestoreStage,
  RestoredTableSummary,
} from "../types/restore-types.js";

export class DatabaseRestoreError extends Error {
  readonly inputPath: string;
  readonly databasePath: string;
  readonly stage: RestoreStage;

  constructor(inputPath: string, databasePath: string, stage: RestoreStage, cause: unknown) {
    const causeMessage =
      cause instanceof Error ? cause.message : Array.isArray(cause)
        ? cause.map((entry) => (entry instanceof Error ? entry.message : String(entry))).join("; ")
        : String(cause);
    super(
      `Could not restore database from ${inputPath} into ${databasePath} (failed during ${stage}): ${causeMessage}`,
      { cause },
    );
    this.name = "DatabaseRestoreError";
    this.inputPath = inputPath;
    this.databasePath = databasePath;
    this.stage = stage;
  }
}

export { EXPORT_SCHEMA_VERSION, EXPORTED_TABLE_NAMES };
export type {
  DatabaseRestoreResult,
  ExportedTableName,
  ParsedExportLine,
  RestoreDatabaseInput,
  RestoreStage,
  RestoredTableSummary,
};

type TableRecords = ReadonlyArray<Record<string, unknown>>;

type ParsedExport = Readonly<{
  sqliteSchemaVersion: number;
  tables: ReadonlyMap<ExportedTableName, TableRecords>;
}>;

function parseInto(inputPath: string): ParsedExport {
  const raw = readFileSync(inputPath, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    throw new Error("Export file is empty.");
  }

  let header: ParsedExportLine;
  try {
    header = JSON.parse(lines[0] as string) as ParsedExportLine;
  } catch (error) {
    throw new Error(`First export line is not valid JSON: ${String(error)}`);
  }
  if (header.type !== "header") {
    throw new Error("First export line must be the header.");
  }
  if (header.exportSchemaVersion !== EXPORT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported export schema version ${header.exportSchemaVersion}; expected ${EXPORT_SCHEMA_VERSION}.`,
    );
  }
  if (header.packageName !== PACKAGE_NAME) {
    throw new Error(`Export was produced by "${header.packageName}", not "${PACKAGE_NAME}".`);
  }
  const supportedSchemaVersion = releaseSchemaMigrations.length;
  if (
    !Number.isInteger(header.sqliteSchemaVersion) ||
    header.sqliteSchemaVersion < 0 ||
    header.sqliteSchemaVersion > supportedSchemaVersion
  ) {
    throw new Error(
      `Export schema v${String(header.sqliteSchemaVersion)} is newer than supported v${supportedSchemaVersion}; restore refused.`,
    );
  }

  const tables = new Map<ExportedTableName, TableRecords>();
  for (const line of lines.slice(1)) {
    let parsed: ParsedExportLine;
    try {
      parsed = JSON.parse(line) as ParsedExportLine;
    } catch (error) {
      throw new Error(`Export line is not valid JSON: ${String(error)}`);
    }
    if (parsed.type === "header") {
      throw new Error("Duplicate export header line.");
    }
    if (!EXPORTED_TABLE_NAMES.includes(parsed.type)) {
      throw new Error(`Export line references unknown table "${String(parsed.type)}".`);
    }
    if (typeof parsed.record !== "object" || parsed.record === null || Array.isArray(parsed.record)) {
      throw new Error(`Export line for table "${parsed.type}" does not contain an object record.`);
    }
    const existing = tables.get(parsed.type) ?? [];
    tables.set(parsed.type, [...existing, parsed.record]);
  }

  return { sqliteSchemaVersion: header.sqliteSchemaVersion, tables };
}

function readTableColumns(connection: SqliteConnection, table: ExportedTableName): ReadonlySet<string> {
  const rows = connection.database
    .query<Record<string, unknown>, []>(`PRAGMA table_info(${table})`)
    .all();
  return new Set(rows.map((row) => String(row.name)));
}

function countTableRows(connection: SqliteConnection, table: ExportedTableName): number {
  const row = connection.database.query<Record<string, unknown>, []>(`SELECT COUNT(*) AS count FROM ${table}`).get();
  const count = row?.count;
  if (typeof count !== "number") {
    throw new Error(`Could not count rows in ${table}.`);
  }
  return count;
}

function buildReplacementDatabase(
  tempPath: string,
  parsed: ParsedExport,
): void {
  const connection = openSqliteConnection(tempPath);
  try {
    const initial = migrateSqliteSchema(
      connection,
      releaseSchemaMigrations.slice(0, parsed.sqliteSchemaVersion),
    );
    if (initial.status !== "ready") {
      throw new Error(`Replacement database migration returned status ${initial.status}.`);
    }

    const expectedCounts = new Map<ExportedTableName, number>();
    connection.database.transaction(() => {
      // Export rows can reference rows that appear later in the file (for
      // example a superseded version pointing at its successor), so FK
      // enforcement is deferred to commit time. Real violations are caught by
      // the explicit foreign_key_check during validation.
      connection.database.run("PRAGMA defer_foreign_keys = ON");
      for (const table of EXPORTED_TABLE_NAMES) {
        const records = parsed.tables.get(table) ?? [];
        const columns = readTableColumns(connection, table);
        if (records.length > 0 && columns.size === 0) {
          throw new Error(`Table ${table} does not exist in schema v${parsed.sqliteSchemaVersion}.`);
        }
        for (const record of records) {
          const keys = Object.keys(record);
          if (keys.length === 0) {
            throw new Error(`Record for ${table} has no columns.`);
          }
          const unknown = keys.filter((key) => !columns.has(key));
          if (unknown.length > 0) {
            throw new Error(`Record for ${table} has unknown column(s): ${unknown.join(", ")}.`);
          }
          const placeholders = keys.map(() => "?").join(", ");
          const values = keys.map((key) => {
            const value = record[key];
            if (
              value !== null &&
              typeof value !== "string" &&
              typeof value !== "number" &&
              typeof value !== "bigint" &&
              !(value instanceof Uint8Array)
            ) {
              throw new Error(`Record for ${table} has a non-primitive value in column "${key}".`);
            }
            return value;
          });
          connection.database.run(
            `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${placeholders})`,
            values as SQLQueryBindings[],
          );
        }
        expectedCounts.set(table, records.length);
      }
    })();

    const final = migrateSqliteSchema(connection, releaseSchemaMigrations);
    if (final.status !== "ready") {
      throw new Error(`Replacement database upgrade returned status ${final.status}.`);
    }

    for (const table of EXPORTED_TABLE_NAMES) {
      const expected = expectedCounts.get(table) ?? 0;
      const actual = countTableRows(connection, table);
      if (actual !== expected) {
        throw new Error(`Row count mismatch for ${table}: expected ${expected}, found ${actual}.`);
      }
    }
  } finally {
    connection.close();
  }
}

function validateReplacementIntegrity(tempPath: string): void {
  const connection = openSqliteConnection(tempPath);
  try {
    const integrityRows = connection.database
      .query<Record<string, unknown>, []>("PRAGMA integrity_check")
      .all();
    const failures = integrityRows.filter((row) => row.integrity_check !== "ok");
    if (failures.length > 0) {
      throw new Error(`Integrity check failed: ${failures.map((row) => String(row.integrity_check)).join("; ")}`);
    }
    const foreignKeyViolations = connection.database
      .query<Record<string, unknown>, []>("PRAGMA foreign_key_check")
      .all();
    if (foreignKeyViolations.length > 0) {
      throw new Error(`Foreign key check found ${foreignKeyViolations.length} violation(s).`);
    }
  } finally {
    connection.close();
  }
}

function removeDatabaseSidecarFiles(databasePath: string): void {
  rmSync(`${databasePath}-wal`, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
}

function renameDatabaseSidecars(fromBase: string, toBase: string): void {
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${fromBase}${suffix}`)) {
      renameSync(`${fromBase}${suffix}`, `${toBase}${suffix}`);
    }
  }
}

export function restoreDatabaseFromJsonl(input: RestoreDatabaseInput): DatabaseRestoreResult {
  const { inputPath, databasePath } = input;
  if (!isAbsolute(inputPath)) {
    throw new DatabaseRestoreError(inputPath, databasePath, "parse", new Error("Export path must be absolute."));
  }
  if (!isAbsolute(databasePath)) {
    throw new DatabaseRestoreError(inputPath, databasePath, "swap", new Error("Database path must be absolute."));
  }

  let parsed: ParsedExport;
  try {
    parsed = parseInto(inputPath);
  } catch (error) {
    throw new DatabaseRestoreError(inputPath, databasePath, "parse", error);
  }

  const tempPath = join(dirname(databasePath), `.restore-${randomUUID()}.tmp`);
  let previousPath: string | undefined;
  let stage: RestoreStage = "build";
  try {
    try {
      ensureOwnerOnlyFile(tempPath);
      buildReplacementDatabase(tempPath, parsed);
      stage = "validate";
      validateReplacementIntegrity(tempPath);
      removeDatabaseSidecarFiles(tempPath);
    } catch (error) {
      throw new DatabaseRestoreError(inputPath, databasePath, stage, error);
    }

    stage = "swap";
    try {
      if (existsSync(databasePath)) {
        previousPath = `${databasePath}.restore-prev`;
        renameSync(databasePath, previousPath);
        renameDatabaseSidecars(databasePath, previousPath);
      }
      renameSync(tempPath, databasePath);
      ensureOwnerOnlyFile(databasePath);
    } catch (error) {
      if (previousPath !== undefined && !existsSync(databasePath)) {
        try {
          renameSync(previousPath, databasePath);
          renameDatabaseSidecars(previousPath, databasePath);
        } catch (rollbackError) {
          // The original database now lives at previousPath; surface both
          // failures instead of deleting the only surviving copy.
          throw new DatabaseRestoreError(inputPath, databasePath, "swap", [
            error,
            new Error(`Rollback also failed: ${String(rollbackError)}`),
          ]);
        }
      }
      throw new DatabaseRestoreError(inputPath, databasePath, "swap", error);
    }

    if (previousPath !== undefined) {
      rmSync(previousPath, { force: true });
      removeDatabaseSidecarFiles(previousPath);
    }

    return {
      inputPath,
      databasePath,
      sqliteSchemaVersion: releaseSchemaMigrations.length,
      tables: EXPORTED_TABLE_NAMES.map((table) => ({
        table,
        rowCount: parsed.tables.get(table)?.length ?? 0,
      })),
    };
  } finally {
    // Never delete previousPath here: if the swap failed and the rollback also
    // failed, it holds the only surviving copy of the original database.
    rmSync(tempPath, { force: true });
    removeDatabaseSidecarFiles(tempPath);
  }
}
