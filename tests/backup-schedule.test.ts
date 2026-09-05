import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  applyBackupRetention,
  BackupScheduleError,
  createBackupSnapshot,
  openSqliteConnection,
  runScheduledBackup,
  type ConfigV1,
} from "../src/core/index.js";

function withTemporaryDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-backup-schedule-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function listDirectoryOrNone(directory: string): string[] | undefined {
  try {
    return readdirSync(directory);
  } catch {
    return undefined;
  }
}

function backupSettings(overrides: Partial<ConfigV1["backups"]> = {}): ConfigV1["backups"] {
  return {
    enabled: true,
    schedule: { intervalDays: 7 },
    retention: { maxBackups: 3 },
    ...overrides,
  };
}

function daysAfter(isoTimestamp: string, days: number): Date {
  return new Date(Date.parse(isoTimestamp) + days * 24 * 60 * 60 * 1000);
}

test("skips scheduled backups that are disabled or not yet due", () => {
  withTemporaryDirectory((directory) => {
    const connection = openSqliteConnection(join(directory, "memory.sqlite"));
    const backupDirectory = join(directory, "backups");
    try {
      expect(
        runScheduledBackup(connection, {
          backups: backupSettings({ enabled: false }),
          backupDirectory,
        }),
      ).toEqual({ status: "disabled" });
      expect(listDirectoryOrNone(backupDirectory)).toBeUndefined();

      const first = createBackupSnapshot(connection, { backupDirectory });
      const outcome = runScheduledBackup(connection, {
        backups: backupSettings(),
        backupDirectory,
        now: daysAfter(first.createdAt, 2),
      });

      expect(outcome).toEqual({
        status: "not-due",
        latestBackupAt: first.createdAt,
        nextDueAt: daysAfter(first.createdAt, 7).toISOString(),
      });
      expect(readdirSync(backupDirectory)).toHaveLength(1);
    } finally {
      connection.close();
    }
  });
});

test("creates a backup once the schedule interval has elapsed", () => {
  withTemporaryDirectory((directory) => {
    const connection = openSqliteConnection(join(directory, "memory.sqlite"));
    const backupDirectory = join(directory, "backups");
    try {
      const first = createBackupSnapshot(connection, { backupDirectory });
      const now = daysAfter(first.createdAt, 8);
      const outcome = runScheduledBackup(connection, {
        backups: backupSettings(),
        backupDirectory,
        now,
      });

      expect(outcome.status).toBe("created");
      if (outcome.status === "created") {
        expect(outcome.snapshot.createdAt).toBe(now.toISOString());
        expect(outcome.deletedBackupPaths).toEqual([]);
      }
      expect(readdirSync(backupDirectory)).toHaveLength(2);
    } finally {
      connection.close();
    }
  });
});

test("treats a missing interval as due on every check", () => {
  withTemporaryDirectory((directory) => {
    const connection = openSqliteConnection(join(directory, "memory.sqlite"));
    const backupDirectory = join(directory, "backups");
    try {
      const first = createBackupSnapshot(connection, { backupDirectory });
      const outcome = runScheduledBackup(connection, {
        backups: backupSettings({ schedule: { intervalDays: null } }),
        backupDirectory,
        now: daysAfter(first.createdAt, 1),
      });

      expect(outcome.status).toBe("created");
      expect(readdirSync(backupDirectory)).toHaveLength(2);
    } finally {
      connection.close();
    }
  });
});

test("prunes the oldest managed backups beyond the retention limit", () => {
  withTemporaryDirectory((directory) => {
    const connection = openSqliteConnection(join(directory, "memory.sqlite"));
    const backupDirectory = join(directory, "backups");
    try {
      const base = Date.parse("2026-09-01T00:00:00.000Z");
      createBackupSnapshot(connection, { backupDirectory, now: new Date(base) });
      createBackupSnapshot(connection, { backupDirectory, now: new Date(base + 24 * 60 * 60 * 1000) });
      const keptOld = createBackupSnapshot(connection, {
        backupDirectory,
        now: new Date(base + 2 * 24 * 60 * 60 * 1000),
      });

      const outcome = runScheduledBackup(connection, {
        backups: backupSettings({ schedule: { intervalDays: null } }),
        backupDirectory,
        now: new Date(base + 3 * 24 * 60 * 60 * 1000),
      });

      expect(outcome.status).toBe("created");
      if (outcome.status !== "created") {
        return;
      }
      expect(outcome.deletedBackupPaths).toHaveLength(1);
      expect(outcome.deletedBackupPaths[0]).not.toBe(keptOld.backupPath);
      expect(outcome.deletedBackupPaths[0]).not.toBe(outcome.snapshot.backupPath);

      const remaining = readdirSync(backupDirectory).sort();
      expect(remaining).toHaveLength(3);
      expect(remaining).toContain(basename(keptOld.backupPath));
      expect(remaining).toContain(basename(outcome.snapshot.backupPath));
    } finally {
      connection.close();
    }
  });
});

