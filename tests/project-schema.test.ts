import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migrateSqliteSchema, openSqliteConnection, releaseSchemaMigrations } from "../src/core/index.js";

function withTemporaryDatabase(run: (databasePath: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-project-schema-"));
  try {
    run(join(directory, "memory.sqlite"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function migrateProjectSchema(databasePath: string) {
  const connection = openSqliteConnection(databasePath);
  const result = migrateSqliteSchema(connection, releaseSchemaMigrations);
  return { connection, result };
}

function insertProject(connection: ReturnType<typeof openSqliteConnection>["database"], id: string): void {
  connection.run(
    "INSERT INTO projects (id, remote_hash, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    [id, `hash-${id}`, `/repos/${id}`, "2026-09-04T00:00:00.000Z", "2026-09-04T00:00:00.000Z"],
  );
}

test("creates the project, alias, and project-setting schema at version 1", () => {
  withTemporaryDatabase((databasePath) => {
    const { connection, result } = migrateProjectSchema(databasePath);
    try {
      expect(result).toEqual({ status: "ready", schemaVersion: 2, appliedVersions: [1, 2] });

      const tableNames = connection.database
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => row.name);
      expect(tableNames).toContain("projects");
      expect(tableNames).toContain("project_aliases");
      expect(tableNames).toContain("project_settings");
    } finally {
      connection.close();
    }
  });
});

test("reports an already-current schema when reopened without reapplying the migration", () => {
  withTemporaryDatabase((databasePath) => {
    const { connection } = migrateProjectSchema(databasePath);
    connection.close();

    const reopened = openSqliteConnection(databasePath);
    try {
      expect(migrateSqliteSchema(reopened, releaseSchemaMigrations)).toEqual({
        status: "ready",
        schemaVersion: 2,
        appliedVersions: [],
      });
    } finally {
      reopened.close();
    }
  });
});

test("stores a project with a remote hash, a canonical path, and versioned settings", () => {
  withTemporaryDatabase((databasePath) => {
    const { connection } = migrateProjectSchema(databasePath);
    try {
      insertProject(connection.database, "proj-1");
      connection.database.run(
        "INSERT INTO project_settings (project_id, settings_version, settings_json, updated_at) VALUES (?, ?, ?, ?)",
        ["proj-1", 1, '{"featureToggles":{"retrieval":true}}', "2026-09-04T00:00:00.000Z"],
      );

      expect(
        connection.database
          .query<{ id: string; remote_hash: string | null; path: string }, [string]>(
            "SELECT id, remote_hash, path FROM projects WHERE id = ?",
          )
          .get("proj-1"),
      ).toEqual({ id: "proj-1", remote_hash: "hash-proj-1", path: "/repos/proj-1" });
      expect(
        connection.database
          .query<{ settings_version: number; settings_json: string }, [string]>(
            "SELECT settings_version, settings_json FROM project_settings WHERE project_id = ?",
          )
          .get("proj-1"),
      ).toEqual({ settings_version: 1, settings_json: '{"featureToggles":{"retrieval":true}}' });
    } finally {
      connection.close();
    }
  });
});

test("allows a project without a remote hash and rejects duplicate paths or remote hashes", () => {
  withTemporaryDatabase((databasePath) => {
    const { connection } = migrateProjectSchema(databasePath);
    try {
      insertProject(connection.database, "proj-1");
      connection.database.run(
        "INSERT INTO projects (id, remote_hash, path, created_at, updated_at) VALUES (?, NULL, ?, ?, ?)",
        ["proj-2", "/repos/proj-2", "2026-09-04T00:00:00.000Z", "2026-09-04T00:00:00.000Z"],
      );
      expect(
        connection.database.query<{ remote_hash: string | null }, [string]>("SELECT remote_hash FROM projects WHERE id = ?").get("proj-2"),
      ).toEqual({ remote_hash: null });

      expect(() =>
        connection.database.run(
          "INSERT INTO projects (id, remote_hash, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
          ["proj-3", "hash-proj-1", "/repos/other", "2026-09-04T00:00:00.000Z", "2026-09-04T00:00:00.000Z"],
        ),
      ).toThrow(/UNIQUE/);
      expect(() =>
        connection.database.run(
          "INSERT INTO projects (id, remote_hash, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
          ["proj-4", "hash-proj-4", "/repos/proj-1", "2026-09-04T00:00:00.000Z", "2026-09-04T00:00:00.000Z"],
        ),
      ).toThrow(/UNIQUE/);
      expect(() =>
        connection.database.run(
          "INSERT INTO projects (id, remote_hash, path, created_at, updated_at) VALUES (?, NULL, ?, ?, ?)",
          ["proj-5", "/repos/proj-1", "2026-09-04T00:00:00.000Z", "2026-09-04T00:00:00.000Z"],
        ),
      ).toThrow(/UNIQUE/);
    } finally {
      connection.close();
    }
  });
});

test("records aliases per kind and removes them with their project", () => {
  withTemporaryDatabase((databasePath) => {
    const { connection } = migrateProjectSchema(databasePath);
    try {
      insertProject(connection.database, "proj-1");
      connection.database.run(
        "INSERT INTO project_aliases (project_id, alias_kind, alias_value, created_at) VALUES (?, 'path', ?, ?)",
        ["proj-1", "/repos/old-location", "2026-09-04T00:00:00.000Z"],
      );
      connection.database.run(
        "INSERT INTO project_aliases (project_id, alias_kind, alias_value, created_at) VALUES (?, 'remote', ?, ?)",
        ["proj-1", "hash-remote", "2026-09-04T00:00:00.000Z"],
      );

      expect(() =>
        connection.database.run(
          "INSERT INTO project_aliases (project_id, alias_kind, alias_value, created_at) VALUES (?, 'kind', ?, ?)",
          ["proj-1", "invalid", "2026-09-04T00:00:00.000Z"],
        ),
      ).toThrow(/CHECK/);

      expect(connection.database.query<{ count: number }, []>("SELECT count(*) AS count FROM project_aliases").get()).toEqual({
        count: 2,
      });
      connection.database.run("DELETE FROM projects WHERE id = 'proj-1'");
      expect(connection.database.query<{ count: number }, []>("SELECT count(*) AS count FROM project_aliases").get()).toEqual({
        count: 0,
      });
    } finally {
      connection.close();
    }
  });
});

test("rejects invalid settings JSON and removes settings with their project", () => {
  withTemporaryDatabase((databasePath) => {
    const { connection } = migrateProjectSchema(databasePath);
    try {
      insertProject(connection.database, "proj-1");
      expect(() =>
        connection.database.run(
          "INSERT INTO project_settings (project_id, settings_version, settings_json, updated_at) VALUES (?, ?, ?, ?)",
          ["proj-1", 1, "not-json", "2026-09-04T00:00:00.000Z"],
        ),
      ).toThrow(/CHECK/);

      connection.database.run(
        "INSERT INTO project_settings (project_id, settings_version, settings_json, updated_at) VALUES (?, ?, ?, ?)",
        ["proj-1", 1, "{}", "2026-09-04T00:00:00.000Z"],
      );
      connection.database.run("DELETE FROM projects WHERE id = 'proj-1'");
      expect(connection.database.query<{ count: number }, []>("SELECT count(*) AS count FROM project_settings").get()).toEqual({
        count: 0,
      });
    } finally {
      connection.close();
    }
  });
});
