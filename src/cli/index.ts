#!/usr/bin/env bun

import { statSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  PINNED_EMBEDDING_DTYPE,
  PINNED_EMBEDDING_MODEL_ID,
  PINNED_EMBEDDING_MODEL_REVISION,
  TASK_ACTIVITY_VALUES,
  TASK_COMPLEXITY_VALUES,
  TASK_DOMAIN_VALUES,
  TASK_RISK_VALUES,
  applyBackupRetention,
  correctTaskProfile,
  createBackupSnapshot,
  createHealthReport,
  detectLessonDuplicatesAndConflicts,
  exportDatabaseToJsonl,
  EXPLICIT_FEEDBACK_VALUES,
  featureTogglesForScope,
  getBackupScheduleState,
  getTaskWithProfile,
  HARD_DELETE_CONFIRMATION_PHRASE,
  hardDeleteAllStoredData,
  inspectLesson,
  installEmbeddingArtifacts,
  listManagedBackups,
  listPendingLessonCandidates,
  listTaskEvidenceSignals,
  loadPackageConfig,
  migrateSqliteSchema,
  openSqliteConnection,
  readLocalDiagnostics,
  recordExplicitFeedback,
  releaseSchemaMigrations,
  resolveEmbeddingArtifactDirectory,
  resolveManagedPaths,
  retrieveConfirmedLessonsLexically,
  reviewLessonCandidate,
  savePackageConfig,
  relinkProject,
  mergeProjects,
  restoreDatabaseFromJsonl,
  supersedeLesson,
  verifyEmbeddingArtifacts,
  type EmbeddingArtifactState,
  type ExplicitFeedbackKind,
  type HealthCheck,
  type LocalDiagnostic,
  type LessonCandidateReviewOutcome,
  type LessonOverlapMatch,
  type PersistedTaskProfile,
  type TaskActivity,
  type TaskComplexity,
  type TaskDomain,
  type TaskProfileCorrections,
  type TaskRisk,
} from "../core/index.js";
import { createCoreContext } from "../core/index.js";
import {
  checkOpenCodeCompatibility,
  OPENCODE_COMPATIBILITY_MANIFEST,
} from "../opencode/index.js";

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
  task <id>                 Inspect a task's active profile
  task <id> --activity ...  Correct a task's active profile (new version)
  feedback <task-id>        Record explicit feedback for a task
  evidence <task-id>        Inspect a task's recorded evidence signals
  relink <project-id>       Change a project's path or remote association
  merge <keep-id> <absorb-id>
                            Merge a duplicate project into the survivor
  export <path>             Export package-owned data as schema-versioned JSONL
  restore <path>            Replace the live database with a validated JSONL export
  hard-delete               Permanently delete all stored data and managed backups
  status                    Show diagnostics, paths, and compatibility status
  embeddings-install        Download and verify the pinned embedding artifacts
  embeddings-status         Show embedding artifact state and offline readiness

