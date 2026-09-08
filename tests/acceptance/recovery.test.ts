import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LESSON_TITLE_V1,
  LESSON_TITLE_V2,
} from "./fixtures/recovery-values.js";

const PROCESS_FIXTURE = join(import.meta.dir, "fixtures", "recovery-process.ts");
const PROCESS_TIMEOUT_MS = 10_000;
const RELEASE_VERSION = 5;

type SeededResult = Readonly<{ status: "seeded"; schemaVersion: number }>;
type SupersededResult = Readonly<{ status: "superseded" }>;
type MigratedResult = Readonly<{ status: "migrated"; appliedVersions: ReadonlyArray<number>; schemaVersion: number }>;
type MigrationFailedResult = Readonly<{
  status: "failed";
  fromVersion: number;
  failedVersion: number | null;
  reason: string;
}>;
type BackedUpResult = Readonly<{ status: "backed-up"; backupPath: string; createdAt: string }>;
type CorruptedResult = Readonly<{ status: "corrupted" }>;
type VerifiedResult = Readonly<{ status: "healthy" | "corrupt"; backupPath: string; reason?: string }>;
type ExportedResult = Readonly<{ status: "exported"; tableCount: number }>;
type RestoredResult = Readonly<{ status: "restored"; sqliteSchemaVersion: number; totalRows: number }>;
type RestoreFailedResult = Readonly<{ status: "failed"; stage: string; reason: string }>;
type RecoveredResult = Readonly<{ status: "recovered" }>;
type LessonState = Readonly<{
  lessonId: string | null;
  activeVersion: number | null;
  versions: ReadonlyArray<Readonly<{ version: number; title: string; superseded_by_version: number | null }>>;
}>;
type InspectedResult = Readonly<{ status: "inspected"; userVersion: number; integrity: string; lesson: LessonState }>;
type UnreadableResult = Readonly<{ status: "unreadable"; reason: string }>;

type RecoveryResult =
  | SeededResult
  | SupersededResult
  | MigratedResult
  | MigrationFailedResult
  | BackedUpResult
  | CorruptedResult
  | VerifiedResult
  | ExportedResult
  | RestoredResult
  | RestoreFailedResult
  | RecoveredResult
  | InspectedResult
  | UnreadableResult;

type Mode =
  | "seed"
  | "supersede"
  | "migrate"
  | "backup"
  | "corrupt"
  | "verify-backup"
  | "export"
  | "restore"
  | "recover-from-backup"
  | "inspect";

function runProcess(mode: Mode, primaryPath: string, secondaryPath?: string): Promise<RecoveryResult> {
  const cmd = [process.execPath, PROCESS_FIXTURE, mode, primaryPath];
  if (secondaryPath !== undefined) {
    cmd.push(secondaryPath);
  }


  const child = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => child.kill(), PROCESS_TIMEOUT_MS);
  return Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).finally(() => clearTimeout(timeout)).then(([exitCode, stdout, stderr]) => {
    if (exitCode !== 0) {
      throw new Error(`Recovery process mode ${mode} exited with ${exitCode}: ${stderr}`);
    }
    const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
    if (parsed.status === "error") {
      throw new Error(`Recovery process mode ${mode} failed: ${stdout}`);
    }
    return parsed as RecoveryResult;
  });
}

function withRecoveryEnvironment(run: (paths: { databasePath: string; backupDirectory: string; exportPath: string }) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-recovery-"));
  const paths = {
    databasePath: join(directory, "memory.sqlite"),
    backupDirectory: join(directory, "backups"),
    exportPath: join(directory, "export.jsonl"),
  };
  return Promise.resolve(run(paths)).finally(() => {
    rmSync(directory, { recursive: true, force: true });
  });
}

test("a failed migration leaves the last known-good database untouched and a clean retry recovers", async () => {
  await withRecoveryEnvironment(async ({ databasePath }) => {
    const seeded = (await runProcess("seed", databasePath, "2")) as SeededResult;
    expect(seeded.schemaVersion).toBe(2);

    const failed = (await runProcess("migrate", databasePath, "4")) as MigrationFailedResult;
    expect(failed.status).toBe("failed");
    expect(failed.fromVersion).toBe(2);
    expect(failed.failedVersion).toBe(4);

    const beforeRetry = (await runProcess("inspect", databasePath)) as InspectedResult;
    expect(beforeRetry.userVersion).toBe(2);
    expect(beforeRetry.integrity).toBe("ok");
    expect(beforeRetry.lesson.activeVersion).toBe(1);
    expect(beforeRetry.lesson.versions).toHaveLength(1);

    const retried = (await runProcess("migrate", databasePath)) as MigratedResult;
    expect(retried.status).toBe("migrated");
    expect(retried.appliedVersions).toEqual([3, 4, 5]);

    const afterRetry = (await runProcess("inspect", databasePath)) as InspectedResult;
    expect(afterRetry.userVersion).toBe(RELEASE_VERSION);
    expect(afterRetry.integrity).toBe("ok");
    expect(afterRetry.lesson.activeVersion).toBe(1);
    expect(afterRetry.lesson.versions).toHaveLength(1);
  });
});

