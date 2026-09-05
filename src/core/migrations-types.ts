import type { Database } from "bun:sqlite";

export type SchemaMigration = Readonly<{
  version: number;
  name: string;
  migrate(database: Database): void;
}>;

export type SchemaMigrationResult =
  | Readonly<{
      status: "ready";
      schemaVersion: number;
      appliedVersions: readonly number[];
    }>
  | Readonly<{
      status: "newer-schema";
      schemaVersion: number;
      supportedSchemaVersion: number;
      appliedVersions: readonly [];
    }>;
