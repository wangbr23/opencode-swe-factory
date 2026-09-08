import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";

import { main } from "../../../src/cli/index.js";
import {
  HARD_DELETE_CONFIRMATION_PHRASE,
  createBackupSnapshot,
  indexConfirmedLessonEmbeddings,
  listManagedBackups,
  migrateSqliteSchema,
  openSqliteConnection,
  proposeLessonCandidate,
  releaseSchemaMigrations,
  retrieveConfirmedLessonsLexically,
  reviewLessonCandidate,
  runScheduledBackup,
  type SecretScanResult,
  type SqliteConnection,
} from "../../../src/core/index.js";
import { EMBEDDING_VECTOR_DIMENSIONS } from "../../../src/types/embedding-types.js";
import {
  FTS_TABLES,
  LESSON_DRAFT,
  RECALL_QUERY,
  USER_TABLES,
  retentionLimitedBackups,
} from "./hard-delete-values.js";

const mode = process.argv[2];
const databasePath = process.argv[3];
const backupDirectory = process.argv[4];
const extraArgument = process.argv[5];

const usage =
  "Usage: hard-delete-process.ts seed <db> <backupDir> | schedule <db> <backupDir> <isoNow> | " +
  "verify-backup <backupPath> | hard-delete <db> <backupDir> | inspect <db> <backupDir>";

const KNOWN_MODES = ["seed", "schedule", "verify-backup", "hard-delete", "inspect"];
if (mode === undefined || !KNOWN_MODES.includes(mode)) {
  throw new Error(usage);
}
if (mode === "verify-backup" && extraArgument === undefined) {
  throw new Error(usage);
}
if (mode !== "verify-backup" && (databasePath === undefined || backupDirectory === undefined)) {
  throw new Error(usage);
}

const clearScan: SecretScanResult = {
  disposition: "clear",
  findings: [],
  redactedText: "",
};

const constantEmbed = async (): Promise<Float32Array> => {
  const vector = new Float32Array(EMBEDDING_VECTOR_DIMENSIONS);
  vector[0] = 1;
  return vector;
};

function countRows(connection: SqliteConnection): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of [...USER_TABLES, ...FTS_TABLES]) {
    const row = connection.database
      .query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`)
      .get();
    counts[table] = row?.count ?? -1;
  }
  return counts;
}

function recallHits(connection: SqliteConnection): number {
  return retrieveConfirmedLessonsLexically(connection, {
    projectId: "hard-delete-journey",
    query: RECALL_QUERY,
  }).length;
}

function approveLesson(connection: SqliteConnection): void {
  const candidate = proposeLessonCandidate(connection, {
    projectId: null,
    scope: "global",
    draft: LESSON_DRAFT,
    secretScan: clearScan,
    reviewWindowDays: 36500,
  });
  reviewLessonCandidate(connection, { candidateId: candidate.id, decision: "approve" });
}

if (mode === "seed") {
  const connection = openSqliteConnection(databasePath!);
  try {
    migrateSqliteSchema(connection, releaseSchemaMigrations);
    approveLesson(connection);
    const indexing = await indexConfirmedLessonEmbeddings(connection, { embed: constantEmbed });
    if (indexing.embeddedCount !== 1 || indexing.failures.length !== 0) {
      throw new Error(`Seeded lesson was not indexed: ${JSON.stringify(indexing)}`);
    }
    const hits = recallHits(connection);
    if (hits !== 1) {
      throw new Error(`Expected the seeded lesson to be retrievable, got ${hits} hit(s).`);
    }
    createBackupSnapshot(connection, { backupDirectory: backupDirectory!, now: new Date("2026-09-01T00:00:00Z") });
    createBackupSnapshot(connection, { backupDirectory: backupDirectory!, now: new Date("2026-09-02T00:00:00Z") });
    createBackupSnapshot(connection, { backupDirectory: backupDirectory!, now: new Date("2026-09-03T00:00:00Z") });
    console.log(JSON.stringify({
      status: "seeded",
      counts: countRows(connection),
      recallHits: hits,
      backups: listManagedBackups(backupDirectory!).length,
    }));
  } finally {
    if (!connection.isClosed) {
      connection.close();
    }
  }
} else if (mode === "schedule") {
  const connection = openSqliteConnection(databasePath!);
  try {
    const outcome = runScheduledBackup(connection, {
      backups: retentionLimitedBackups(2),
      backupDirectory: backupDirectory!,
      now: new Date(extraArgument!),
    });
    console.log(JSON.stringify({
      status: outcome.status,
      createdBackupPath: outcome.status === "created" ? outcome.snapshot.backupPath : null,
      deletedBackupPaths: outcome.status === "created" ? outcome.deletedBackupPaths : [],
      backups: listManagedBackups(backupDirectory!),
    }));
  } finally {
    if (!connection.isClosed) {
      connection.close();
    }
  }
} else if (mode === "verify-backup") {
  const database = new Database(extraArgument!, { readonly: true });
  try {
    const integrity = database.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get();
    const lessonCount = database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM lessons").get();
    console.log(JSON.stringify({
      status: "verified",
      integrity: integrity?.integrity_check ?? "unknown",
      lessonCount: lessonCount?.count ?? -1,
    }));
  } finally {
    database.close(true);
  }
} else if (mode === "hard-delete") {
  const logged: string[] = [];
  const originalLog = console.log;
  console.log = (message: string) => {
    logged.push(message);
  };
  try {
    const code = await main(["hard-delete", "--database", databasePath!, "--backup-dir", backupDirectory!], {
      readLine: () => HARD_DELETE_CONFIRMATION_PHRASE,
    });
    console.log = originalLog;
    console.log(JSON.stringify({
      status: "hard-deleted",
      code,
      output: logged.join("\n"),
      backups: listManagedBackups(backupDirectory!),
    }));
  } catch (error) {
    console.log = originalLog;
    throw error;
  }
} else {
  const connection = openSqliteConnection(databasePath!);
  try {
    const walPath = `${connection.databasePath}-wal`;
    const backups = listManagedBackups(backupDirectory!);
    let baseline: { integrity: string; lessonCount: number } | null = null;
    if (backups.length === 1) {
      const database = new Database(backups[0]!.backupPath, { readonly: true });
      try {
        baseline = {
          integrity: database.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()!.integrity_check,
          lessonCount: database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM lessons").get()!.count,
        };
      } finally {
        database.close(true);
      }
    }
    console.log(JSON.stringify({
      status: "inspected",
      counts: countRows(connection),
      recallHits: recallHits(connection),
      freelistCount: connection.database.query<{ freelist_count: number }, []>("PRAGMA freelist_count").get()!.freelist_count,
      walBytes: existsSync(walPath) ? statSync(walPath).size : null,
      backupPaths: backups.map((backup) => backup.backupPath),
      baseline,
    }));
  } finally {
    if (!connection.isClosed) {
      connection.close();
    }
  }
}
