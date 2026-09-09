import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ProjectIdentityConflictError,
  ProjectIdentityError,
  createTask,
  mergeProjects,
  migrateSqliteSchema,
  normalizeVcsRemote,
  openSqliteConnection,
  proposeLessonCandidate,
  releaseSchemaMigrations,
  resolveProjectIdentity,
  reviewLessonCandidate,
  type SecretScanResult,
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

const clearScan: SecretScanResult = {
  disposition: "clear",
  findings: [],
  redactedText: "",
};

function seedProjectLesson(connection: SqliteConnection, projectId: string | null, title: string): string {
  const candidate = proposeLessonCandidate(connection, {
    projectId,
    scope: projectId === null ? "global" : "project",
    draft: {
      title,
      body: `Body of ${title}`,
      rationale: "Test lesson",
      applicability: {},
      provenance: {},
    },
    secretScan: clearScan,
  });
  const outcome = reviewLessonCandidate(connection, { candidateId: candidate.id, decision: "approve" });
  if (outcome.status !== "approved") {
    throw new Error("expected approval");
  }
  return outcome.lesson.lessonId;
}

function seedDocumentIndex(connection: SqliteConnection, projectId: string): { sourceId: string } {
  const sourceId = "source-" + Math.random().toString(36).slice(2);
  connection.database.run(
    "INSERT INTO document_sources (id, project_id, scope, source_type, path, content_hash, indexed_at, created_at, updated_at) VALUES (?, ?, 'project', 'design', '/repos/duplicate/docs/design.md', 'hash-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    [sourceId, projectId],
  );
  connection.database.run(
    "INSERT INTO document_chunks (id, source_id, project_id, scope, source_type, source_path, heading_path, start_line, end_line, content_hash, text, created_at, updated_at) VALUES (?, ?, ?, 'project', 'design', '/repos/duplicate/docs/design.md', '# Design', 1, 5, 'hash-1', 'chunk text', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    ["chunk-1", sourceId, projectId],
  );
  connection.database.run(
    "INSERT INTO document_chunks (id, source_id, project_id, scope, source_type, source_path, heading_path, start_line, end_line, content_hash, text, created_at, updated_at) VALUES (?, ?, ?, 'project', 'design', '/repos/duplicate/docs/design.md', '# Design > Body', 6, 10, 'hash-2', 'chunk text 2', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    ["chunk-2", sourceId, projectId],
  );
  return { sourceId };
}

test("merges a duplicate project into the survivor and moves its project-scoped data", () => {
  withMigratedDatabase((connection) => {
    const survivor = resolveProjectIdentity(connection, {
      projectPath: "/repos/primary",
      remoteUrl: "https://github.com/owner/repo.git",
      now: new Date(0),
    }).project;
    const absorbed = resolveProjectIdentity(connection, {
      projectPath: "/repos/duplicate",
      now: new Date(0),
    }).project;

    seedProjectLesson(connection, absorbed.id, "Absorbed lesson A");
    seedProjectLesson(connection, absorbed.id, "Absorbed lesson B");
    seedProjectLesson(connection, null, "Global lesson");
    const candidate = proposeLessonCandidate(connection, {
      projectId: absorbed.id,
      scope: "project",
      draft: {
        title: "Pending candidate",
        body: "Pending body",
        rationale: "Pending",
        applicability: {},
        provenance: {},
      },
      secretScan: clearScan,
    });
    seedDocumentIndex(connection, absorbed.id);
    const topLevel = createTask(connection, {
      projectId: absorbed.id,
      sessionId: "session-1",
      boundary: "top-level",
      now: new Date(0),
    });
    createTask(connection, {
      projectId: absorbed.id,
      sessionId: "session-1",
      boundary: "subtask",
      parentTaskId: topLevel.taskId,
      now: new Date(0),
    });

    const result = mergeProjects(connection, {
      survivorProjectId: survivor.id,
      absorbedProjectId: absorbed.id,
      now: new Date(1_000),
    });

    expect(result).toMatchObject({
      survivorProjectId: survivor.id,
      absorbedProjectId: absorbed.id,
      movedLessons: 2,
      movedPendingCandidates: 1,
      movedTasks: 2,
      transferredPathAliases: ["/repos/duplicate"],
      transferredRemoteAliases: [],
      adoptedRemoteHash: false,
      droppedDocumentSources: 1,
      droppedDocumentChunks: 2,
      keptSurvivorSettings: false,
    });

    expect(
      connection.database.query<{ count: number }, []>("SELECT count(*) AS count FROM projects").get(),
    ).toEqual({ count: 1 });
    expect(
      connection.database
        .query<{ count: number }, [string]>("SELECT count(*) AS count FROM lessons WHERE project_id = ?")
        .get(survivor.id),
    ).toEqual({ count: 2 });
    expect(
      connection.database
        .query<{ count: number }, []>("SELECT count(*) AS count FROM lessons WHERE project_id IS NULL AND scope = 'global'")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      connection.database
        .query<{ count: number }, [string]>("SELECT count(*) AS count FROM tasks WHERE project_id = ?")
        .get(survivor.id),
    ).toEqual({ count: 2 });
    expect(
      connection.database
        .query<{ count: number }, []>("SELECT count(*) AS count FROM document_sources").get(),
    ).toEqual({ count: 0 });

    // The survivor now resolves by the absorbed project's path and remote.
    const byAbsorbedPath = resolveProjectIdentity(connection, { projectPath: "/repos/duplicate" });
    expect(byAbsorbedPath.resolution).toBe("path-match");
    expect(byAbsorbedPath.project.id).toBe(survivor.id);
    const byRemote = resolveProjectIdentity(connection, {
      projectPath: "/repos/duplicate",
      remoteUrl: "https://github.com/owner/repo.git",
    });
    expect(byRemote.resolution).toBe("remote-match");
    expect(byRemote.project.id).toBe(survivor.id);

    // Task identity immutability is restored after the merge.
    expect(() =>
      connection.database.run("UPDATE tasks SET project_id = 'somewhere-else'"),
    ).toThrow(/task identity fields are immutable/);
  });
});