Options:
  --database <path>          Path to the SQLite database file
  --backup-dir <dir>         Override the managed backup directory
  --config <path>            Override the package configuration file
  --project <id>             Filter search results to a specific project
  --path <path>              New path for relink
  --remote <url>             New remote URL for relink
  --title <text>             New title for supersede
  --body <text>              New body for supersede
  --rationale <text>         New rationale for supersede
  --activity <value>         Corrected task activity, or "none" to clear
  --domain <value>           Corrected task domain, or "none" to clear
  --complexity <value>       Corrected task complexity (low, medium, high)
  --risk <value>             Corrected task risk (low, medium, high)
  --stack <values>           Corrected stack as comma-separated values, or "none" to clear
  --kind <value>             Explicit feedback kind (acceptance, correction, rework)
  --acknowledge-secret-risk  Acknowledge low-confidence secret findings during approval
  --help                     Show this help`;
}

type ParsedArgs = Readonly<{
  command: string | undefined;
  commandArg: string | undefined;
  secondCommandArg: string | undefined;
  databasePath: string | undefined;
  backupDirectory: string | undefined;
  configFilePath: string | undefined;
  projectId: string | undefined;
  newPath: string | undefined;
  newRemote: string | undefined;
  title: string | undefined;
  body: string | undefined;
  rationale: string | undefined;
  feedbackKind: string | undefined;
  activity: string | undefined;
  domain: string | undefined;
  complexity: string | undefined;
  risk: string | undefined;
  stack: string | undefined;
  acknowledgeSecretRisk: boolean;
}>;

function parseArgs(args: ReadonlyArray<string>): ParsedArgs {
  const values = new Map<string, string>();
  const positional: string[] = [];
  let acknowledgeSecretRisk = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--database" || arg === "--backup-dir" || arg === "--config" || arg === "--project" || arg === "--path" || arg === "--remote" || arg === "--title" || arg === "--body" || arg === "--rationale" || arg === "--kind" || arg === "--activity" || arg === "--domain" || arg === "--complexity" || arg === "--risk" || arg === "--stack") {
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
  const twoArgumentCommands = new Set(["merge"]);
  const commandArg = multiWordCommands.has(command ?? "")
    ? positional.slice(1).join(" ") || undefined
    : positional[1];
  const secondCommandArg = twoArgumentCommands.has(command ?? "") ? positional[2] : undefined;

  if (!multiWordCommands.has(command ?? "") && !twoArgumentCommands.has(command ?? "") && positional.length > 2) {
    throw new Error(`Unexpected extra arguments: ${positional.slice(2).join(" ")}.`);
  }
  if (twoArgumentCommands.has(command ?? "") && positional.length > 3) {
    throw new Error(`Unexpected extra arguments: ${positional.slice(3).join(" ")}.`);
  }

  return {
    command,
    commandArg,
    secondCommandArg,
    databasePath: values.get("--database"),
    backupDirectory: values.get("--backup-dir"),
    configFilePath: values.get("--config"),
    projectId: values.get("--project"),
    newPath: values.get("--path"),
    newRemote: values.get("--remote"),
    title: values.get("--title"),
    body: values.get("--body"),
    rationale: values.get("--rationale"),
    feedbackKind: values.get("--kind"),
    activity: values.get("--activity"),
    domain: values.get("--domain"),
    complexity: values.get("--complexity"),
    risk: values.get("--risk"),
    stack: values.get("--stack"),
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

function parseTaxonomyValue<T extends string>(value: string, allowed: ReadonlyArray<T>, option: string): T {
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new Error(`Invalid --${option} value "${value}". Allowed: ${allowed.join(", ")}.`);
  }
  return match;
}

function parseClearableTaxonomyValue<T extends string>(
  value: string,
  allowed: ReadonlyArray<T>,
  option: string,
): T | null {
  if (value === "none") {
    return null;
  }
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new Error(`Invalid --${option} value "${value}". Allowed: ${allowed.join(", ")}, or "none".`);
  }
  return match;
}

function buildProfileCorrections(parsed: ParsedArgs): TaskProfileCorrections | null {
  const corrections: {
    activity?: TaskActivity | null;
    domain?: TaskDomain | null;
    complexity?: TaskComplexity;
    risk?: TaskRisk;
    stack?: ReadonlyArray<string>;
  } = {};

  if (parsed.activity !== undefined) {
    corrections.activity = parseClearableTaxonomyValue(parsed.activity, TASK_ACTIVITY_VALUES, "activity");
  }
  if (parsed.domain !== undefined) {
    corrections.domain = parseClearableTaxonomyValue(parsed.domain, TASK_DOMAIN_VALUES, "domain");
  }
  if (parsed.complexity !== undefined) {
    corrections.complexity = parseTaxonomyValue(parsed.complexity, TASK_COMPLEXITY_VALUES, "complexity");
  }
  if (parsed.risk !== undefined) {
    corrections.risk = parseTaxonomyValue(parsed.risk, TASK_RISK_VALUES, "risk");
  }
  if (parsed.stack !== undefined) {
    corrections.stack =
      parsed.stack === "none"
        ? []
        : parsed.stack.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  }

  return Object.keys(corrections).length === 0 ? null : corrections;
}

function printActiveProfile(profile: PersistedTaskProfile): void {
  console.log(`\n  Active profile (v${profile.version}, ${profile.source}):`);
  console.log(`    Activity:    ${profile.activity ?? "(none)"}`);
  console.log(`    Domain:      ${profile.domain ?? "(none)"}`);
  console.log(`    Complexity:  ${profile.complexity}`);
  console.log(`    Risk:        ${profile.risk}`);
  console.log(`    Stack:       ${profile.stack.length > 0 ? profile.stack.join(", ") : "(none)"}`);
  console.log(`    Signals:     ${profile.signals.length > 0 ? profile.signals.join(", ") : "(none)"}`);
  console.log(`    Summary:     ${profile.summary}`);
  if (profile.supersededVersion !== null) {
    console.log(`    Supersedes:  v${profile.supersededVersion}`);
  }
}

function printProfileChange(label: string, before: string, after: string): void {
  if (before !== after) {
    console.log(`  ${label}: ${before} -> ${after}`);
  }
}

function runTaskCommand(parsed: ParsedArgs): void {
  const taskId = parsed.commandArg;
  if (!taskId) {
    throw new Error(
      "Usage: task <task-id> [--activity <value>] [--domain <value>] [--complexity <value>] [--risk <value>] [--stack <values>]",
    );
  }
  const corrections = buildProfileCorrections(parsed);

  const connection = openSqliteConnection(resolveDatabasePath(parsed.databasePath));
  try {
    migrateSqliteSchema(connection, releaseSchemaMigrations);

    if (corrections) {
      const before = getTaskWithProfile(connection, taskId);
      if (!before) {
        throw new Error(`Task ${taskId} not found.`);
      }
      if (!before.activeProfile) {
        throw new Error(`Task ${taskId} has no active profile to correct.`);
      }
      const result = correctTaskProfile(connection, { taskId, corrections });
      const after = getTaskWithProfile(connection, taskId)?.activeProfile;
      console.log(`\nCorrected task ${taskId} (v${result.supersededVersion} -> v${result.version}):`);
      if (after) {
        const b = before.activeProfile;
        printProfileChange("Activity", b.activity ?? "(none)", after.activity ?? "(none)");
        printProfileChange("Domain", b.domain ?? "(none)", after.domain ?? "(none)");
        printProfileChange("Complexity", b.complexity, after.complexity);
        printProfileChange("Risk", b.risk, after.risk);
        printProfileChange("Stack", b.stack.join(", ") || "(none)", after.stack.join(", ") || "(none)");
      }
      console.log(`\nActive profile version is now v${result.version}.`);
      return;
    }

    const task = getTaskWithProfile(connection, taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found.`);
    }
    console.log(`\nTask ${task.taskId}:`);
    console.log(`  Project:   ${task.projectId}`);
    console.log(`  Session:   ${task.sessionId}`);
    console.log(`  Boundary:  ${task.boundary}`);
    if (task.parentTaskId !== null) {
      console.log(`  Parent:    ${task.parentTaskId}`);
    }
    if (task.hostTaskId !== null) {
      console.log(`  Host:      ${task.hostTaskId}`);
    }
    console.log(`  Created:   ${task.createdAt}`);
    console.log(`  Updated:   ${task.updatedAt}`);
    console.log(`  Completed: ${task.completedAt ?? "not completed"}`);
    if (task.activeProfile) {
      printActiveProfile(task.activeProfile);
    } else {
      console.log("\n  No active profile.");
    }
  } finally {
    connection.close();
  }
}

