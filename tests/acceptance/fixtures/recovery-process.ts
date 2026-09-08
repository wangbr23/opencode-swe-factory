import { copyFileSync, existsSync, unlinkSync, writeFileSync } from "node:fs";

import {
  DatabaseRestoreError,
  exportDatabaseToJsonl,
  migrateSqliteSchema,
  openSqliteConnection,
  releaseSchemaMigrations,
  restoreDatabaseFromJsonl,
  SqliteMigrationError,
  verifyBackupIntegrity,
  createBackupSnapshot,
  type SchemaMigration,
} from "../../../src/core/index.js";
import {
  LESSON_BODY_V1,
  LESSON_RATIONALE,
  LESSON_TITLE_V1,
  LESSON_TITLE_V2,
  SEED_TIMESTAMP,
} from "./recovery-values.js";

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function fail(payload: Record<string, unknown>): never {
  emit({ status: "error", ...payload });
  process.exit(1);
}

function seedLesson(databasePath: string, schemaVersion: number): void {
  const connection = openSqliteConnection(databasePath);
  try {
    migrateSqliteSchema(connection, releaseSchemaMigrations.slice(0, schemaVersion));
    connection.database.run(
      "INSERT INTO projects (id, path, created_at, updated_at) VALUES ('project-1', '/repos/recovery-project', ?, ?)",
      [SEED_TIMESTAMP, SEED_TIMESTAMP],
    );
    connection.database.run(
      "INSERT INTO lessons (id, project_id, scope, active_version, created_at, updated_at) VALUES ('lesson-1', 'project-1', 'project', 1, ?, ?)",
      [SEED_TIMESTAMP, SEED_TIMESTAMP],
    );
    connection.database.run(
      "INSERT INTO lesson_versions (lesson_id, version, title, body, rationale, applicability_json, provenance_json, superseded_by_version, created_at) VALUES ('lesson-1', 1, ?, ?, ?, '[]', '[]', NULL, ?)",
      [LESSON_TITLE_V1, LESSON_BODY_V1, LESSON_RATIONALE, SEED_TIMESTAMP],
    );
    emit({ status: "seeded", schemaVersion });
  } finally {
    connection.close();
  }
}

function supersedeLesson(databasePath: string): void {
  const connection = openSqliteConnection(databasePath);
  try {
    connection.database.run(
      "INSERT INTO lesson_versions (lesson_id, version, title, body, rationale, applicability_json, provenance_json, superseded_by_version, created_at) VALUES ('lesson-1', 2, ?, ?, ?, '[]', '[]', NULL, ?)",
      [LESSON_TITLE_V2, LESSON_BODY_V1, LESSON_RATIONALE, SEED_TIMESTAMP],
    );
    connection.database.run("UPDATE lesson_versions SET superseded_by_version = 2 WHERE lesson_id = 'lesson-1' AND version = 1");
    connection.database.run("UPDATE lessons SET active_version = 2 WHERE id = 'lesson-1'");
    emit({ status: "superseded" });
  } finally {
    connection.close();
  }
}

function migrate(databasePath: string, failAtVersion: number | undefined): void {
  const migrations: readonly SchemaMigration[] = failAtVersion
    ? [
        ...releaseSchemaMigrations.slice(0, failAtVersion - 1),
        {
          version: failAtVersion,
          name: `injected failure at ${failAtVersion}`,
          migrate(database) {
            database.run(`CREATE TABLE injected_v${failAtVersion} (id INTEGER PRIMARY KEY)`);
            throw new Error("injected migration failure");
          },
        },
      ]
    : releaseSchemaMigrations;

  const connection = openSqliteConnection(databasePath);
  try {
    const result = migrateSqliteSchema(connection, migrations);
    emit({ status: "migrated", appliedVersions: result.appliedVersions, schemaVersion: result.schemaVersion });
  } catch (error) {
    if (error instanceof SqliteMigrationError) {
      emit({
        status: "failed",
        fromVersion: error.fromVersion,
        failedVersion: error.failedMigration?.version ?? null,
        reason: error.message,
      });
      return;
    }
    throw error;
  } finally {
    connection.close();
  }
}

