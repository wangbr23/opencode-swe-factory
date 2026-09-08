import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SqliteMigrationError,
  migrateSqliteSchema,
  openSqliteConnection,
  releaseSchemaMigrations,
  type SchemaMigration,
} from "../src/core/index.js";

const RELEASE_VERSION = releaseSchemaMigrations.length;
const SEED_TIMESTAMP = "2026-09-07T00:00:00.000Z";

function withTemporaryDatabase(run: (databasePath: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-migration-upgrade-"));
  try {
    run(join(directory, "memory.sqlite"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function readUserVersion(database: Database): number {
  const row = database.query<{ user_version: number }, []>("PRAGMA user_version").get();
  if (!row) {
    throw new Error("SQLite did not report a schema version.");
  }
  return row.user_version;
}

function readIntegrity(database: Database): string {
  return database
    .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
    .all()
    .map((row) => row.integrity_check)
    .join(";");
}

function foreignKeyIssues(database: Database): ReadonlyArray<Record<string, unknown>> {
  return database.query<Record<string, unknown>, []>("PRAGMA foreign_key_check").all();
}

function tableExists(database: Database, tableName: string): boolean {
  const row = database
    .query<{ count: number }, [string]>("SELECT count(*) AS count FROM sqlite_master WHERE name = ?")
    .get(tableName);
  return (row?.count ?? 0) > 0;
}

const ALL_SCHEMA_TABLES = [
  "projects",
  "project_aliases",
  "project_settings",
  "lessons",
  "lesson_versions",
  "pending_lesson_candidates",
  "document_sources",
  "document_chunks",
  "document_chunks_fts",
  "lesson_versions_fts",
  "document_chunk_embeddings",
  "lesson_version_embeddings",
  "tasks",
  "task_profiles",
  "execution_profiles",
  "outcome_signals",
  "lesson_retrieval_hits",
] as const;

function expectAllTablesExist(database: Database): void {
  for (const tableName of ALL_SCHEMA_TABLES) {
    expect(tableExists(database, tableName), `expected table ${tableName}`).toBe(true);
  }
}

type SeedStep = Readonly<{
  version: number;
  seed: (database: Database) => void;
  verify: (database: Database) => void;
}>;

const SEEDS: ReadonlyArray<SeedStep> = [
  {
    version: 1,
    seed(database) {
      database.run(
        "INSERT INTO projects (id, path, created_at, updated_at) VALUES ('project-1', '/repos/project-1', ?, ?)",
        [SEED_TIMESTAMP, SEED_TIMESTAMP],
      );
    },
    verify(database) {
      expect(
        database.query<{ count: number }, []>("SELECT count(*) AS count FROM projects").get(),
      ).toEqual({ count: 1 });
    },
  },
  {
    version: 2,
    seed(database) {
      database.run(
        "INSERT INTO lessons (id, project_id, scope, active_version, created_at, updated_at) VALUES ('lesson-1', 'project-1', 'project', 1, ?, ?)",
        [SEED_TIMESTAMP, SEED_TIMESTAMP],
      );
      database.run(
        "INSERT INTO lesson_versions (lesson_id, version, title, body, rationale, applicability_json, provenance_json, superseded_by_version, created_at) VALUES ('lesson-1', 1, 'Run the test suite', 'Always run bun test and bun run typecheck before committing.', 'A commit once landed without tests.', '[]', '[]', NULL, ?)",
        [SEED_TIMESTAMP],
      );
    },
    verify(database) {
      expect(
        database
          .query<{ body: string }, [string]>(
            "SELECT body FROM lesson_versions WHERE lesson_id = ? AND version = 1",
          )
          .get("lesson-1"),
      ).toEqual({ body: "Always run bun test and bun run typecheck before committing." });
    },
  },
  {
    version: 3,
    seed(database) {
      database.run(
        "INSERT INTO document_sources (id, project_id, scope, source_type, path, content_hash, indexed_at, created_at, updated_at) VALUES ('source-1', 'project-1', 'project', 'curated', '/docs/guide.md', 'hash-1', ?, ?, ?)",
        [SEED_TIMESTAMP, SEED_TIMESTAMP, SEED_TIMESTAMP],
      );
      database.run(
        "INSERT INTO document_chunks (id, source_id, project_id, scope, source_type, source_path, heading_path, start_line, end_line, content_hash, text, created_at, updated_at) VALUES ('chunk-1', 'source-1', 'project-1', 'project', 'curated', '/docs/guide.md', 'Setup', 1, 2, 'chunk-hash-1', 'Run the setup script before migration.', ?, ?)",
        [SEED_TIMESTAMP, SEED_TIMESTAMP],
      );
    },
    verify(database) {
      expect(
        database
          .query<{ text: string }, [string]>("SELECT text FROM document_chunks WHERE id = ?")
          .get("chunk-1"),
      ).toEqual({ text: "Run the setup script before migration." });
    },
  },
  {
    version: 4,
    seed(database) {
      database.run(
        "INSERT INTO tasks (id, project_id, session_id, boundary, created_at, updated_at) VALUES ('task-1', 'project-1', 'session-1', 'top-level', ?, ?)",
        [SEED_TIMESTAMP, SEED_TIMESTAMP],
      );
      database.run(
        "INSERT INTO task_profiles (task_id, version, taxonomy_version, activity, domain, complexity, risk, stack_json, required_capabilities_json, signals_json, summary, source, supersedes_version, created_at) VALUES ('task-1', 1, 1, 'commit', NULL, 'simple', 'low', '[]', '[]', '[]', 'Commit the migration fix.', 'inferred', NULL, ?)",
        [SEED_TIMESTAMP],
      );
      database.run(
        "INSERT INTO execution_profiles (id, task_id, task_profile_version, provider, model, variant, agent, selection_source, host_provider, host_model, host_variant, tool_profile_json, software_versions_json, started_at, completed_at, latency_ms, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, cost_usd, finish_state, provider_error_kind, provider_error_code, created_at) VALUES ('execution-1', 'task-1', 1, 'zai', 'glm', NULL, 'build', 'host', NULL, NULL, NULL, '{}', '[]', ?, ?, 10, 0, 0, 0, 0, 0, 0, 'success', NULL, NULL, ?)",
        [SEED_TIMESTAMP, SEED_TIMESTAMP, SEED_TIMESTAMP],
      );
      database.run(
        "INSERT INTO outcome_signals (id, task_id, execution_id, dimension, kind, source, confidence, value, metadata_json, lesson_id, lesson_version, supersedes_signal_id, observed_at, created_at) VALUES ('signal-1', 'task-1', 'execution-1', 'reliability', 'tool', 'objective', 1, 1, '{}', NULL, NULL, NULL, ?, ?)",
        [SEED_TIMESTAMP, SEED_TIMESTAMP],
      );
    },
    verify(database) {
      for (const tableName of ["tasks", "task_profiles", "execution_profiles", "outcome_signals"]) {
        expect(
          database.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${tableName}`).get(),
        ).toEqual({ count: 1 });
      }
    },
  },
  {
    version: 5,
    seed(database) {
      database.run("INSERT INTO lesson_retrieval_hits (lesson_id, version, retrieved_day) VALUES ('lesson-1', 1, '2026-09-07')");
    },
    verify(database) {
      expect(
        database.query<{ count: number }, []>("SELECT count(*) AS count FROM lesson_retrieval_hits").get(),
      ).toEqual({ count: 1 });
    },
  },
];

function buildDatabaseAtVersion(databasePath: string, version: number): void {
  const connection = openSqliteConnection(databasePath);
  try {
    if (version > 0) {
      migrateSqliteSchema(connection, releaseSchemaMigrations.slice(0, version));
    }
    for (const step of SEEDS) {
      if (step.version <= version) {
        step.seed(connection.database);
      }
    }
  } finally {
    connection.close();
  }
}

function expectSeedsSurvive(database: Database, fromVersion: number): void {
  for (const step of SEEDS) {
    if (step.version <= fromVersion) {
      step.verify(database);
    }
  }
}

function expectFullTextSearchSurvived(database: Database, fromVersion: number): void {
  if (fromVersion >= 2) {
    expect(
      database
        .query<{ lesson_id: string }, []>("SELECT lesson_id FROM lesson_versions_fts WHERE lesson_versions_fts MATCH 'typecheck'")
        .all(),
    ).toEqual([{ lesson_id: "lesson-1" }]);
  }
  if (fromVersion >= 3) {
    expect(
      database
        .query<{ chunk_id: string }, []>("SELECT chunk_id FROM document_chunks_fts WHERE document_chunks_fts MATCH 'setup'")
        .all(),
    ).toEqual([{ chunk_id: "chunk-1" }]);
  }
}

test.each([0, 1, 2, 3, 4, 5])("upgrades from released schema version %i without losing data", (fromVersion) => {
  withTemporaryDatabase((databasePath) => {
    buildDatabaseAtVersion(databasePath, fromVersion);

    const connection = openSqliteConnection(databasePath);
    try {
      expect(migrateSqliteSchema(connection, releaseSchemaMigrations)).toEqual({
        status: "ready",
        schemaVersion: RELEASE_VERSION,
        appliedVersions: releaseSchemaMigrations.slice(fromVersion).map((migration) => migration.version),
      });
      expect(readUserVersion(connection.database)).toBe(RELEASE_VERSION);
      expectSeedsSurvive(connection.database, fromVersion);
      expectFullTextSearchSurvived(connection.database, fromVersion);
      expectAllTablesExist(connection.database);
      expect(readIntegrity(connection.database)).toBe("ok");
      expect(foreignKeyIssues(connection.database)).toEqual([]);
    } finally {
      connection.close();
    }
  });
});

test.each([0, 1, 2, 3, 4])(
  "keeps the last known-good schema and data when an upgrade from version %i fails",
  (fromVersion) => {
    withTemporaryDatabase((databasePath) => {
      buildDatabaseAtVersion(databasePath, fromVersion);

      const connection = openSqliteConnection(databasePath);
      try {
        const failingVersion = fromVersion + 1;
        const failingMigrations: readonly SchemaMigration[] = [
          ...releaseSchemaMigrations.slice(0, fromVersion),
          {
            version: failingVersion,
            name: `injected failure at ${failingVersion}`,
            migrate(database) {
              database.run(`CREATE TABLE injected_v${failingVersion} (id INTEGER PRIMARY KEY)`);
              throw new Error("injected migration failure");
            },
          },
        ];

        let error: unknown;
        try {
          migrateSqliteSchema(connection, failingMigrations);
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(SqliteMigrationError);
        const migrationError = error as SqliteMigrationError;
        expect(migrationError.fromVersion).toBe(fromVersion);
        expect(migrationError.databasePath).toBe(databasePath);
        expect(migrationError.failedMigration).toEqual({
          version: failingVersion,
          name: `injected failure at ${failingVersion}`,
        });

        expect(readUserVersion(connection.database)).toBe(fromVersion);
        expect(tableExists(connection.database, `injected_v${failingVersion}`)).toBe(false);
        expectSeedsSurvive(connection.database, fromVersion);
        expect(readIntegrity(connection.database)).toBe("ok");

        expect(migrateSqliteSchema(connection, releaseSchemaMigrations)).toEqual({
          status: "ready",
          schemaVersion: RELEASE_VERSION,
          appliedVersions: releaseSchemaMigrations.slice(fromVersion).map((migration) => migration.version),
        });
        expectSeedsSurvive(connection.database, fromVersion);
        expectFullTextSearchSurvived(connection.database, fromVersion);
      } finally {
        connection.close();
      }
    });
  },
);
