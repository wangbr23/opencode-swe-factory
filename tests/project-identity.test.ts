import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ProjectIdentityConflictError,
  ProjectIdentityError,
  migrateSqliteSchema,
  normalizeVcsRemote,
  openSqliteConnection,
  releaseSchemaMigrations,
  resolveProjectIdentity,
  type SqliteConnection,
} from "../src/core/index.js";

function withTemporaryDatabase(run: (databasePath: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-project-identity-"));
  try {
    run(join(directory, "memory.sqlite"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function withMigratedDatabase(run: (connection: SqliteConnection) => void): void {
  withTemporaryDatabase((databasePath) => {
    const connection = openSqliteConnection(databasePath);
    migrateSqliteSchema(connection, releaseSchemaMigrations);
    try {
      run(connection);
    } finally {
      connection.close();
    }
  });
}

test("normalizes remotes by stripping credentials, userinfo, queries, ports, and .git", () => {
  expect(normalizeVcsRemote("https://user:token@github.com/Owner/Repo.git?ref=x#frag")).toBe(
    "https://github.com/Owner/Repo",
  );
  expect(normalizeVcsRemote("git@github.com:owner/repo.git")).toBe("ssh://github.com/owner/repo");
  expect(normalizeVcsRemote("ssh://git@github.com:22/owner/repo")).toBe("ssh://github.com/owner/repo");
  expect(normalizeVcsRemote("  https://github.com/owner/repo/  ")).toBe("https://github.com/owner/repo");
  expect(normalizeVcsRemote("/Users/dev/local-repo")).toBeNull();
  expect(normalizeVcsRemote("not a remote")).toBeNull();
  expect(normalizeVcsRemote("")).toBeNull();
});

test("creates a path-fallback project and resolves it identically on repeat visits", () => {
  withMigratedDatabase((connection) => {
      const first = resolveProjectIdentity(connection, { projectPath: "/repos/example" });
      expect(first.resolution).toBe("created");
      expect(first.project.remoteHash).toBeNull();
      expect(first.project.createdAt).toBe(first.project.updatedAt);

      const second = resolveProjectIdentity(connection, { projectPath: "/repos/example" });
      expect(second.resolution).toBe("path-match");
      expect(second.project.id).toBe(first.project.id);
      expect(second.project.createdAt).toBe(first.project.createdAt);

      const aliases = connection.database
        .query<{ count: number }, []>("SELECT count(*) AS count FROM project_aliases")
        .get();
      expect(aliases).toEqual({ count: 1 });
});
});

test("binds a remote to a path-resolved project without a remote", () => {
  withMigratedDatabase((connection) => {
      const pathOnly = resolveProjectIdentity(connection, { projectPath: "/repos/example", now: new Date(0) });
      expect(pathOnly.project.remoteHash).toBeNull();

      const bound = resolveProjectIdentity(connection, {
        projectPath: "/repos/example",
        remoteUrl: "git@github.com:owner/repo.git",
        now: new Date(1_000),
      });
      expect(bound.resolution).toBe("path-match");
      expect(bound.project.id).toBe(pathOnly.project.id);
      expect(bound.project.remoteHash).not.toBeNull();
      expect(bound.project.createdAt).toBe(new Date(0).toISOString());
      expect(bound.project.updatedAt).toBe(new Date(1_000).toISOString());

      const remoteAliases = connection.database
        .query<{ alias_value: string }, []>("SELECT alias_value FROM project_aliases WHERE alias_kind = 'remote'")
        .all();
      expect(remoteAliases).toEqual([{ alias_value: "ssh://github.com/owner/repo" }]);
      expect(JSON.stringify(remoteAliases)).not.toContain("token");
});
});

test("matches a moved working copy by remote and keeps the old path alias", () => {
  withMigratedDatabase((connection) => {
      const original = resolveProjectIdentity(connection, {
        projectPath: "/repos/old-location",
        remoteUrl: "https://github.com/owner/repo.git",
      });

      const moved = resolveProjectIdentity(connection, {
        projectPath: "/repos/new-location",
        remoteUrl: "https://github.com/owner/repo.git",
      });

      expect(moved.resolution).toBe("remote-match");
      expect(moved.project.id).toBe(original.project.id);

      const pathAliases = connection.database
        .query<{ alias_value: string }, []>("SELECT alias_value FROM project_aliases WHERE alias_kind = 'path' ORDER BY alias_value")
        .all();
      expect(pathAliases.map((row) => row.alias_value)).toEqual(["/repos/new-location", "/repos/old-location"]);
});
});

test("refuses path and remote claims that belong to another project", () => {
  withMigratedDatabase((connection) => {
    const first = resolveProjectIdentity(connection, {
      projectPath: "/repos/one",
      remoteUrl: "https://github.com/owner/one.git",
    });
    resolveProjectIdentity(connection, {
      projectPath: "/repos/two",
      remoteUrl: "https://github.com/owner/two.git",
    });
    // A path-only project that later reports a remote already claimed by
    // another project is ambiguous until relink/merge resolves it.
    resolveProjectIdentity(connection, { projectPath: "/repos/three" });

    expect(() =>
      resolveProjectIdentity(connection, { projectPath: "/repos/two", remoteUrl: "https://github.com/owner/three.git" }),
    ).toThrow(ProjectIdentityConflictError);

    expect(() =>
      resolveProjectIdentity(connection, { projectPath: "/repos/three", remoteUrl: "https://github.com/owner/one.git" }),
    ).toThrow(ProjectIdentityConflictError);
    expect(first.project.path).toBe("/repos/one");

    const projectCount = connection.database.query<{ count: number }, []>("SELECT count(*) AS count FROM projects").get();
    expect(projectCount).toEqual({ count: 3 });
  });
});

test("rejects relative project paths before touching the database", () => {
  withMigratedDatabase((connection) => {
      expect(() => resolveProjectIdentity(connection, { projectPath: "relative/path" })).toThrow(ProjectIdentityError);
      expect(connection.database.query<{ count: number }, []>("SELECT count(*) AS count FROM projects").get()).toEqual({
        count: 0,
      });
});
});

test("treats distinct remotes that normalize to the same value as the same identity", () => {
  withMigratedDatabase((connection) => {
    const original = resolveProjectIdentity(connection, {
      projectPath: "/repos/one",
      remoteUrl: "https://github.com/owner/repo.git",
    });
    const equivalent = resolveProjectIdentity(connection, {
      projectPath: "/repos/one",
      remoteUrl: "https://user:token@GITHUB.com/owner/repo",
    });

    expect(equivalent.resolution).toBe("remote-match");
    expect(equivalent.project.id).toBe(original.project.id);
    expect(equivalent.project.remoteHash).toBe(original.project.remoteHash);
  });
});
