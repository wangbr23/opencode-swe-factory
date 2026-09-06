export const EXPORT_SCHEMA_VERSION = 1;

export const EXPORTED_TABLE_NAMES = [
  "projects",
  "project_aliases",
  "project_settings",
  "lessons",
  "lesson_versions",
  "tasks",
  "task_profiles",
  "execution_profiles",
  "outcome_signals",
] as const;

export type ExportedTableName = (typeof EXPORTED_TABLE_NAMES)[number];

export type ExportHeader = Readonly<{
  type: "header";
  exportSchemaVersion: number;
  sqliteSchemaVersion: number;
  packageName: string;
  exportedAt: string;
}>;

export type ExportRecordLine = Readonly<{
  type: ExportedTableName;
  record: Readonly<Record<string, unknown>>;
}>;

export type ExportTableSummary = Readonly<{
  table: ExportedTableName;
  rowCount: number;
  redactedFieldCount: number;
}>;

export type DatabaseExportResult = Readonly<{
  outputPath: string;
  exportedAt: string;
  sqliteSchemaVersion: number;
  tables: ReadonlyArray<ExportTableSummary>;
}>;