function runFeedbackCommand(parsed: ParsedArgs): void {
  const taskId = parsed.commandArg;
  if (!taskId || parsed.feedbackKind === undefined) {
    throw new Error("Usage: feedback <task-id> --kind <acceptance|correction|rework>");
  }
  const feedbackKind = parseTaxonomyValue(
    parsed.feedbackKind,
    Object.keys(EXPLICIT_FEEDBACK_VALUES) as ExplicitFeedbackKind[],
    "kind",
  );

  const connection = openSqliteConnection(resolveDatabasePath(parsed.databasePath));
  try {
    migrateSqliteSchema(connection, releaseSchemaMigrations);
    const result = recordExplicitFeedback(connection, { taskId, feedbackKind });
    console.log(`\nRecorded ${result.feedbackKind} feedback for task ${result.taskId}.`);
    console.log(`  Signal: ${result.signalId}`);
    console.log(`  Value:  ${result.value}`);
    if (result.supersededSignalId !== undefined) {
      console.log(`  Retracted prior acceptance signal ${result.supersededSignalId}.`);
    }
  } finally {
    connection.close();
  }
}

function runEvidenceCommand(parsed: ParsedArgs): void {
  const taskId = parsed.commandArg;
  if (!taskId) {
    throw new Error("Usage: evidence <task-id>");
  }

  const connection = openSqliteConnection(resolveDatabasePath(parsed.databasePath));
  try {
    migrateSqliteSchema(connection, releaseSchemaMigrations);
    const signals = listTaskEvidenceSignals(connection, taskId);

    console.log(`\nEvidence for task ${taskId}:`);
    if (signals.length === 0) {
      console.log("  No outcome signals recorded.");
      return;
    }
    signals.forEach((signal, index) => {
      console.log(`\n  [${index + 1}] ${signal.id}`);
      console.log(`      Dimension:  ${signal.dimension}`);
      console.log(`      Kind:       ${signal.kind}`);
      console.log(`      Source:     ${signal.source}`);
      console.log(`      Value:      ${signal.value}`);
      console.log(`      Confidence: ${signal.confidence}`);
      console.log(`      Execution:  ${signal.executionId ?? "(none)"}`);
      if (signal.lessonId !== null) {
        console.log(`      Lesson:     ${signal.lessonId}@v${signal.lessonVersion}`);
      }
      console.log(`      Observed:   ${signal.observedAt}`);
      if (signal.supersedesSignalId !== null) {
        console.log(`      Retracts:   ${signal.supersedesSignalId}`);
      }
      if (signal.supersededBy !== null) {
        console.log(`      Retracted:  by ${signal.supersededBy}`);
      }
      const metadataEntries = Object.entries(signal.metadata);
      if (metadataEntries.length > 0) {
        const rendered = metadataEntries.map(([key, value]) => `${key}=${String(value)}`).join(", ");
        console.log(`      Metadata:   ${rendered}`);
      }
    });
  } finally {
    connection.close();
  }
}