test("keeps every backup when retention is unlimited", () => {
  withTemporaryDirectory((directory) => {
    const connection = openSqliteConnection(join(directory, "memory.sqlite"));
    const backupDirectory = join(directory, "backups");
    try {
      const base = Date.parse("2026-09-01T00:00:00.000Z");
      for (let dayOffset = 0; dayOffset < 3; dayOffset += 1) {
        createBackupSnapshot(connection, { backupDirectory, now: new Date(base + dayOffset * 24 * 60 * 60 * 1000) });
      }

      const outcome = runScheduledBackup(connection, {
        backups: backupSettings({ retention: { maxBackups: null }, schedule: { intervalDays: null } }),
        backupDirectory,
        now: new Date(base + 3 * 24 * 60 * 60 * 1000),
      });

      expect(outcome.status).toBe("created");
      if (outcome.status === "created") {
        expect(outcome.deletedBackupPaths).toEqual([]);
      }
      expect(readdirSync(backupDirectory)).toHaveLength(4);
    } finally {
      connection.close();
    }
  });
});

test("ignores files that are not managed backup snapshots", () => {
  withTemporaryDirectory((directory) => {
    const connection = openSqliteConnection(join(directory, "memory.sqlite"));
    const backupDirectory = join(directory, "backups");
    try {
      mkdirSync(backupDirectory, { recursive: true });
      writeFileSync(join(backupDirectory, "backup-not-managed.sqlite"), "not a snapshot");
      writeFileSync(join(backupDirectory, "notes.txt"), "unrelated");

      const outcome = runScheduledBackup(connection, {
        backups: backupSettings(),
        backupDirectory,
      });

      expect(outcome.status).toBe("created");
      if (outcome.status === "created") {
        expect(outcome.deletedBackupPaths).toEqual([]);
      }
      expect(readdirSync(backupDirectory)).toContain("backup-not-managed.sqlite");
    } finally {
      connection.close();
    }
  });
});

test("rejects invalid schedule settings before touching the backup directory", () => {
  withTemporaryDirectory((directory) => {
    const connection = openSqliteConnection(join(directory, "memory.sqlite"));
    const backupDirectory = join(directory, "backups");
    try {
      const invalidSettings: readonly ConfigV1["backups"][] = [
        backupSettings({ schedule: { intervalDays: 0 } }),
        backupSettings({ schedule: { intervalDays: 1.5 } }),
        backupSettings({ retention: { maxBackups: 0 } }),
        backupSettings({ enabled: undefined as unknown as boolean }),
      ];

      for (const backups of invalidSettings) {
        expect(() => runScheduledBackup(connection, { backups, backupDirectory })).toThrow();
      }
      expect(listDirectoryOrNone(backupDirectory)).toBeUndefined();
    } finally {
      connection.close();
    }
  });
});

test("reports which backups were deleted when retention pruning fails", () => {
  withTemporaryDirectory((directory) => {
    const backupDirectory = join(directory, "backups");
    const base = Date.parse("2026-09-01T00:00:00.000Z");
    const connection = openSqliteConnection(join(directory, "memory.sqlite"));
    try {
      createBackupSnapshot(connection, { backupDirectory, now: new Date(base) });
      createBackupSnapshot(connection, { backupDirectory, now: new Date(base + 24 * 60 * 60 * 1000) });
      chmodSync(backupDirectory, 0o500);

      expect(() => applyBackupRetention(backupDirectory, 1)).toThrow(BackupScheduleError);
    } finally {
      chmodSync(backupDirectory, 0o700);
      connection.close();
    }
  });
});

test("never deletes the protected backup even when retention sorts it oldest", () => {
  withTemporaryDirectory((directory) => {
    const connection = openSqliteConnection(join(directory, "memory.sqlite"));
    const backupDirectory = join(directory, "backups");
    try {
      const base = Date.parse("2026-09-01T00:00:00.000Z");
      createBackupSnapshot(connection, { backupDirectory, now: new Date(base) });
      const protectedSnapshot = createBackupSnapshot(connection, {
        backupDirectory,
        now: new Date(base),
      });

      const deleted = applyBackupRetention(backupDirectory, 1, protectedSnapshot.backupPath);

      expect(deleted).toHaveLength(1);
      expect(deleted[0]).not.toBe(protectedSnapshot.backupPath);
      expect(listDirectoryOrNone(backupDirectory)).toEqual([basename(protectedSnapshot.backupPath)]);
    } finally {
      connection.close();
    }
  });
});
