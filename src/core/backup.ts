import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { renameSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { ensureOwnerOnlyDirectory, ensureOwnerOnlyFile, resolveManagedPaths } from "./paths.js";
import type { SqliteConnection } from "./sqlite.js";

export type BackupSnapshot = Readonly<{
  backupPath: string;
  createdAt: string;
  sizeBytes: number;
}>;

export type CreateBackupSnapshotInput = Readonly<{
  backupDirectory?: string;
}>;

export class BackupSnapshotError extends Error {
  readonly backupDirectory: string;
  readonly cleanupError: unknown | undefined;

  constructor(backupDirectory: string, cause: unknown, cleanupError?: unknown) {
    super(`Could not create SQLite backup snapshot in ${backupDirectory}.`, { cause });
    this.name = "BackupSnapshotError";
    this.backupDirectory = backupDirectory;
    this.cleanupError = cleanupError;
  }
}

type IntegrityCheckRow = Readonly<{
  integrity_check: string;
}>;

function backupFileTimestamp(createdAt: Date): string {
  return createdAt.toISOString().replaceAll(/[-:.]/g, "");
}

function verifyBackupIntegrity(backupPath: string): void {
  const database = new Database(backupPath, { readonly: true });
  try {
    const rows = database.query<IntegrityCheckRow, []>("PRAGMA integrity_check").all();
    if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
      throw new Error(`SQLite integrity check failed for backup at ${backupPath}.`);
    }
  } finally {
    database.close(true);
  }
}

export function createBackupSnapshot(
  connection: SqliteConnection,
  input: CreateBackupSnapshotInput = {},
): BackupSnapshot {
  const backupDirectory = input.backupDirectory ?? resolveManagedPaths().backupDirectory;
  const createdAt = new Date();
  const snapshotId = `${backupFileTimestamp(createdAt)}-${randomUUID()}`;
  const backupPath = join(backupDirectory, `backup-${snapshotId}.sqlite`);
  const temporaryPath = join(backupDirectory, `.backup-${snapshotId}.tmp`);

  try {
    if (!isAbsolute(backupDirectory)) {
      throw new Error("Backup directory path must be absolute.");
    }
    if (connection.isClosed) {
      throw new Error("Cannot back up a closed SQLite connection.");
    }

    ensureOwnerOnlyDirectory(backupDirectory);
    connection.database.query<never, [string]>("VACUUM INTO ?").run(temporaryPath);
    ensureOwnerOnlyFile(temporaryPath);
    verifyBackupIntegrity(temporaryPath);
    const sizeBytes = statSync(temporaryPath).size;
    renameSync(temporaryPath, backupPath);

    return {
      backupPath,
      createdAt: createdAt.toISOString(),
      sizeBytes,
    };
  } catch (error) {
    let cleanupError: unknown | undefined;
    try {
      rmSync(temporaryPath, { force: true });
    } catch (cleanup) {
      cleanupError = cleanup;
    }
    throw new BackupSnapshotError(backupDirectory, error, cleanupError);
  }
}