function runRelinkCommand(parsed: ParsedArgs): void {
  const projectId = parsed.commandArg;
  if (!projectId) {
    throw new Error("Usage: relink <project-id> --path <new-path> [--remote <new-remote>]");
  }
  if (!parsed.newPath && !parsed.newRemote) {
    throw new Error("At least one of --path or --remote is required for relink.");
  }

  const connection = openSqliteConnection(resolveDatabasePath(parsed.databasePath));
  try {
    migrateSqliteSchema(connection, releaseSchemaMigrations);
    const relinkInput = {
      projectId,
      ...(parsed.newPath ? { newPath: parsed.newPath } : {}),
      ...(parsed.newRemote ? { newRemoteUrl: parsed.newRemote } : {}),
    };
    const result = relinkProject(connection, relinkInput);

    if (result.previousPath !== result.path) {
      console.log(`Path: ${result.previousPath} -> ${result.path}`);
    }
    if (result.previousRemoteHash !== result.remoteHash) {
      const prev = result.previousRemoteHash ?? "(none)";
      const next = result.remoteHash ?? "(none)";
      console.log(`Remote hash: ${prev} -> ${next}`);
    }
    console.log(`Relinked project ${result.projectId}.`);
  } finally {
    connection.close();
  }
}

function runMergeCommand(parsed: ParsedArgs): void {
  const survivorProjectId = parsed.commandArg;
  const absorbedProjectId = parsed.secondCommandArg;
  if (!survivorProjectId || !absorbedProjectId) {
    throw new Error("Usage: merge <survivor-project-id> <absorbed-project-id>");
  }

  const connection = openSqliteConnection(resolveDatabasePath(parsed.databasePath));
  try {
    migrateSqliteSchema(connection, releaseSchemaMigrations);
    const result = mergeProjects(connection, { survivorProjectId, absorbedProjectId });

    for (const pathAlias of result.transferredPathAliases) {
      console.log(`Path alias: ${pathAlias}`);
    }
    for (const remoteAlias of result.transferredRemoteAliases) {
      console.log(`Remote alias: ${remoteAlias}`);
    }
    if (result.adoptedRemoteHash) {
      console.log(`Adopted remote hash from the absorbed project.`);
    }
    console.log(
      `Moved ${result.movedLessons} lesson(s), ${result.movedPendingCandidates} pending candidate(s), and ${result.movedTasks} task(s).`,
    );
    if (result.droppedDocumentSources > 0) {
      console.log(
        `Dropped ${result.droppedDocumentSources} document source(s) (${result.droppedDocumentChunks} chunk(s)); the survivor reindexes them on next activation.`,
      );
    }
    console.log(`Project settings: ${result.keptSurvivorSettings ? "survivor settings kept" : "absorbed settings moved"}.`);
    console.log(`Merged ${result.absorbedProjectId} into ${result.survivorProjectId}.`);
  } finally {
    connection.close();
  }
}

