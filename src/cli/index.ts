#!/usr/bin/env bun

import { statSync } from "node:fs";
import { join } from "node:path";

import {
  applyBackupRetention,
  createBackupSnapshot,
  getBackupScheduleState,
  listManagedBackups,
  loadPackageConfig,
  openSqliteConnection,
  resolveManagedPaths,
} from "../core/index.js";
import { createCoreContext } from "../core/index.js";

const DEFAULT_DATABASE_FILE_NAME = "memory.sqlite";

export function getCliHelp(): string {
  return `${createCoreContext().packageName} CLI

Commands:
  backup          Create a managed backup snapshot now
  backup-status   Show managed backup schedule, retention, and snapshots

Options:
  --database <path>    Path to the SQLite database file
  --backup-dir <dir>   Override the managed backup directory
  --config <path>      Override the package configuration file
  --help               Show this help`;
}

type ParsedArgs = Readonly<{
  command: string | undefined;
  databasePath: string | undefined;
  backupDirectory: string | undefined;
  configFilePath: string | undefined;
}>;

function parseArgs(args: ReadonlyArray<string>): ParsedArgs {
  const values = new Map<string, string>();
  const positional: string[] = [];

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
    if (arg.startsWith("--")) {
      throw new Error(`Unknown option ${arg}.`);
    }
    positional.push(arg);
  }

  if (positional.length > 1) {
    throw new Error(`Unexpected extra arguments: ${positional.slice(1).join(" ")}.`);
  }

  return {
    command: positional[0],
    databasePath: values.get("--database"),
    backupDirectory: values.get("--backup-dir"),
    configFilePath: values.get("--config"),
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

export function main(args: ReadonlyArray<string> = Bun.argv.slice(2)): number {
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