test("merge adopts the absorbed remote when the survivor has none", () => {
  withMigratedDatabase((connection) => {
    const survivor = resolveProjectIdentity(connection, { projectPath: "/repos/primary" }).project;
    const absorbed = resolveProjectIdentity(connection, {
      projectPath: "/repos/duplicate",
      remoteUrl: "git@github.com:owner/repo.git",
    }).project;

    const result = mergeProjects(connection, { survivorProjectId: survivor.id, absorbedProjectId: absorbed.id });

    expect(result.adoptedRemoteHash).toBe(true);
    const row = connection.database
      .query<{ remote_hash: string | null }, [string]>("SELECT remote_hash FROM projects WHERE id = ?")
      .get(survivor.id);
    expect(row?.remote_hash).toBe(absorbed.remoteHash);

    const resolved = resolveProjectIdentity(connection, {
      projectPath: "/repos/elsewhere",
      remoteUrl: "git@github.com:owner/repo.git",
    });
    expect(resolved.resolution).toBe("remote-match");
    expect(resolved.project.id).toBe(survivor.id);
  });
});

test("merge keeps the survivor's settings and primary remote", () => {
  withMigratedDatabase((connection) => {
    const survivor = resolveProjectIdentity(connection, {
      projectPath: "/repos/primary",
      remoteUrl: "https://github.com/owner/primary.git",
    }).project;
    const absorbed = resolveProjectIdentity(connection, {
      projectPath: "/repos/duplicate",
      remoteUrl: "https://github.com/owner/duplicate.git",
    }).project;
    connection.database.run(
      "INSERT INTO project_settings (project_id, settings_version, settings_json, updated_at) VALUES (?, 1, '{}', '2026-01-01T00:00:00.000Z')",
      [survivor.id],
    );
    connection.database.run(
      "INSERT INTO project_settings (project_id, settings_version, settings_json, updated_at) VALUES (?, 1, '{}', '2026-01-01T00:00:00.000Z')",
      [absorbed.id],
    );

    const result = mergeProjects(connection, { survivorProjectId: survivor.id, absorbedProjectId: absorbed.id });

    expect(result.adoptedRemoteHash).toBe(false);
    expect(result.keptSurvivorSettings).toBe(true);
    const settings = connection.database
      .query<{ project_id: string }, []>("SELECT project_id FROM project_settings")
      .all();
    expect(settings).toEqual([{ project_id: survivor.id }]);
    const remoteRow = connection.database
      .query<{ remote_hash: string | null }, [string]>("SELECT remote_hash FROM projects WHERE id = ?")
      .get(survivor.id);
    expect(remoteRow?.remote_hash).toBe(survivor.remoteHash);

    const remoteAliases = connection.database
      .query<{ alias_value: string }, [string]>(
        "SELECT alias_value FROM project_aliases WHERE alias_kind = 'remote' AND project_id = ? ORDER BY alias_value",
      )
      .all(survivor.id);
    expect(remoteAliases.map((row) => row.alias_value)).toEqual([
      "https://github.com/owner/duplicate",
      "https://github.com/owner/primary",
    ]);
  });
});

test("merge refuses self-merges, unknown projects, and third-party alias claims without mutating", () => {
  withMigratedDatabase((connection) => {
    const survivor = resolveProjectIdentity(connection, { projectPath: "/repos/primary" }).project;
    const absorbed = resolveProjectIdentity(connection, { projectPath: "/repos/duplicate" }).project;
    resolveProjectIdentity(connection, { projectPath: "/repos/third" });

    expect(() =>
      mergeProjects(connection, { survivorProjectId: survivor.id, absorbedProjectId: survivor.id }),
    ).toThrow(ProjectIdentityError);
    expect(() => mergeProjects(connection, { survivorProjectId: "missing", absorbedProjectId: absorbed.id })).toThrow(
      /not found/,
    );
    expect(() => mergeProjects(connection, { survivorProjectId: survivor.id, absorbedProjectId: "missing" })).toThrow(
      /not found/,
    );

    // Simulate divergent history: the third project claimed the alias the
    // absorbed project used to hold, so the transfer must abort and roll back.
    const third = resolveProjectIdentity(connection, { projectPath: "/repos/third" }).project;
    connection.database.run("DELETE FROM project_aliases WHERE alias_value = '/repos/duplicate'");
    connection.database.run(
      "INSERT INTO project_aliases (project_id, alias_kind, alias_value, created_at) VALUES (?, 'path', '/repos/duplicate', '2026-01-01T00:00:00.000Z')",
      [third.id],
    );
    expect(() =>
      mergeProjects(connection, { survivorProjectId: survivor.id, absorbedProjectId: absorbed.id }),
    ).toThrow(ProjectIdentityConflictError);
    expect(
      connection.database.query<{ count: number }, []>("SELECT count(*) AS count FROM projects").get(),
    ).toEqual({ count: 3 });
    // The rollback must restore pre-merge state: the third project still
    // holds the conflicting claim, and the absorbed project survives it.
    expect(
      connection.database
        .query<{ count: number }, [string]>(
          "SELECT count(*) AS count FROM project_aliases WHERE project_id = ? AND alias_value = '/repos/duplicate'",
        )
        .get(third.id),
    ).toEqual({ count: 1 });
  });
});
