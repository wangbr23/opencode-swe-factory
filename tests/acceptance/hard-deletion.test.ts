import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FTS_TABLES, USER_TABLES } from "./fixtures/hard-delete-values.js";

const PROCESS_FIXTURE = join(import.meta.dir, "fixtures", "hard-delete-process.ts");
const PROCESS_TIMEOUT_MS = 10_000;

type CountSummary = Readonly<Record<string, number>>;
type ManagedBackupSummary = Readonly<{ backupPath: string; createdAt: string }>;

type SeededResult = Readonly<{
  status: "seeded";
  counts: CountSummary;
  recallHits: number;
  backups: number;
}>;
type ScheduleResult = Readonly<{
  status: "created";
  createdBackupPath: string;
  deletedBackupPaths: ReadonlyArray<string>;
  backups: ReadonlyArray<ManagedBackupSummary>;
}>;
type VerifiedResult = Readonly<{ status: "verified"; integrity: string; lessonCount: number }>;
type HardDeletedResult = Readonly<{
  status: "hard-deleted";
  code: number;
  output: string;
  backups: ReadonlyArray<ManagedBackupSummary>;
}>;
type InspectedResult = Readonly<{
  status: "inspected";
  counts: CountSummary;
  recallHits: number;
  freelistCount: number;
  walBytes: number | null;
  backupPaths: ReadonlyArray<string>;
  baseline: Readonly<{ integrity: string; lessonCount: number }> | null;
}>;

type HardDeleteResult = SeededResult | ScheduleResult | VerifiedResult | HardDeletedResult | InspectedResult;

type Mode = "seed" | "schedule" | "verify-backup" | "hard-delete" | "inspect";

function runProcess(mode: Mode, primaryPath: string, secondaryPath: string, extra?: string): Promise<HardDeleteResult> {
  const cmd = [process.execPath, PROCESS_FIXTURE, mode, primaryPath, secondaryPath];
  if (extra !== undefined) {
    cmd.push(extra);
  }


  const child = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => child.kill(), PROCESS_TIMEOUT_MS);
  return Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).finally(() => clearTimeout(timeout)).then(([exitCode, stdout, stderr]) => {
    if (exitCode !== 0) {
      throw new Error(`Hard-delete process mode ${mode} exited with ${exitCode}: ${stderr}`);
    }
    const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
    if (parsed.status === "error") {
      throw new Error(`Hard-delete process mode ${mode} failed: ${stdout}`);
    }
    return parsed as HardDeleteResult;
  });
}

function withHardDeleteEnvironment(run: (paths: { databasePath: string; backupDirectory: string }) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-hard-delete-"));
  const paths = {
    databasePath: join(directory, "memory.sqlite"),
    backupDirectory: join(directory, "backups"),
  };
  return Promise.resolve(run(paths)).finally(() => {
    rmSync(directory, { recursive: true, force: true });
  });
}

test("hard deletion through the CLI destroys every recovery point and leaves nothing retrievable", async () => {
  await withHardDeleteEnvironment(async ({ databasePath, backupDirectory }) => {
    const seeded = (await runProcess("seed", databasePath, backupDirectory)) as SeededResult;
    expect(seeded.counts.lessons).toBe(1);
    expect(seeded.counts.lesson_version_embeddings).toBe(1);
    expect(seeded.counts.lesson_versions_fts).toBe(1);
    expect(seeded.recallHits).toBe(1);
    expect(seeded.backups).toBe(3);

    const beforeDeletion = (await runProcess("inspect", databasePath, backupDirectory)) as InspectedResult;
    expect(beforeDeletion.backupPaths).toHaveLength(3);
    expect(beforeDeletion.baseline).toBeNull();

    const newestBackup = beforeDeletion.backupPaths[2]!;
    const recoveryPoint = (await runProcess("verify-backup", databasePath, backupDirectory, newestBackup)) as VerifiedResult;
    expect(recoveryPoint.integrity).toBe("ok");
    expect(recoveryPoint.lessonCount).toBe(1);

    const deleted = (await runProcess("hard-delete", databasePath, backupDirectory)) as HardDeletedResult;
    expect(deleted.code).toBe(0);
    expect(deleted.output).toContain("All historical recovery points will be lost.");
    expect(deleted.output).toContain("This cannot retract exports or copies you have already made");
    expect(deleted.output).toContain("Purged 3 managed backup(s).");
    expect(deleted.output).toContain("Created clean baseline backup");
    expect(deleted.backups).toHaveLength(1);

    const afterDeletion = (await runProcess("inspect", databasePath, backupDirectory)) as InspectedResult;
    for (const table of [...USER_TABLES, ...FTS_TABLES]) {
      expect(afterDeletion.counts[table]).toBe(0);
    }
    expect(afterDeletion.recallHits).toBe(0);
    expect(afterDeletion.freelistCount).toBe(0);
    expect(afterDeletion.walBytes === null || afterDeletion.walBytes === 0).toBe(true);
    expect(afterDeletion.backupPaths).toHaveLength(1);
    expect(afterDeletion.baseline).toEqual({ integrity: "ok", lessonCount: 0 });
  });
});

test("retention keeps the backup directory bounded across sessions and hard delete finishes the purge", async () => {
  await withHardDeleteEnvironment(async ({ databasePath, backupDirectory }) => {
    await runProcess("seed", databasePath, backupDirectory);

    for (const run of [4, 5, 6, 7]) {
      const scheduled = (await runProcess(
        "schedule",
        databasePath,
        backupDirectory,
        `2026-09-0${run}T00:00:00Z`,
      )) as ScheduleResult;
      expect(scheduled.status).toBe("created");
      expect(scheduled.backups).toHaveLength(2);
      expect(scheduled.createdBackupPath).toBe(scheduled.backups[1]!.backupPath);
      expect(scheduled.deletedBackupPaths).toHaveLength(run === 4 ? 2 : 1);
    }

    const inspected = (await runProcess("inspect", databasePath, backupDirectory)) as InspectedResult;
    expect(inspected.backupPaths).toHaveLength(2);
    expect(inspected.baseline).toBeNull();

    const newestBackup = inspected.backupPaths[1]!;
    const recoveryPoint = (await runProcess("verify-backup", databasePath, backupDirectory, newestBackup)) as VerifiedResult;
    expect(recoveryPoint.integrity).toBe("ok");
    expect(recoveryPoint.lessonCount).toBe(1);

    const deleted = (await runProcess("hard-delete", databasePath, backupDirectory)) as HardDeletedResult;
    expect(deleted.code).toBe(0);
    expect(deleted.output).toContain("Purged 2 managed backup(s).");
    expect(deleted.backups).toHaveLength(1);

    const afterDeletion = (await runProcess("inspect", databasePath, backupDirectory)) as InspectedResult;
    for (const table of [...USER_TABLES, ...FTS_TABLES]) {
      expect(afterDeletion.counts[table]).toBe(0);
    }
    expect(afterDeletion.recallHits).toBe(0);
    expect(afterDeletion.backupPaths).toHaveLength(1);
    expect(afterDeletion.baseline).toEqual({ integrity: "ok", lessonCount: 0 });
  });
});
