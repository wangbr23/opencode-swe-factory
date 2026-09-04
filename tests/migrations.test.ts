import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SqliteMigrationError,
  migrateSqliteSchema,
  openSqliteConnection,
  type SchemaMigration,
} from "../src/core/index.js";

function withTemporaryDatabase(run: (databasePath: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-migrations-"));
  try {
    run(join(directory, "memory.sqlite"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const migrations: readonly SchemaMigration[] = [
  {
    version: 1,
    name: "create notes",
    migrate(database) {
      database.run("CREATE TABLE notes (body TEXT NOT NULL)");
    },
  },
  {
    version: 2,
    name: "add note priority",
    migrate(database) {
      database.run("ALTER TABLE notes ADD COLUMN priority INTEGER NOT NULL DEFAULT 0");
    },
  },
];

test("applies pending migrations in order and records the schema version", () => {
  withTemporaryDatabase((databasePath) => {
    const connection = openSqliteConnection(databasePath);
    try {
      expect(migrateSqliteSchema(connection, migrations)).toEqual({
        status: "ready",
        schemaVersion: 2,
        appliedVersions: [1, 2],
      });
      expect(connection.database.query<{ user_version: number }, []>("PRAGMA user_version").get()).toEqual({
        user_version: 2,
      });
      connection.database.run("INSERT INTO notes (body, priority) VALUES ('migrated', 3)");
    } finally {
      connection.close();
    }

    const reopened = openSqliteConnection(databasePath);
    try {
      expect(migrateSqliteSchema(reopened, migrations)).toEqual({
        status: "ready",
        schemaVersion: 2,
        appliedVersions: [],
      });
      expect(reopened.database.query<{ body: string; priority: number }, []>("SELECT body, priority FROM notes").get()).toEqual({
        body: "migrated",
        priority: 3,
      });
    } finally {
      reopened.close();
    }
  });
});

test("upgrades an older schema without rerunning released migrations", () => {
  withTemporaryDatabase((databasePath) => {
    const connection = openSqliteConnection(databasePath);
    try {
      migrateSqliteSchema(connection, migrations.slice(0, 1));
      connection.database.run("INSERT INTO notes (body) VALUES ('existing')");

      expect(migrateSqliteSchema(connection, migrations)).toEqual({
        status: "ready",
        schemaVersion: 2,
        appliedVersions: [2],
      });
      expect(connection.database.query<{ body: string; priority: number }, []>("SELECT body, priority FROM notes").get()).toEqual({
        body: "existing",
        priority: 0,
      });
    } finally {
      connection.close();
    }
  });
});

test("waits for the migration lock before reporting an already-current schema", () => {
  withTemporaryDatabase((databasePath) => {
    const lockOwner = openSqliteConnection(databasePath);
    const contender = openSqliteConnection(databasePath);
    try {
      migrateSqliteSchema(lockOwner, migrations);
      contender.database.run("PRAGMA busy_timeout = 0");
      lockOwner.database.run("BEGIN IMMEDIATE");

      expect(() => migrateSqliteSchema(contender, migrations)).toThrow(SqliteMigrationError);
    } finally {
      lockOwner.database.run("ROLLBACK");
      contender.close();
      lockOwner.close();
    }
  });
});

test("rolls back the complete pending migration chain on failure", () => {
  withTemporaryDatabase((databasePath) => {
    const connection = openSqliteConnection(databasePath);
    const failingMigrations: readonly SchemaMigration[] = [
      migrations[0]!,
      {
        version: 2,
        name: "fail deliberately",
        migrate(database) {
          database.run("CREATE TABLE partial_change (id INTEGER PRIMARY KEY)");
          throw new Error("injected failure");
        },
      },
    ];

    try {
      expect(() => migrateSqliteSchema(connection, failingMigrations)).toThrow(SqliteMigrationError);
      expect(connection.database.query<{ user_version: number }, []>("PRAGMA user_version").get()).toEqual({
        user_version: 0,
      });
      expect(connection.database.query<{ count: number }, []>("SELECT count(*) AS count FROM sqlite_master WHERE name IN ('notes', 'partial_change')").get()).toEqual({
        count: 0,
      });
    } finally {
      connection.close();
    }
  });
});

test("opens an unknown newer schema for reads while refusing writes", () => {
  withTemporaryDatabase((databasePath) => {
    const connection = openSqliteConnection(databasePath);
    try {
      connection.database.run("CREATE TABLE future_data (value TEXT NOT NULL)");
      connection.database.run("INSERT INTO future_data (value) VALUES ('inspectable')");
      connection.database.run("PRAGMA user_version = 3");

      expect(migrateSqliteSchema(connection, migrations)).toEqual({
        status: "newer-schema",
        schemaVersion: 3,
        supportedSchemaVersion: 2,
        appliedVersions: [],
      });
      expect(connection.database.query<{ value: string }, []>("SELECT value FROM future_data").get()).toEqual({
        value: "inspectable",
      });
      expect(() => connection.database.run("INSERT INTO future_data (value) VALUES ('blocked')")).toThrow(
        /readonly database/,
      );
    } finally {
      connection.close();
    }
  });
});

test("rejects migration lists with gaps before changing the database", () => {
  withTemporaryDatabase((databasePath) => {
    const connection = openSqliteConnection(databasePath);
    try {
      expect(() => migrateSqliteSchema(connection, [{ ...migrations[0]!, version: 2 }])).toThrow(
        "Expected schema migration version 1, received 2.",
      );
      expect(connection.database.query<{ user_version: number }, []>("PRAGMA user_version").get()).toEqual({
        user_version: 0,
      });
    } finally {
      connection.close();
    }
  });
});
