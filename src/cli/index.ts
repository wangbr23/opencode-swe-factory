#!/usr/bin/env bun

import { statSync } from "node:fs";
import { join } from "node:path";

import {
  applyBackupRetention,
  createBackupSnapshot,
  detectLessonDuplicatesAndConflicts,
  getBackupScheduleState,
  listManagedBackups,
  listPendingLessonCandidates,
  loadPackageConfig,
  migrateSqliteSchema,
  openSqliteConnection,
  releaseSchemaMigrations,
  resolveManagedPaths,
  reviewLessonCandidate,
  type LessonCandidateReviewOutcome,
  type LessonOverlapMatch,
} from "../core/index.js";
import { createCoreContext } from "../core/index.js";

const DEFAULT_DATABASE_FILE_NAME = "memory.sqlite";
const GLOBAL_DETECTION_PROJECT_ID = "__global_detection__";

export function getCliHelp(): string {
  return `${createCoreContext().packageName} CLI

Commands:
  backup          Create a managed backup snapshot now
  backup-status   Show managed backup schedule, retention, and snapshots
  review          List pending lesson candidates
  review <id>     Review a specific candidate with overlap analysis

Options:
  --database <path>          Path to the SQLite database file
  --backup-dir <dir>         Override the managed backup directory
  --config <path>            Override the package configuration file
  --acknowledge-secret-risk  Acknowledge low-confidence secret findings during approval
  --help                     Show this help`;
}

type ParsedArgs = Readonly<{
  command: string | undefined;
  commandArg: string | undefined;
  databasePath: string | undefined;
  backupDirectory: string | undefined;
  configFilePath: string | undefined;
  acknowledgeSecretRisk: boolean;
}>;

