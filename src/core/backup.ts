import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { readdirSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { MANAGED_BACKUP_PATTERN } from "../types/backup-types.js";
import type {
  BackupScheduleState,
  BackupSnapshot,
  CreateBackupSnapshotInput,
  IntegrityCheckRow,
  ManagedBackup,
  ManagedBackupInfo,
  RunScheduledBackupInput,
  ScheduledBackupOutcome,
} from "../types/backup-types.js";
import type { ConfigV1 } from "./config.js";
import { ensureOwnerOnlyDirectory, ensureOwnerOnlyFile, resolveManagedPaths } from "./paths.js";
import type { SqliteConnection } from "./sqlite.js";

export type {
  BackupScheduleState,
  BackupSnapshot,
  CreateBackupSnapshotInput,
  ManagedBackupInfo,
  RunScheduledBackupInput,
  ScheduledBackupOutcome,
} from "../types/backup-types.js";

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
  const createdAt = input.now ?? new Date();
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

export class BackupScheduleError extends Error {
  readonly backupDirectory: string;
  readonly failedBackupPath: string;
  readonly deletedBackupPaths: ReadonlyArray<string>;

  constructor(backupDirectory: string, failedBackupPath: string, deletedBackupPaths: ReadonlyArray<string>, cause: unknown) {
    super(`Could not apply backup retention in ${backupDirectory}.`, { cause });
    this.name = "BackupScheduleError";
    this.backupDirectory = backupDirectory;
    this.failedBackupPath = failedBackupPath;
    this.deletedBackupPaths = deletedBackupPaths;
  }
}

function parseManagedBackupPath(fileName: string, backupDirectory: string): ManagedBackup | undefined {
  const match = MANAGED_BACKUP_PATTERN.exec(fileName);
  if (!match) {
    return undefined;
  }
  const [, year, month, day, hour, minute, second, millisecond] = match;
  const isoTimestamp = `${year}-${month}-${day}T${hour}:${minute}:${second}.${millisecond}Z`;
  const createdAt = new Date(isoTimestamp);
  if (Number.isNaN(createdAt.getTime())) {
    return undefined;
  }
  return { backupPath: join(backupDirectory, fileName), createdAt };
}

export function listManagedBackups(backupDirectory: string): ReadonlyArray<ManagedBackupInfo> {
  let entries: string[];
  try {
    entries = readdirSync(backupDirectory);
  } catch (error) {
    if (error instanceof Error && (error as Error & { code?: string }).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const managed: ManagedBackup[] = [];
  for (const entry of entries) {
    const parsed = parseManagedBackupPath(entry, backupDirectory);
    if (parsed) {
      managed.push(parsed);
    }
  }
  managed.sort((first, second) =>
    first.createdAt.getTime() !== second.createdAt.getTime()
      ? first.createdAt.getTime() - second.createdAt.getTime()
      : first.backupPath.localeCompare(second.backupPath),
  );
  return managed.map((backup) => ({ backupPath: backup.backupPath, createdAt: toIsoTimestamp(backup.createdAt) }));
}

function toIsoTimestamp(createdAt: Date): string {
  return createdAt.toISOString();
}

/**
 * Reports when the next scheduled backup is due from the managed snapshots on
 * disk. Shared by the scheduled runner and CLI status so the due math cannot
 * drift between them.
 */
export function getBackupScheduleState(
  backupDirectory: string,
  intervalDays: number | null,
  now: Date = new Date(),
): BackupScheduleState {
  if (intervalDays !== null && (!Number.isInteger(intervalDays) || intervalDays <= 0)) {
    throw new Error("backups.schedule.intervalDays must be a positive integer or null.");
  }

  const latest = listManagedBackups(backupDirectory).at(-1);
  if (intervalDays === null || !latest) {
    return { latestBackupAt: latest?.createdAt ?? null, nextDueAt: null, isDue: true };
  }

  const nextDueAtMs = Date.parse(latest.createdAt) + intervalDays * 24 * 60 * 60 * 1000;
  return {
    latestBackupAt: latest.createdAt,
    nextDueAt: toIsoTimestamp(new Date(nextDueAtMs)),
    isDue: now.getTime() >= nextDueAtMs,
  };
}

function assertScheduleSettings(backups: ConfigV1["backups"]): void {
  if (typeof backups.enabled !== "boolean") {
    throw new Error("Backup settings enabled must be a boolean.");
  }
  for (const [label, value] of [
    ["backups.schedule.intervalDays", backups.schedule.intervalDays],
    ["backups.retention.maxBackups", backups.retention.maxBackups],
  ] as const) {
    if (value !== null && (!Number.isInteger(value) || value <= 0)) {
      throw new Error(`${label} must be a positive integer or null.`);
    }
  }
}

/**
 * Deletes the oldest managed backups beyond the retention limit. The protected
 * backup (typically a snapshot just created) is never deleted, even when
 * timestamp ties would otherwise sort it first.
 */
export function applyBackupRetention(
  backupDirectory: string,
  maxBackups: number,
  protectedBackupPath?: string,
): ReadonlyArray<string> {
  if (!Number.isInteger(maxBackups) || maxBackups <= 0) {
    throw new Error("Backup retention maxBackups must be a positive integer.");
  }

  const deletedBackupPaths: string[] = [];
  const managed = listManagedBackups(backupDirectory);
  const excessCount = managed.length - maxBackups;
  if (excessCount <= 0) {
    return deletedBackupPaths;
  }

  for (const candidate of managed.slice(0, excessCount)) {
    if (candidate.backupPath === protectedBackupPath) {
      continue;
    }
    try {
      unlinkSync(candidate.backupPath);
      deletedBackupPaths.push(candidate.backupPath);
    } catch (error) {
      throw new BackupScheduleError(backupDirectory, candidate.backupPath, deletedBackupPaths, error);
    }
  }
  return deletedBackupPaths;
}

export function runScheduledBackup(connection: SqliteConnection, input: RunScheduledBackupInput): ScheduledBackupOutcome {
  const { backups } = input;
  assertScheduleSettings(backups);

  if (!backups.enabled) {
    return { status: "disabled" };
  }

  const backupDirectory = input.backupDirectory ?? resolveManagedPaths().backupDirectory;
  if (!isAbsolute(backupDirectory)) {
    throw new Error("Backup directory path must be absolute.");
  }
  const now = input.now ?? new Date();

  const schedule = getBackupScheduleState(backupDirectory, backups.schedule.intervalDays, now);
  if (!schedule.isDue) {
    return {
      status: "not-due",
      latestBackupAt: schedule.latestBackupAt,
      nextDueAt: schedule.nextDueAt,
    };
  }

  const snapshot = createBackupSnapshot(connection, { backupDirectory, now });
  const deletedBackupPaths =
    backups.retention.maxBackups === null
      ? []
      : applyBackupRetention(backupDirectory, backups.retention.maxBackups, snapshot.backupPath);

  return { status: "created", snapshot, deletedBackupPaths };
}
