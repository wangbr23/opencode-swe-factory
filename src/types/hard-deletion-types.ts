import type { BackupSnapshot } from "./backup-types.js";

export type HardDeletionStage = "delete-rows" | "wal-checkpoint" | "vacuum" | "purge-backups" | "baseline-backup";

export type HardDeletionTableSummary = Readonly<{
  table: string;
  deletedRowCount: number;
}>;

export type HardDeletionReport = Readonly<{
  tables: ReadonlyArray<HardDeletionTableSummary>;
  purgedBackupPaths: ReadonlyArray<string>;
  baselineBackup: BackupSnapshot;
}>;

export type HardDeleteAllStoredDataInput = Readonly<{
  backupDirectory?: string;
  now?: Date;
}>;

// Confirmation phrase the CLI requires before running a hard deletion. Kept in
// shared types so the CLI prompt and its tests cannot drift apart.
export const HARD_DELETE_CONFIRMATION_PHRASE = "hard-delete";
