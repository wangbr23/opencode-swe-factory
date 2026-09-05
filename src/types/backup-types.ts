import type { ConfigV1 } from "../core/config.js";

export const MANAGED_BACKUP_PATTERN = /^backup-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-[0-9a-f-]{36}\.sqlite$/;

export type BackupSnapshot = Readonly<{
  backupPath: string;
  createdAt: string;
  sizeBytes: number;
}>;

export type CreateBackupSnapshotInput = Readonly<{
  backupDirectory?: string;
  now?: Date;
}>;

export type IntegrityCheckRow = Readonly<{
  integrity_check: string;
}>;

export type ScheduledBackupOutcome =
  | Readonly<{ status: "disabled" }>
  | Readonly<{ status: "not-due"; latestBackupAt: string | null; nextDueAt: string | null }>
  | Readonly<{
      status: "created";
      snapshot: BackupSnapshot;
      deletedBackupPaths: ReadonlyArray<string>;
    }>;

export type RunScheduledBackupInput = Readonly<{
  backups: ConfigV1["backups"];
  backupDirectory?: string;
  now?: Date;
}>;

export type ManagedBackup = Readonly<{
  backupPath: string;
  createdAt: Date;
}>;

export type ManagedBackupInfo = Readonly<{
  backupPath: string;
  createdAt: string;
}>;

export type BackupScheduleState = Readonly<{
  latestBackupAt: string | null;
  nextDueAt: string | null;
  isDue: boolean;
}>;
