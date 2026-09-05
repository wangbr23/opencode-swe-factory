import type { Database } from "bun:sqlite";

import type { SchemaMigration, SchemaMigrationResult } from "../types/migrations-types.js";
import type { SqliteConnection } from "./sqlite.js";

export type { SchemaMigration, SchemaMigrationResult } from "../types/migrations-types.js";

export class SqliteMigrationError extends Error {
  readonly databasePath: string;
  readonly fromVersion: number;
  readonly targetVersion: number;
  readonly failedMigration: Pick<SchemaMigration, "version" | "name"> | undefined;
  readonly rollbackError: unknown | undefined;

  constructor(
    databasePath: string,
    fromVersion: number,
    targetVersion: number,
    cause: unknown,
    failedMigration?: SchemaMigration,
    rollbackError?: unknown,
  ) {
    const detail = failedMigration
      ? ` while applying migration ${failedMigration.version} (${failedMigration.name})`
      : "";
    super(`Could not migrate SQLite database at ${databasePath} from version ${fromVersion} to ${targetVersion}${detail}.`, {
      cause,
    });
    this.name = "SqliteMigrationError";
    this.databasePath = databasePath;
    this.fromVersion = fromVersion;
    this.targetVersion = targetVersion;
    this.failedMigration = failedMigration && {
      version: failedMigration.version,
      name: failedMigration.name,
    };
    this.rollbackError = rollbackError;
  }
}

type UserVersionRow = Readonly<{ user_version: number }>;

function readSchemaVersion(database: Database): number {
  const row = database.query<UserVersionRow, []>("PRAGMA user_version").get();
  if (!row || !Number.isInteger(row.user_version) || row.user_version < 0) {
    throw new Error("SQLite returned an invalid schema version.");
  }
  return row.user_version;
}

function validateMigrations(migrations: readonly SchemaMigration[]): void {
  migrations.forEach((migration, index) => {
    const expectedVersion = index + 1;
    if (migration.version !== expectedVersion) {
      throw new Error(`Expected schema migration version ${expectedVersion}, received ${migration.version}.`);
    }
    if (migration.name.trim().length === 0) {
      throw new Error(`Schema migration ${migration.version} must have a name.`);
    }
  });
}

function makeNewerSchemaResult(schemaVersion: number, supportedSchemaVersion: number): SchemaMigrationResult {
  return {
    status: "newer-schema",
    schemaVersion,
    supportedSchemaVersion,
    appliedVersions: [],
  };
}

function enableReadOnlyMode(database: Database): void {
  database.run("PRAGMA query_only = ON");
}

export function migrateSqliteSchema(
  connection: SqliteConnection,
  migrations: readonly SchemaMigration[],
): SchemaMigrationResult {
  validateMigrations(migrations);

  const { database, databasePath } = connection;
  const supportedSchemaVersion = migrations.length;
  let fromVersion = 0;
  let failedMigration: SchemaMigration | undefined;
  let transactionStarted = false;

  try {
    database.run("BEGIN IMMEDIATE");
    transactionStarted = true;
    fromVersion = readSchemaVersion(database);

    if (fromVersion > supportedSchemaVersion) {
      database.run("ROLLBACK");
      transactionStarted = false;
      enableReadOnlyMode(database);
      return makeNewerSchemaResult(fromVersion, supportedSchemaVersion);
    }

    if (fromVersion === supportedSchemaVersion) {
      database.run("COMMIT");
      transactionStarted = false;
      return { status: "ready", schemaVersion: fromVersion, appliedVersions: [] };
    }

    const appliedVersions: number[] = [];
    for (const migration of migrations.slice(fromVersion)) {
      failedMigration = migration;
      migration.migrate(database);
      database.run(`PRAGMA user_version = ${migration.version}`);
      appliedVersions.push(migration.version);
    }
    database.run("COMMIT");
    transactionStarted = false;

    return {
      status: "ready",
      schemaVersion: supportedSchemaVersion,
      appliedVersions,
    };
  } catch (error) {
    let rollbackError: unknown;
    if (transactionStarted) {
      try {
        database.run("ROLLBACK");
      } catch (failure) {
        rollbackError = failure;
      }
    }
    throw new SqliteMigrationError(
      databasePath,
      fromVersion,
      supportedSchemaVersion,
      error,
      failedMigration,
      rollbackError,
    );
  }
}
