import type { ExportedTableName } from "./export-types.js";

export type RestoreStage =
  | "parse"
  | "schema-version"
  | "build"
  | "validate"
  | "swap";

export type RestoreDatabaseInput = Readonly<{
  inputPath: string;
  databasePath: string;
}>;

export type RestoredTableSummary = Readonly<{
  table: ExportedTableName;
  rowCount: number;
}>;

export type DatabaseRestoreResult = Readonly<{
  inputPath: string;
  databasePath: string;
  sqliteSchemaVersion: number;
  tables: ReadonlyArray<RestoredTableSummary>;
}>;

export type ParsedExportLine =
  | Readonly<{ type: "header"; exportSchemaVersion: number; sqliteSchemaVersion: number; packageName: string; exportedAt: string }>
  | Readonly<{ type: ExportedTableName; record: Record<string, unknown> }>;