test("a corrupt latest backup is detected and recovery falls back to the last known-good snapshot", async () => {
  await withRecoveryEnvironment(async ({ databasePath, backupDirectory }) => {
    await runProcess("seed", databasePath, "5");
    const first = (await runProcess("backup", databasePath, backupDirectory)) as BackedUpResult;
    await runProcess("supersede", databasePath);
    const second = (await runProcess("backup", databasePath, backupDirectory)) as BackedUpResult;
    expect(second.createdAt >= first.createdAt).toBe(true);

    expect(((await runProcess("verify-backup", first.backupPath)) as VerifiedResult).status).toBe("healthy");
    expect(((await runProcess("verify-backup", second.backupPath)) as VerifiedResult).status).toBe("healthy");

    await runProcess("corrupt", second.backupPath);
    expect(((await runProcess("verify-backup", second.backupPath)) as VerifiedResult).status).toBe("corrupt");
    expect(((await runProcess("verify-backup", first.backupPath)) as VerifiedResult).status).toBe("healthy");

    await runProcess("corrupt", databasePath);
    expect(((await runProcess("inspect", databasePath)) as UnreadableResult).status).toBe("unreadable");

    await runProcess("recover-from-backup", first.backupPath, databasePath);

    const recovered = (await runProcess("inspect", databasePath)) as InspectedResult;
    expect(recovered.status).toBe("inspected");
    expect(recovered.userVersion).toBe(RELEASE_VERSION);
    expect(recovered.integrity).toBe("ok");
    expect(recovered.lesson.activeVersion).toBe(1);
    expect(recovered.lesson.versions).toHaveLength(1);

    const migrated = (await runProcess("migrate", databasePath)) as MigratedResult;
    expect(migrated.status).toBe("migrated");
    expect(migrated.appliedVersions).toEqual([]);
  });
});

test("a corrupted live database is recovered by transactional restore from the last known-good export", async () => {
  await withRecoveryEnvironment(async ({ databasePath, exportPath }) => {
    await runProcess("seed", databasePath, "5");
    await runProcess("supersede", databasePath);
    const exported = (await runProcess("export", databasePath, exportPath)) as ExportedResult;
    expect(exported.status).toBe("exported");
    expect(exported.tableCount).toBeGreaterThan(0);

    await runProcess("corrupt", databasePath);
    expect(((await runProcess("inspect", databasePath)) as UnreadableResult).status).toBe("unreadable");

    const restored = (await runProcess("restore", exportPath, databasePath)) as RestoredResult;
    expect(restored.status).toBe("restored");
    expect(restored.sqliteSchemaVersion).toBe(RELEASE_VERSION);
    expect(restored.totalRows).toBeGreaterThan(0);

    const recovered = (await runProcess("inspect", databasePath)) as InspectedResult;
    expect(recovered.userVersion).toBe(RELEASE_VERSION);
    expect(recovered.integrity).toBe("ok");
    expect(recovered.lesson.activeVersion).toBe(2);
    expect(recovered.lesson.versions).toEqual([
      { version: 1, title: LESSON_TITLE_V1, superseded_by_version: 2 },
      { version: 2, title: LESSON_TITLE_V2, superseded_by_version: null },
    ]);
  });
});

test("a failed restore refuses to overwrite the last known-good database", async () => {
  await withRecoveryEnvironment(async ({ databasePath, exportPath }) => {
    await runProcess("seed", databasePath, "5");
    await runProcess("export", databasePath, exportPath);

    await runProcess("corrupt", exportPath);

    const failed = (await runProcess("restore", exportPath, databasePath)) as RestoreFailedResult;
    expect(failed.status).toBe("failed");
    expect(failed.stage).toBe("parse");

    const intact = (await runProcess("inspect", databasePath)) as InspectedResult;
    expect(intact.userVersion).toBe(RELEASE_VERSION);
    expect(intact.integrity).toBe("ok");
    expect(intact.lesson.activeVersion).toBe(1);
    expect(intact.lesson.versions).toHaveLength(1);
  });
});