function parseArgs(args: ReadonlyArray<string>): ParsedArgs {
  const values = new Map<string, string>();
  const positional: string[] = [];
  let acknowledgeSecretRisk = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--database" || arg === "--backup-dir" || arg === "--config") {
      const value = args[index + 1];
      if (value === undefined) {
        throw new Error(`Option ${arg} requires a value.`);
      }
      values.set(arg, value);
      index += 1;
      continue;
    }
    if (arg === "--acknowledge-secret-risk") {
      acknowledgeSecretRisk = true;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown option ${arg}.`);
    }
    positional.push(arg);
  }

  if (positional.length > 2) {
    throw new Error(`Unexpected extra arguments: ${positional.slice(2).join(" ")}.`);
  }

  return {
    command: positional[0],
    commandArg: positional[1],
    databasePath: values.get("--database"),
    backupDirectory: values.get("--backup-dir"),
    configFilePath: values.get("--config"),
    acknowledgeSecretRisk,
  };
}

function resolveDatabasePath(databasePath: string | undefined): string {
  return databasePath ?? join(resolveManagedPaths().dataDirectory, DEFAULT_DATABASE_FILE_NAME);
}

function runBackupCommand(parsed: ParsedArgs): void {
  const backupDirectory = parsed.backupDirectory ?? resolveManagedPaths().backupDirectory;
  const config = loadPackageConfig(parsed.configFilePath === undefined ? {} : { configFilePath: parsed.configFilePath });
  const connection = openSqliteConnection(resolveDatabasePath(parsed.databasePath));
  try {
    const snapshot = createBackupSnapshot(connection, { backupDirectory });
    console.log(`Created backup ${snapshot.backupPath} (${snapshot.sizeBytes} bytes).`);

    if (config.backups.retention.maxBackups !== null) {
      const deleted = applyBackupRetention(backupDirectory, config.backups.retention.maxBackups, snapshot.backupPath);
      for (const deletedPath of deleted) {
        console.log(`Pruned old backup ${deletedPath}.`);
      }
    }
  } finally {
    connection.close();
  }
}

function runBackupStatusCommand(parsed: ParsedArgs): void {
  const backupDirectory = parsed.backupDirectory ?? resolveManagedPaths().backupDirectory;
  const config = loadPackageConfig(parsed.configFilePath === undefined ? {} : { configFilePath: parsed.configFilePath });
  const { enabled, schedule, retention } = config.backups;

  console.log(`Backups enabled: ${enabled ? "yes" : "no"}`);
  console.log(`Schedule interval: ${schedule.intervalDays === null ? "every check" : `${schedule.intervalDays} days`}`);
  console.log(`Retention limit: ${retention.maxBackups === null ? "unlimited" : `${retention.maxBackups} backups`}`);

  const scheduleState = getBackupScheduleState(backupDirectory, schedule.intervalDays);
  console.log(`Latest backup: ${scheduleState.latestBackupAt ?? "none"}`);
  console.log(`Next due: ${scheduleState.nextDueAt ?? (scheduleState.latestBackupAt === null ? "now" : "on next check")}`);

  const backups = listManagedBackups(backupDirectory);
  console.log(`Snapshots (${backups.length}):`);
  for (const backup of backups) {
    const sizeBytes = statSync(backup.backupPath).size;
    console.log(`  ${backup.createdAt}  ${backup.backupPath}  (${sizeBytes} bytes)`);
  }
}

function formatOverlapMatch(match: LessonOverlapMatch): string {
  const tag = match.relation === "duplicate" ? "DUPLICATE" : "CONFLICT";
  const bodyPct = `${Math.round(match.bodyOverlap * 100)}%`;
  return `    ${match.lessonId} (${match.scope}, ${tag}, body overlap: ${bodyPct})\n      "${match.title}"\n      ${match.body}`;
}

function printOutcome(outcome: LessonCandidateReviewOutcome): void {
  if (outcome.status === "approved") {
    console.log(`Approved as lesson ${outcome.lesson.lessonId} version ${outcome.lesson.version}.`);
  } else if (outcome.status === "rejected") {
    console.log(`Rejected and deleted candidate ${outcome.deletedCandidateId}.`);
  } else {
    console.log(`Deferred candidate ${outcome.candidateId} until ${outcome.expiresAt}.`);
  }
}

function readDecision(
  readLine: (question: string) => string | null,
): "approve" | "reject" | "defer" | "quit" {
  while (true) {
    const answer = readLine("\nDecision [a=approve, r=reject, d=defer, q=quit]: ");
    if (answer === null) return "quit";
    const normalized = answer.trim().toLowerCase();
    if (normalized === "a" || normalized === "approve") return "approve";
    if (normalized === "r" || normalized === "reject") return "reject";
    if (normalized === "d" || normalized === "defer") return "defer";
    if (normalized === "q" || normalized === "quit") return "quit";
    console.log("Invalid choice. Enter a, r, d, or q.");
  }
}

function runReviewListCommand(parsed: ParsedArgs): void {
  const connection = openSqliteConnection(resolveDatabasePath(parsed.databasePath));
  try {
    migrateSqliteSchema(connection, releaseSchemaMigrations);
    const candidates = listPendingLessonCandidates(connection);
    if (candidates.length === 0) {
      console.log("No pending lesson candidates.");
      return;
    }
    console.log(`Pending lesson candidates (${candidates.length}):\n`);
    for (const candidate of candidates) {
      const scope = candidate.scope === "project" ? `project:${candidate.projectId}` : "global";
      const ack = candidate.requiresAcknowledgment ? " [secrets: acknowledgment-required]" : "";
      console.log(`  ${candidate.id}  ${scope}  "${candidate.draft.title}"  expires ${candidate.expiresAt}${ack}`);
    }
    console.log("\nTo review a candidate: review <candidate-id>");
  } finally {
    connection.close();
  }
}

function runReviewCandidateCommand(
  parsed: ParsedArgs,
  readLine: (question: string) => string | null,
): void {
  const candidateId = parsed.commandArg!;
  const connection = openSqliteConnection(resolveDatabasePath(parsed.databasePath));
  try {
    migrateSqliteSchema(connection, releaseSchemaMigrations);
    const candidates = listPendingLessonCandidates(connection);
    const candidate = candidates.find((c) => c.id === candidateId);
    if (!candidate) {
      throw new Error(`Candidate ${candidateId} not found or expired.`);
    }

    const scope = candidate.scope === "project" ? `project (${candidate.projectId})` : "global";
    console.log(`\nCandidate ${candidate.id}:`);
    console.log(`  Title:     ${candidate.draft.title}`);
    console.log(`  Body:      ${candidate.draft.body}`);
    console.log(`  Rationale: ${candidate.draft.rationale}`);
    console.log(`  Scope:     ${scope}`);
    console.log(`  Created:   ${candidate.createdAt}`);
    console.log(`  Expires:   ${candidate.expiresAt}`);
    console.log(`  Secrets:   ${candidate.requiresAcknowledgment ? "acknowledgment-required" : "clear"}`);

    const detectionProjectId = candidate.projectId ?? GLOBAL_DETECTION_PROJECT_ID;
    const detection = detectLessonDuplicatesAndConflicts(connection, {
      draft: candidate.draft,
      projectId: detectionProjectId,
    });

    if (detection.matches.length > 0) {
      console.log(`\n  Overlapping lessons (${detection.matches.length}):`);
      for (const match of detection.matches) {
        console.log(formatOverlapMatch(match));
      }
    } else {
      console.log("\n  No overlapping lessons found.");
    }

    if (candidate.requiresAcknowledgment && !parsed.acknowledgeSecretRisk) {
      console.log("\n  This candidate has low-confidence secret findings.");
      console.log("  To approve, re-run with --acknowledge-secret-risk.");
    }

    const decision = readDecision(readLine);
    if (decision === "quit") {
      console.log("Skipped.");
      return;
    }

    const reviewInput = parsed.acknowledgeSecretRisk
      ? { candidateId: candidate.id, decision, acknowledgedSecretRisk: true as const }
      : { candidateId: candidate.id, decision };
    const outcome = reviewLessonCandidate(connection, reviewInput);
    printOutcome(outcome);
  } finally {
    connection.close();
  }
}

export function main(
  args: ReadonlyArray<string> = Bun.argv.slice(2),
  options?: Readonly<{ readLine?: (question: string) => string | null }>,
): number {
  if (args.includes("--help") || args.length === 0) {
    console.log(getCliHelp());
    return 0;
  }

  try {
    const parsed = parseArgs(args);
    if (parsed.command === "backup") {
      runBackupCommand(parsed);
    } else if (parsed.command === "backup-status") {
      runBackupStatusCommand(parsed);
    } else if (parsed.command === "review") {
      if (parsed.commandArg) {
        runReviewCandidateCommand(parsed, options?.readLine ?? prompt);
      } else {
        runReviewListCommand(parsed);
      }
    } else {
      console.error(`Unknown command: ${parsed.command ?? "(none)"}.`);
      return 1;
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Command failed: ${message}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exit(main());
}
