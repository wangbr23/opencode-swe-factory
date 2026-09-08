import { runScheduledBackup } from "../core/backup/backup.js";
import { writeLocalDiagnostic } from "../core/diagnostics.js";
import { buildLessonMaintenanceDigest } from "../core/lessons/lesson-maintenance-digest.js";
import { evaluateAutomaticLessonProposal } from "../core/lessons/lesson-proposal-triggers.js";
import { cleanupExpiredCandidates } from "../core/lessons/lessons.js";
import { join } from "node:path";
import type { SqliteConnection } from "../core/db/sqlite.js";
import type { ConfigV1 } from "../types/config-types.js";
import type { ResolvedFeatureToggles } from "../types/feature-toggle-types.js";

/** In-process throttle for the O(n²)-bounded digest; real persistence is the data itself. */
export const DIGEST_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type BackgroundSchedulerState = {
  lastDigestRunAtMs: number | null;
};

export function createBackgroundSchedulerState(): BackgroundSchedulerState {
  return { lastDigestRunAtMs: null };
}

export type BackgroundMaintenanceInput = Readonly<{
  projectId: string;
  diagnosticsPath: string;
  /** Managed backup directory; when null the backup job is skipped. */
  backupDirectory: string | null;
  now?: Date;
}>;

export type BackgroundMaintenanceResult = Readonly<{
  backup: "created" | "not-due" | "disabled" | "skipped" | "failed";
  candidateCleanup: "ran" | "failed";
  digest: "clean" | "actionable" | "skipped" | "failed";
  proposal: "triggered" | "no-trigger" | "skipped" | "failed";
}>;

function writeDiagnostic(
  input: BackgroundMaintenanceInput,
  code: string,
  severity: "info" | "warning",
  summary: string,
): Promise<void> {
  return writeLocalDiagnostic(
    { component: "background", code, severity, summary },
    { filePath: join(input.diagnosticsPath, "diagnostics.jsonl") },
  ).then(() => undefined);
}

async function runBackupJob(
  connection: SqliteConnection,
  config: ConfigV1,
  input: BackgroundMaintenanceInput,
): Promise<"created" | "not-due" | "disabled" | "skipped" | "failed"> {
  if (input.backupDirectory === null) {
    return "skipped";
  }
  try {
    const outcome = runScheduledBackup(connection, {
      backups: config.backups,
      backupDirectory: input.backupDirectory,
      ...(input.now !== undefined ? { now: input.now } : {}),
    });
    return outcome.status;
  } catch {
    await writeDiagnostic(
      input,
      "backup-failed",
      "warning",
      "Scheduled backup failed; managed backups are unchanged.",
    );
    return "failed";
  }
}

function runCandidateCleanupJob(
  connection: SqliteConnection,
  input: BackgroundMaintenanceInput,
): "ran" | "failed" {
  try {
    cleanupExpiredCandidates(connection, ...(input.now !== undefined ? [{ now: input.now }] : []));
    return "ran";
  } catch {
    return "failed";
  }
}

async function runDigestJob(
  state: BackgroundSchedulerState,
  connection: SqliteConnection,
  config: ConfigV1,
  input: BackgroundMaintenanceInput,
): Promise<"clean" | "actionable" | "skipped" | "failed"> {
  const now = input.now ?? new Date();
  if (
    state.lastDigestRunAtMs !== null &&
    now.getTime() - state.lastDigestRunAtMs < DIGEST_MIN_INTERVAL_MS
  ) {
    return "skipped";
  }
  try {
    const digest = buildLessonMaintenanceDigest(connection, {
      now,
      ...(config.maintenance.staleLessonDays !== null
        ? { staleAfterDays: config.maintenance.staleLessonDays }
        : {}),
      ...(config.maintenance.unusedLessonDays !== null
        ? { unusedAfterDays: config.maintenance.unusedLessonDays }
        : {}),
    });
    state.lastDigestRunAtMs = now.getTime();
    const actionableCount =
      digest.stale.length +
      digest.unused.length +
      digest.duplicates.length +
      digest.potentialConflicts.length;
    if (actionableCount === 0) {
      return "clean";
    }
    await writeDiagnostic(
      input,
      "maintenance-digest",
      "info",
      `Maintenance digest: ${digest.activeLessonCount} active lessons, ${digest.stale.length} stale, ${digest.unused.length} unused, ${digest.duplicates.length} duplicate pairs, ${digest.potentialConflicts.length} potential conflicts. Inspect via the CLI.`,
    );
    return "actionable";
  } catch {
    return "failed";
  }
}

async function runProposalJob(
  connection: SqliteConnection,
  toggles: ResolvedFeatureToggles,
  input: BackgroundMaintenanceInput,
): Promise<"triggered" | "no-trigger" | "skipped" | "failed"> {
  if (toggles.privateMode || !toggles.recording) {
    return "skipped";
  }
  try {
    const result = await evaluateAutomaticLessonProposal(connection, {
      projectId: input.projectId,
      ...(input.now !== undefined ? { now: input.now } : {}),
    });
    if (result.status !== "triggered") {
      return "no-trigger";
    }
    await writeDiagnostic(
      input,
      "automatic-lesson-proposed",
      "info",
      `Automatic lesson proposal pending review: "${result.candidate.draft.title}" (candidate ${result.candidate.id}). Approve or reject via swe_factory_commit_lesson.`,
    );
    return "triggered";
  } catch {
    return "failed";
  }
}

/**
 * Runs the four scheduled background jobs (backup, candidate cleanup,
 * maintenance digest, successful-method proposals). Each job is independently
 * fail-open: a failure never prevents the others, and none of them can throw.
 */
export async function runBackgroundMaintenance(
  state: BackgroundSchedulerState,
  connection: SqliteConnection,
  config: ConfigV1,
  toggles: ResolvedFeatureToggles,
  input: BackgroundMaintenanceInput,
): Promise<BackgroundMaintenanceResult> {
  const [backup, proposal] = await Promise.all([
    runBackupJob(connection, config, input),
    runProposalJob(connection, toggles, input),
  ]);
  const candidateCleanup = runCandidateCleanupJob(connection, input);
  const digest = await runDigestJob(state, connection, config, input);
  return { backup, candidateCleanup, digest, proposal };
}

/**
 * Schedules the initial non-blocking background run at plugin initialization.
 * Failures are silently contained; the result is not surfaced to the host.
 */
export function scheduleInitialBackgroundMaintenance(
  state: BackgroundSchedulerState,
  connection: SqliteConnection,
  config: ConfigV1,
  toggles: ResolvedFeatureToggles,
  input: BackgroundMaintenanceInput,
): void {
  setTimeout(() => {
    void runBackgroundMaintenance(state, connection, config, toggles, input).catch(() => {
      // fail-open: background work must never break the host
    });
  }, 0);
}
