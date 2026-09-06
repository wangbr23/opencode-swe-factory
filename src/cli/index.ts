#!/usr/bin/env bun

import { statSync } from "node:fs";
import { join } from "node:path";

import {
  applyBackupRetention,
  createBackupSnapshot,
  detectLessonDuplicatesAndConflicts,
  featureTogglesForScope,
  getBackupScheduleState,
  inspectLesson,
  listManagedBackups,
  listPendingLessonCandidates,
  loadPackageConfig,
  migrateSqliteSchema,
  openSqliteConnection,
  releaseSchemaMigrations,
  resolveManagedPaths,
  retrieveConfirmedLessonsLexically,
  reviewLessonCandidate,
  savePackageConfig,
  supersedeLesson,
  type LessonCandidateReviewOutcome,
  type LessonOverlapMatch,
} from "../core/index.js";
import { createCoreContext } from "../core/index.js";

const DEFAULT_DATABASE_FILE_NAME = "memory.sqlite";
const GLOBAL_DETECTION_PROJECT_ID = "__global_detection__";

export function getCliHelp(): string {
  return `${createCoreContext().packageName} CLI

Commands:
  backup                    Create a managed backup snapshot now
  backup-status             Show managed backup schedule, retention, and snapshots
  config                    Show current configuration
  config get <path>         Read a configuration value by dot-path
  config set <path> <value> Set a configuration value by dot-path
  toggles                   Show resolved feature toggles per scope
  review                    List pending lesson candidates
  review <id>               Review a specific candidate with overlap analysis
  search <query>            Search confirmed lessons by keyword
  lesson <id>               Inspect a specific confirmed lesson
  supersede <id>            Replace a lesson's active version with new content

Options:
  --database <path>          Path to the SQLite database file
  --backup-dir <dir>         Override the managed backup directory
  --config <path>            Override the package configuration file
  --project <id>             Filter search results to a specific project
  --title <text>             New title for supersede
  --body <text>              New body for supersede
  --rationale <text>         New rationale for supersede
  --acknowledge-secret-risk  Acknowledge low-confidence secret findings during approval
  --help                     Show this help`;
}

type ParsedArgs = Readonly<{
  command: string | undefined;
  commandArg: string | undefined;
  databasePath: string | undefined;
  backupDirectory: string | undefined;
  configFilePath: string | undefined;
  projectId: string | undefined;
  title: string | undefined;
  body: string | undefined;
  rationale: string | undefined;
  acknowledgeSecretRisk: boolean;
}>;

function parseArgs(args: ReadonlyArray<string>): ParsedArgs {
  const values = new Map<string, string>();
  const positional: string[] = [];
  let acknowledgeSecretRisk = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--database" || arg === "--backup-dir" || arg === "--config" || arg === "--project" || arg === "--title" || arg === "--body" || arg === "--rationale") {
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

  const command = positional[0];
  const multiWordCommands = new Set(["search", "config"]);
  const commandArg = multiWordCommands.has(command ?? "")
    ? positional.slice(1).join(" ") || undefined
    : positional[1];

  if (!multiWordCommands.has(command ?? "") && positional.length > 2) {
    throw new Error(`Unexpected extra arguments: ${positional.slice(2).join(" ")}.`);
  }

  return {
    command,
    commandArg,
    databasePath: values.get("--database"),
    backupDirectory: values.get("--backup-dir"),
    configFilePath: values.get("--config"),
    projectId: values.get("--project"),
    title: values.get("--title"),
    body: values.get("--body"),
    rationale: values.get("--rationale"),
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

function runSearchCommand(parsed: ParsedArgs): void {
  const query = parsed.commandArg;
  if (!query) {
    throw new Error("Usage: search <query>");
  }
  const projectId = parsed.projectId ?? GLOBAL_DETECTION_PROJECT_ID;
  const connection = openSqliteConnection(resolveDatabasePath(parsed.databasePath));
  try {
    migrateSqliteSchema(connection, releaseSchemaMigrations);
    const results = retrieveConfirmedLessonsLexically(connection, { projectId, query });
    if (results.length === 0) {
      console.log("No matching lessons found.");
      return;
    }
    console.log(`Found ${results.length} lesson(s):\n`);
    for (const result of results) {
      const scope = result.scope === "project" ? `project:${result.projectId}` : "global";
      console.log(`  ${result.lessonId}  v${result.version}  ${scope}`);
      console.log(`    "${result.title}"`);
      console.log(`    ${result.body}\n`);
    }
  } finally {
    connection.close();
  }
}

function runLessonCommand(parsed: ParsedArgs): void {
  const lessonId = parsed.commandArg;
  if (!lessonId) {
    throw new Error("Usage: lesson <lesson-id>");
  }
  const connection = openSqliteConnection(resolveDatabasePath(parsed.databasePath));
  try {
    migrateSqliteSchema(connection, releaseSchemaMigrations);
    const inspection = inspectLesson(connection, lessonId);
    if (!inspection) {
      throw new Error(`Lesson ${lessonId} not found.`);
    }

    const scope = inspection.scope === "project" ? `project (${inspection.projectId})` : "global";
    console.log(`\nLesson ${inspection.lessonId}:`);
    console.log(`  Scope:      ${scope}`);
    console.log(`  Versions:   ${inspection.versionCount}`);
    console.log(`  Created:    ${inspection.createdAt}`);
    console.log(`  Updated:    ${inspection.updatedAt}`);

    if (inspection.activeVersion) {
      const v = inspection.activeVersion;
      console.log(`\n  Active version (v${v.version}):`);
      console.log(`    Title:     ${v.title}`);
      console.log(`    Body:      ${v.body}`);
      console.log(`    Rationale: ${v.rationale}`);
      if (v.supersededByVersion !== null) {
        console.log(`    Superseded by: v${v.supersededByVersion}`);
      }
    } else {
      console.log("\n  No active version.");
    }
  } finally {
    connection.close();
  }
}

function runSupersedeCommand(parsed: ParsedArgs): void {
  const lessonId = parsed.commandArg;
  if (!lessonId) {
    throw new Error("Usage: supersede <lesson-id> --title <text> --body <text> --rationale <text>");
  }
  if (!parsed.title || !parsed.body || !parsed.rationale) {
    throw new Error("All of --title, --body, and --rationale are required for supersede.");
  }

  const connection = openSqliteConnection(resolveDatabasePath(parsed.databasePath));
  try {
    migrateSqliteSchema(connection, releaseSchemaMigrations);

    const inspection = inspectLesson(connection, lessonId);
    if (!inspection) {
      throw new Error(`Lesson ${lessonId} not found.`);
    }
    if (!inspection.activeVersion) {
      throw new Error(`Lesson ${lessonId} has no active version to supersede.`);
    }

    const current = inspection.activeVersion;
    console.log(`\nSuperseding lesson ${lessonId} (v${current.version}):`);
    console.log(`  Current title: ${current.title}`);
    console.log(`  Current body:  ${current.body}`);
    console.log(`  New title:     ${parsed.title}`);
    console.log(`  New body:      ${parsed.body}`);

    const result = supersedeLesson(connection, {
      lessonId,
      draft: {
        title: parsed.title,
        body: parsed.body,
        rationale: parsed.rationale,
        applicability: current.applicability,
        provenance: current.provenance,
      },
    });

    console.log(`\nSuperseded v${result.supersededVersion} with v${result.version}. Active version is now v${result.activeVersion}.`);
  } finally {
    connection.close();
  }
}

function resolveConfigPathInput(parsed: ParsedArgs) {
  return parsed.configFilePath === undefined ? {} : { configFilePath: parsed.configFilePath };
}

function getByDotPath(obj: unknown, path: string): unknown {
  const segments = path.split(".");
  let current: unknown = obj;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function setByDotPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i]!;
    const next = current[segment];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      throw new Error(`Path "${segments.slice(0, i + 1).join(".")}" is not an object.`);
    }
    current = next as Record<string, unknown>;
  }
  const lastSegment = segments[segments.length - 1]!;
  if (!(lastSegment in current)) {
    throw new Error(`Unknown config path "${path}".`);
  }
  current[lastSegment] = value;
}

function parseConfigValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  const asNumber = Number(raw);
  if (!Number.isNaN(asNumber) && raw.length > 0) return asNumber;
  return raw;
}

function runConfigCommand(parsed: ParsedArgs): void {
  const configPathInput = resolveConfigPathInput(parsed);

  if (!parsed.commandArg) {
    const config = loadPackageConfig(configPathInput);
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  const parts = parsed.commandArg.split(" ");
  const subcommand = parts[0];

  if (subcommand === "get") {
    const keyPath = parts[1];
    if (!keyPath || parts.length !== 2) {
      throw new Error("Usage: config get <path>");
    }
    const config = loadPackageConfig(configPathInput);
    const value = getByDotPath(config, keyPath);
    if (value === undefined) {
      throw new Error(`Unknown config path "${keyPath}".`);
    }
    console.log(typeof value === "object" ? JSON.stringify(value, null, 2) : String(value));
    return;
  }

  if (subcommand === "set") {
    const keyPath = parts[1];
    const rawValue = parts[2];
    if (!keyPath || rawValue === undefined || parts.length !== 3) {
      throw new Error("Usage: config set <path> <value>");
    }
    const config = loadPackageConfig(configPathInput);
    const mutable = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
    setByDotPath(mutable, keyPath, parseConfigValue(rawValue));
    savePackageConfig(mutable, configPathInput);
    console.log(`Set ${keyPath} = ${rawValue}`);
    return;
  }

  throw new Error(`Unknown config subcommand "${subcommand}". Use: config, config get <path>, config set <path> <value>.`);
}

function runTogglesCommand(parsed: ParsedArgs): void {
  const config = loadPackageConfig(resolveConfigPathInput(parsed));

  console.log(`Private mode: ${config.privateMode.enabled ? "on" : "off"}\n`);

  for (const scope of ["global", "project", "session"] as const) {
    const toggles = featureTogglesForScope(config, scope);
    console.log(`${scope}:`);
    console.log(`  retrieval:      ${toggles.retrieval ? "enabled" : "disabled"}`);
    console.log(`  recording:      ${toggles.recording ? "enabled" : "disabled"}`);
    console.log(`  modelTelemetry: ${toggles.modelTelemetry ? "enabled" : "disabled"}`);
    console.log(`  routing:        ${toggles.routing ? "enabled" : "disabled"}`);
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
    } else if (parsed.command === "config") {
      runConfigCommand(parsed);
    } else if (parsed.command === "toggles") {
      runTogglesCommand(parsed);
    } else if (parsed.command === "supersede") {
      runSupersedeCommand(parsed);
    } else if (parsed.command === "search") {
      runSearchCommand(parsed);
    } else if (parsed.command === "lesson") {
      runLessonCommand(parsed);
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