function createBackup(databasePath: string, backupDirectory: string): void {
  const connection = openSqliteConnection(databasePath);
  try {
    const snapshot = createBackupSnapshot(connection, { backupDirectory });
    emit({ status: "backed-up", backupPath: snapshot.backupPath, createdAt: snapshot.createdAt });
  } finally {
    connection.close();
  }
}

function corruptFile(filePath: string): void {
  const bytes = Buffer.from(Array.from({ length: 16 }, (_, index) => (index % 2 === 0 ? 0x43 : 0x4b)));
  writeFileSync(filePath, bytes);
  emit({ status: "corrupted", filePath });
}

function verifyBackup(backupPath: string): void {
  try {
    verifyBackupIntegrity(backupPath);
    emit({ status: "healthy", backupPath });
  } catch (error) {
    emit({ status: "corrupt", backupPath, reason: error instanceof Error ? error.message : String(error) });
  }
}

async function exportDatabase(databasePath: string, exportPath: string): Promise<void> {
  const connection = openSqliteConnection(databasePath);
  try {
    const result = await exportDatabaseToJsonl(connection, exportPath);
    emit({ status: "exported", tableCount: result.tables.length, exportPath });
  } finally {
    connection.close();
  }
}

function restore(exportPath: string, databasePath: string): void {
  try {
    const result = restoreDatabaseFromJsonl({ inputPath: exportPath, databasePath });
    emit({
      status: "restored",
      sqliteSchemaVersion: result.sqliteSchemaVersion,
      totalRows: result.tables.reduce((sum, table) => sum + table.rowCount, 0),
    });
  } catch (error) {
    if (error instanceof DatabaseRestoreError) {
      emit({ status: "failed", stage: error.stage, reason: error.message });
      return;
    }
    throw error;
  }
}

function recoverFromBackup(backupPath: string, databasePath: string): void {
  copyFileSync(backupPath, databasePath);
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${databasePath}${suffix}`;
    if (existsSync(sidecar)) {
      unlinkSync(sidecar);
    }
  }
  emit({ status: "recovered", databasePath });
}

function inspect(databasePath: string): void {
  let connection;
  try {
    connection = openSqliteConnection(databasePath);
  } catch (error) {
    emit({ status: "unreadable", reason: error instanceof Error ? error.message : String(error) });
    return;
  }
  try {
    const lesson = connection.database
      .query<{ id: string; active_version: number | null }, []>("SELECT id, active_version FROM lessons WHERE id = 'lesson-1'")
      .get();
    const versions = connection.database
      .query<{ version: number; title: string; superseded_by_version: number | null }, []>(
        "SELECT version, title, superseded_by_version FROM lesson_versions WHERE lesson_id = 'lesson-1' ORDER BY version",
      )
      .all();
    const integrity = connection.database
      .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
      .all()
      .map((row) => row.integrity_check)
      .join(";");
    const userVersion = connection.database.query<{ user_version: number }, []>("PRAGMA user_version").get()!
      .user_version;
    emit({
      status: "inspected",
      userVersion,
      integrity,
      lesson: { lessonId: lesson?.id ?? null, activeVersion: lesson?.active_version ?? null, versions },
    });
  } finally {
    connection.close();
  }
}

const mode = process.argv[2];
const primaryPath = process.argv[3];
const secondaryPath = process.argv[4];

if (!mode || !primaryPath) {
  fail({ reason: "usage: recovery-process <mode> <path> [args]" });
}

switch (mode) {
  case "seed":
    seedLesson(primaryPath, Number(secondaryPath ?? "5"));
    break;
  case "supersede":
    supersedeLesson(primaryPath);
    break;
  case "migrate":
    migrate(primaryPath, secondaryPath ? Number(secondaryPath) : undefined);
    break;
  case "backup":
    createBackup(primaryPath, secondaryPath!);
    break;
  case "corrupt":
    corruptFile(primaryPath);
    break;
  case "verify-backup":
    verifyBackup(primaryPath);
    break;
  case "export":
    await exportDatabase(primaryPath, secondaryPath!);
    break;
  case "restore":
    restore(primaryPath, secondaryPath!);
    break;
  case "recover-from-backup":
    recoverFromBackup(primaryPath, secondaryPath!);
    break;
  case "inspect":
    inspect(primaryPath);
    break;
  default:
    fail({ reason: `unknown mode ${mode}` });
}