function runStatusCommand(parsed: ParsedArgs): void {
  const context = createCoreContext();
  const paths = resolveManagedPaths();
  const dbPath = resolveDatabasePath(parsed.databasePath);

  console.log(`${context.packageName}`);
  console.log(`\nPaths:`);
  console.log(`  Database:  ${dbPath}`);
  console.log(`  Config:    ${paths.configFilePath}`);
  console.log(`  Data:      ${paths.dataDirectory}`);
  console.log(`  Cache:     ${paths.cacheDirectory}`);
  console.log(`  Backups:   ${paths.backupDirectory}`);

  let dbExists = false;
  try {
    statSync(dbPath);
    dbExists = true;
  } catch {}

  const checks: HealthCheck[] = [];

  console.log(`\nDatabase:`);
  if (dbExists) {
    console.log(`  Status: exists`);
    try {
      const connection = openSqliteConnection(dbPath);
      try {
        migrateSqliteSchema(connection, releaseSchemaMigrations);
        console.log(`  Migrations: up to date`);
        checks.push({ component: "database", status: "healthy" });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.log(`  Migrations: error — ${msg}`);
        checks.push({ component: "database", status: "degraded", reason: "migration-error" });
      } finally {
        connection.close();
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`  Connection: error — ${msg}`);
      checks.push({ component: "database", status: "unavailable", reason: "connection-error" });
    }
  } else {
    console.log(`  Status: not created yet`);
    checks.push({ component: "database", status: "healthy", reason: "not-created" });
  }

  console.log(`\nOpenCode compatibility:`);
  console.log(`  Minimum version: ${OPENCODE_COMPATIBILITY_MANIFEST.minimumVersion}`);
  console.log(`  Tested versions: ${OPENCODE_COMPATIBILITY_MANIFEST.testedVersions.join(", ")}`);

  const diagnosticsPath = join(paths.dataDirectory, "diagnostics.jsonl");
  let diagnosticEntries: ReadonlyArray<LocalDiagnostic>;
  try {
    diagnosticEntries = readLocalDiagnostics(diagnosticsPath);
  } catch {
    diagnosticEntries = [];
  }

  const report = createHealthReport(checks, diagnosticEntries);
  console.log(`\nHealth: ${report.status}`);
  for (const check of report.checks) {
    const reason = check.reason ? ` (${check.reason})` : "";
    console.log(`  ${check.component}: ${check.status}${reason}`);
  }
  if (diagnosticEntries.length > 0) {
    console.log(`\nRecent diagnostics (${diagnosticEntries.length}):`);
    for (const entry of diagnosticEntries.slice(-5)) {
      console.log(`  [${entry.severity}] ${entry.timestamp} ${entry.component}/${entry.code}: ${entry.summary}`);
    }
  } else {
    console.log(`\nNo diagnostics recorded.`);
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

const EMBEDDING_RUNTIME_SPECIFIER = "@huggingface/transformers";

function isEmbeddingRuntimeInstalled(): boolean {
  try {
    Bun.resolveSync(EMBEDDING_RUNTIME_SPECIFIER, import.meta.dir);
    return true;
  } catch {
    return false;
  }
}

function resolveEmbeddingsCommandContext(parsed: ParsedArgs) {
  const config = loadPackageConfig(resolveConfigPathInput(parsed));
  const artifactDirectory = resolveEmbeddingArtifactDirectory({
    cacheDirectory: resolveManagedPaths().cacheDirectory,
    configArtifactDirectory: config.embeddings.artifactDirectory,
  });
  return { config, artifactDirectory };
}

function printEmbeddingsPinnedModel(): void {
  console.log(`Pinned model: ${PINNED_EMBEDDING_MODEL_ID} (revision ${PINNED_EMBEDDING_MODEL_REVISION}, dtype ${PINNED_EMBEDDING_DTYPE})`);
}

function printEmbeddingsOfflineReadiness(
  artifactState: EmbeddingArtifactState,
  runtimeInstalled: boolean,
): void {
  if (artifactState === "verified" && runtimeInstalled) {
    console.log("Offline semantic retrieval: ready");
    return;
  }

  const reasons: string[] = [];
  if (artifactState !== "verified") {
    reasons.push(`run "embeddings-install" to install the pinned artifacts (state: ${artifactState})`);
  }
  if (!runtimeInstalled) {
    reasons.push(`install the optional ${EMBEDDING_RUNTIME_SPECIFIER} peer dependency`);
  }
  console.log(`Offline semantic retrieval: not ready (${reasons.join("; ")})`);
}

async function runEmbeddingsInstallCommand(parsed: ParsedArgs): Promise<void> {
  const { config, artifactDirectory } = resolveEmbeddingsCommandContext(parsed);

  const result = await installEmbeddingArtifacts({
    artifactDirectory,
    allowRemoteDownloads: config.embeddings.allowRemoteDownloads,
    privateModeEnabled: config.privateMode.enabled,
  });

  printEmbeddingsPinnedModel();
  console.log(`Artifact directory: ${result.artifactDirectory}`);
  console.log(`Downloaded ${result.downloadedFiles.length} file(s); skipped ${result.skippedFiles.length} already-verified file(s).`);
  console.log(`Artifacts: ${result.verification.state}`);
  for (const file of result.verification.files) {
    console.log(`  ${file.path}: ${file.state}`);
  }
  printEmbeddingsOfflineReadiness(result.verification.state, isEmbeddingRuntimeInstalled());
}

function runEmbeddingsStatusCommand(parsed: ParsedArgs): void {
  const { config, artifactDirectory } = resolveEmbeddingsCommandContext(parsed);
  const verification = verifyEmbeddingArtifacts({ artifactDirectory });
  const runtimeInstalled = isEmbeddingRuntimeInstalled();

  printEmbeddingsPinnedModel();
  console.log(`Artifact directory: ${artifactDirectory}`);
  console.log(`Artifacts: ${verification.state}`);
  for (const file of verification.files) {
    console.log(`  ${file.path}: ${file.state}`);
  }
  console.log(`Runtime: ${runtimeInstalled ? "installed" : "not installed"}`);
  printEmbeddingsOfflineReadiness(verification.state, runtimeInstalled);
  console.log(`Remote downloads: ${config.embeddings.allowRemoteDownloads ? "allowed" : "blocked by embeddings.allowRemoteDownloads"}`);
  console.log(`Private mode: ${config.privateMode.enabled ? "on (blocks artifact installs)" : "off"}`);
}

async function runExportCommand(parsed: ParsedArgs): Promise<void> {
  const outputArg = parsed.commandArg;
  if (!outputArg) {
    throw new Error("Usage: export <output-path>");
  }
  const outputPath = resolve(outputArg);
  const connection = openSqliteConnection(resolveDatabasePath(parsed.databasePath));
  try {
    const migration = migrateSqliteSchema(connection, releaseSchemaMigrations);
    if (migration.status === "newer-schema") {
      console.error(
        `Warning: database schema v${migration.schemaVersion} is newer than supported v${migration.supportedSchemaVersion}; exporting known tables only.`,
      );
    }
    const result = await exportDatabaseToJsonl(connection, outputPath);
    for (const table of result.tables) {
      const redacted = table.redactedFieldCount > 0 ? `, ${table.redactedFieldCount} field(s) redacted` : "";
      console.log(`  ${table.table}: ${table.rowCount} row(s)${redacted}`);
    }
    const totalRedactions = result.tables.reduce((sum, table) => sum + table.redactedFieldCount, 0);
    if (totalRedactions > 0) {
      console.log(`Redacted ${totalRedactions} field(s) with potential secrets.`);
    }
    console.log(`Exported schema v${result.sqliteSchemaVersion} data to ${result.outputPath}.`);
  } finally {
    connection.close();
  }
}

function runRestoreCommand(parsed: ParsedArgs): void {
  const inputArg = parsed.commandArg;
  if (!inputArg) {
    throw new Error("Usage: restore <input-path>");
  }
  const inputPath = resolve(inputArg);
  const databasePath = resolveDatabasePath(parsed.databasePath);

  console.log(`Restoring ${inputPath} into ${databasePath}.`);
  console.log("The export is rebuilt and validated in a temporary replacement");
  console.log("database first; the live database is replaced only if all checks pass.");

  const result = restoreDatabaseFromJsonl({ inputPath, databasePath });

  const totalRows = result.tables.reduce((sum, table) => sum + table.rowCount, 0);
  for (const table of result.tables) {
    if (table.rowCount > 0) {
      console.log(`  ${table.table}: ${table.rowCount} row(s)`);
    }
  }
  console.log(`Restored ${totalRows} row(s) at schema v${result.sqliteSchemaVersion} into ${result.databasePath}.`);
}

function runHardDeleteCommand(
  parsed: ParsedArgs,
  readLine: (question: string) => string | null,
): void {
  const backupDirectory = parsed.backupDirectory ?? resolveManagedPaths().backupDirectory;
  const connection = openSqliteConnection(resolveDatabasePath(parsed.databasePath));
  try {
    migrateSqliteSchema(connection, releaseSchemaMigrations);

    console.log("WARNING: hard deletion permanently removes ALL stored data:");
    console.log("  - confirmed lessons and their full version history");
    console.log("  - pending lesson candidates");
    console.log("  - document sources, chunks, FTS indexes, and embeddings");
    console.log("  - tasks, task profiles, execution profiles, and outcome signals");
    console.log("  - projects, aliases, and project settings");
    console.log("All managed backup snapshots will be purged and replaced with a single");
    console.log("clean baseline backup. All historical recovery points will be lost.");
    console.log("This cannot retract exports or copies you have already made, and cannot");
    console.log("guarantee physical erasure from SSD snapshots or external backups.");

    const answer = readLine(`\nType '${HARD_DELETE_CONFIRMATION_PHRASE}' to confirm: `);
    if (answer === null || answer.trim() !== HARD_DELETE_CONFIRMATION_PHRASE) {
      console.log("Aborted. Nothing was deleted.");
      return;
    }

    const report = hardDeleteAllStoredData(connection, { backupDirectory });

    const totalRows = report.tables.reduce((sum, table) => sum + table.deletedRowCount, 0);
    console.log(`\nDeleted ${totalRows} row(s) across ${report.tables.length} tables.`);
    console.log("Checkpointed and truncated the WAL, and vacuumed the database.");
    console.log(`Purged ${report.purgedBackupPaths.length} managed backup(s).`);
    console.log(`Created clean baseline backup ${report.baselineBackup.backupPath}.`);
    console.log("Note: exports or copies made earlier remain outside package control,");
    console.log("as do SSD snapshots and external backups.");
  } finally {
    connection.close();
  }
}

export async function main(
  args: ReadonlyArray<string> = Bun.argv.slice(2),
  options?: Readonly<{ readLine?: (question: string) => string | null }>,
): Promise<number> {
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
    } else if (parsed.command === "task") {
      runTaskCommand(parsed);
    } else if (parsed.command === "feedback") {
      runFeedbackCommand(parsed);
    } else if (parsed.command === "evidence") {
      runEvidenceCommand(parsed);
    } else if (parsed.command === "search") {
      runSearchCommand(parsed);
    } else if (parsed.command === "lesson") {
      runLessonCommand(parsed);
    } else if (parsed.command === "relink") {
      runRelinkCommand(parsed);
    } else if (parsed.command === "merge") {
      runMergeCommand(parsed);
    } else if (parsed.command === "export") {
      await runExportCommand(parsed);
    } else if (parsed.command === "restore") {
      runRestoreCommand(parsed);
    } else if (parsed.command === "hard-delete") {
      runHardDeleteCommand(parsed, options?.readLine ?? prompt);
    } else if (parsed.command === "status") {
      runStatusCommand(parsed);
    } else if (parsed.command === "embeddings-install") {
      await runEmbeddingsInstallCommand(parsed);
    } else if (parsed.command === "embeddings-status") {
      runEmbeddingsStatusCommand(parsed);
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
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
