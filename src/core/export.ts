import { writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";

import {
  EXPORT_SCHEMA_VERSION,
  EXPORTED_TABLE_NAMES,
  type DatabaseExportResult,
  type ExportHeader,
  type ExportedTableName,
} from "../types/export-types.js";
import { PACKAGE_NAME } from "./constants.js";
import { ensureOwnerOnlyFile } from "./paths.js";
import { scanTextForSecrets } from "./secrets.js";
import type { SqliteConnection } from "./sqlite.js";

export {
  EXPORT_SCHEMA_VERSION,
  EXPORTED_TABLE_NAMES,
  type DatabaseExportResult,
  type ExportHeader,
  type ExportRecordLine,
  type ExportTableSummary,
  type ExportedTableName,
} from "../types/export-types.js";

export class DatabaseExportError extends Error {
  readonly outputPath: string;

  constructor(outputPath: string, cause: unknown) {
    super(`Could not export database to ${outputPath}.`, { cause });
    this.name = "DatabaseExportError";
    this.outputPath = outputPath;
  }
}

// Free-text columns scanned and redacted before export, mirroring the fields
// that are secret-scanned at write time. Ids, hashes, timestamps, and JSON
// metadata are structural and must survive a round trip untouched.
const SCANNED_TEXT_COLUMNS: Readonly<Partial<Record<ExportedTableName, ReadonlyArray<string>>>> = {
  lesson_versions: ["title", "body", "rationale"],
  task_profiles: ["summary"],
};

type UserVersionRow = Readonly<{ user_version: number }>;

function readSqliteSchemaVersion(connection: SqliteConnection): number {
  const row = connection.database.query<UserVersionRow, []>("PRAGMA user_version").get();
  if (!row || !Number.isInteger(row.user_version)) {
    throw new Error("SQLite returned an invalid schema version.");
  }
  return row.user_version;
}

async function redactRecord(
  table: ExportedTableName,
  record: Record<string, unknown>,
): Promise<{ record: Record<string, unknown>; redactedFieldCount: number }> {
  const columns = SCANNED_TEXT_COLUMNS[table] ?? [];
  let redactedFieldCount = 0;
  const redacted: Record<string, unknown> = { ...record };
  for (const column of columns) {
    const value = record[column];
    if (typeof value !== "string") {
      continue;
    }
    const scan = await scanTextForSecrets(value);
    if (scan.findings.length > 0) {
      redacted[column] = scan.redactedText;
      redactedFieldCount += 1;
    }
  }
  return { record: redacted, redactedFieldCount };
}

export async function exportDatabaseToJsonl(
  connection: SqliteConnection,
  outputPath: string,
): Promise<DatabaseExportResult> {
  if (!isAbsolute(outputPath)) {
    throw new DatabaseExportError(outputPath, new Error("Export path must be absolute."));
  }

  try {
    const exportedAt = new Date().toISOString();
    const sqliteSchemaVersion = readSqliteSchemaVersion(connection);

    const header: ExportHeader = {
      type: "header",
      exportSchemaVersion: EXPORT_SCHEMA_VERSION,
      sqliteSchemaVersion,
      packageName: PACKAGE_NAME,
      exportedAt,
    };

    const lines: string[] = [JSON.stringify(header)];
    const tables = [];
    for (const table of EXPORTED_TABLE_NAMES) {
      const rows = connection.database
        .query<Record<string, unknown>, []>(`SELECT * FROM ${table}`)
        .all();
      let redactedFieldCount = 0;
      for (const row of rows) {
        const { record, redactedFieldCount: rowRedactions } = await redactRecord(table, row);
        redactedFieldCount += rowRedactions;
        lines.push(JSON.stringify({ type: table, record }));
      }
      tables.push({ table, rowCount: rows.length, redactedFieldCount });
    }

    ensureOwnerOnlyFile(outputPath);
    writeFileSync(outputPath, `${lines.join("\n")}\n`, { mode: 0o600 });

    return { outputPath, exportedAt, sqliteSchemaVersion, tables };
  } catch (error) {
    if (error instanceof DatabaseExportError) {
      throw error;
    }
    throw new DatabaseExportError(outputPath, error);
  }
}
