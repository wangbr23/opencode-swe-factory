import { unlinkSync } from "node:fs";
import { isAbsolute } from "node:path";

import type {
  HardDeleteAllStoredDataInput,
  HardDeletionReport,
  HardDeletionStage,
  HardDeletionTableSummary,
} from "../types/hard-deletion-types.js";
import { createBackupSnapshot, listManagedBackups } from "./backup.js";
import { resolveManagedPaths } from "./paths.js";
import type { SqliteConnection } from "./sqlite.js";

export {
  HARD_DELETE_CONFIRMATION_PHRASE,
  type HardDeleteAllStoredDataInput,
  type HardDeletionReport,
  type HardDeletionStage,
  type HardDeletionTableSummary,
} from "../types/hard-deletion-types.js";

export class HardDeletionError extends Error {
  readonly stage: HardDeletionStage;

  constructor(stage: HardDeletionStage, cause: unknown) {
    super(`Hard deletion failed during stage "${stage}".`, { cause });
    this.name = "HardDeletionError";
    this.stage = stage;
  }
}

// Children before parents so every row is removed explicitly, even where an
// ON DELETE CASCADE would eventually reach it. Deleting lesson_versions and
// document_chunks fires the triggers that remove their FTS entries.
const HARD_DELETION_TABLE_ORDER = [
  "outcome_signals",
  "execution_profiles",
  "task_profiles",
  "tasks",
  "document_chunk_embeddings",
  "lesson_version_embeddings",
  "document_chunks",
  "document_sources",
  "pending_lesson_candidates",
  "lesson_versions",
  "lessons",
  "project_settings",
  "project_aliases",
  "projects",
] as const;

type WalCheckpointRow = Readonly<{ busy: number; log: number; checkpointed: number }>;

function checkpointAndTruncateWal(connection: SqliteConnection): void {
  const row = connection.database.query<WalCheckpointRow, []>("PRAGMA wal_checkpoint(TRUNCATE)").get();
  if (!row || row.busy !== 0) {
    throw new Error("WAL checkpoint could not complete because the database is busy.");
  }
}

/**
 * Privacy-first hard deletion of everything the package stores. Row deletion
 * is one atomic transaction; afterwards the WAL is checkpointed and truncated,
 * the database is vacuumed to clear freelist residue, all managed backups are
 * purged, and a clean baseline backup is created. Once the row-deletion
 * transaction commits there is intentionally no rollback: a later failure
 * (for example during baseline creation) leaves the data deleted, which is the
 * point of a privacy-first delete.
 */
export function hardDeleteAllStoredData(
  connection: SqliteConnection,
  input: HardDeleteAllStoredDataInput = {},
): HardDeletionReport {
  const backupDirectory = input.backupDirectory ?? resolveManagedPaths().backupDirectory;
  if (!isAbsolute(backupDirectory)) {
    throw new Error("Backup directory path must be absolute.");
  }
  if (connection.isClosed) {
    throw new Error("Cannot hard-delete using a closed SQLite connection.");
  }

  let tables: HardDeletionTableSummary[];
  try {
    tables = connection.database.transaction((): HardDeletionTableSummary[] => {
      return HARD_DELETION_TABLE_ORDER.map((table) => ({
        table,
        deletedRowCount: connection.database.run(`DELETE FROM ${table}`).changes,
      }));
    })();
  } catch (error) {
    throw new HardDeletionError("delete-rows", error);
  }

  try {
    checkpointAndTruncateWal(connection);
  } catch (error) {
    throw new HardDeletionError("wal-checkpoint", error);
  }

  try {
    connection.database.run("VACUUM");
  } catch (error) {
    throw new HardDeletionError("vacuum", error);
  }

  // VACUUM itself writes through the WAL, so truncate again to leave no residue.
  try {
    checkpointAndTruncateWal(connection);
  } catch (error) {
    throw new HardDeletionError("wal-checkpoint", error);
  }

  let purgedBackupPaths: string[];
  try {
    purgedBackupPaths = listManagedBackups(backupDirectory).map((backup) => {
      unlinkSync(backup.backupPath);
      return backup.backupPath;
    });
  } catch (error) {
    throw new HardDeletionError("purge-backups", error);
  }

  let baselineBackup: HardDeletionReport["baselineBackup"];
  try {
    baselineBackup = createBackupSnapshot(connection, { backupDirectory, ...(input.now ? { now: input.now } : {}) });
  } catch (error) {
    throw new HardDeletionError("baseline-backup", error);
  }

  return { tables, purgedBackupPaths, baselineBackup };
}
