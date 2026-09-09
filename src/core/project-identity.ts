import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, normalize } from "node:path";

import { REMOTE_HASH_ALGORITHM, SUPPORTED_REMOTE_PROTOCOLS } from "../types/project-identity-types.js";
import type {
  AliasRow,
  MergeProjectsInput,
  MergeProjectsResult,
  ProjectIdentityResult,
  ProjectRow,
  RelinkProjectInput,
  RelinkProjectResult,
  ResolvedProject,
  ResolveProjectIdentityInput,
} from "../types/project-identity-types.js";
import { CREATE_TASKS_IDENTITY_UPDATE_TRIGGER_SQL } from "./db/task-evidence-schema-sql.js";
import type { SqliteConnection } from "./db/sqlite.js";

export type {
  ProjectIdentityResult,
  ProjectResolution,
  RelinkProjectInput,
  RelinkProjectResult,
  ResolvedProject,
  ResolveProjectIdentityInput,
  MergeProjectsInput,
  MergeProjectsResult,
} from "../types/project-identity-types.js";

export class ProjectIdentityError extends Error {
  readonly projectPath: string;

  constructor(projectPath: string, message: string) {
    super(message);
    this.name = "ProjectIdentityError";
    this.projectPath = projectPath;
  }
}

export class ProjectIdentityConflictError extends ProjectIdentityError {
  readonly conflictingPath: string | undefined;
  readonly conflictingRemote: string | undefined;

  constructor(projectPath: string, message: string, conflicting?: { path?: string; remote?: string }) {
    super(projectPath, message);
    this.name = "ProjectIdentityConflictError";
    this.conflictingPath = conflicting?.path;
    this.conflictingRemote = conflicting?.remote;
  }
}

/**
 * Normalizes a VCS remote URL for identity hashing: scp-like syntax becomes
 * ssh, credentials and query/parameter fragments are removed, the host is
 * lowercased, default ports and the trailing .git suffix are dropped. Returns
 * null for values that are not recognizable remotes (including local paths),
 * so callers can fall back to path identity.
 */
export function normalizeVcsRemote(rawRemote: string): string | null {
  const trimmed = rawRemote.trim();
  if (trimmed.length === 0) {
    return null;
  }

  let candidate = trimmed;
  // scp-like syntax (git@host:owner/repo.git) predates URL parsing; Windows
  // drive paths contain a colon but never an @ before it. Userinfo is dropped
  // along with credentials by the URL rebuild below.
  const scpLike = /^([^/@]+@[^:/]+)\/?(.*)$/.exec(trimmed.replace(":", "/"));
  if (scpLike) {
    candidate = `ssh://${scpLike[1]}/${scpLike[2]}`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (!SUPPORTED_REMOTE_PROTOCOLS.has(url.protocol)) {
    return null;
  }

  const host = url.hostname.toLowerCase();
  if (host.length === 0) {
    return null;
  }
  const defaultPort = url.protocol === "ssh:" ? "22" : null;
  const port = url.port && url.port !== defaultPort ? `:${url.port}` : "";

  let pathname = url.pathname.replaceAll(/\/*$/g, "");
  const parameterStart = pathname.indexOf(";");
  if (parameterStart !== -1) {
    pathname = pathname.slice(0, parameterStart);
  }
  pathname = pathname.replace(/\.git$/i, "");
  if (pathname.length === 0 || pathname === "/") {
    return null;
  }

  return `${url.protocol}//${host}${port}${pathname}`;
}

export function hashVcsRemote(normalizedRemote: string): string {
  return createHash(REMOTE_HASH_ALGORITHM).update(normalizedRemote, "utf8").digest("hex");
}

function normalizeProjectPath(projectPath: string): string {
  if (!isAbsolute(projectPath)) {
    throw new ProjectIdentityError(projectPath, "Project path must be absolute.");
  }
  const normalized = normalize(projectPath);
  return normalized.length > 1 ? normalized.replaceAll(/[\\/]+$/g, "") : normalized;
}

function queryProjectById(connection: SqliteConnection, id: string): ProjectRow | undefined {
  return (
    connection.database
      .query<ProjectRow, [string]>("SELECT id, remote_hash, path, created_at, updated_at FROM projects WHERE id = ?")
      .get(id) ?? undefined
  );
}

function queryProjectByRemoteHash(connection: SqliteConnection, remoteHash: string): ProjectRow | undefined {
  return (
    connection.database
      .query<ProjectRow, [string]>("SELECT id, remote_hash, path, created_at, updated_at FROM projects WHERE remote_hash = ?")
      .get(remoteHash) ?? undefined
  );
}

function queryProjectByPath(connection: SqliteConnection, projectPath: string): ProjectRow | undefined {
  const byAlias = connection.database
    .query<AliasRow, [string]>("SELECT project_id FROM project_aliases WHERE alias_kind = 'path' AND alias_value = ?")
    .get(projectPath);
  if (byAlias) {
    return queryProjectById(connection, byAlias.project_id);
  }
  return (
    connection.database
      .query<ProjectRow, [string]>("SELECT id, remote_hash, path, created_at, updated_at FROM projects WHERE path = ?")
      .get(projectPath) ?? undefined
  );
}

function queryProjectByRemoteAlias(connection: SqliteConnection, normalizedRemote: string): ProjectRow | undefined {
  const byAlias = connection.database
    .query<AliasRow, [string]>("SELECT project_id FROM project_aliases WHERE alias_kind = 'remote' AND alias_value = ?")
    .get(normalizedRemote);
  if (!byAlias) {
    return undefined;
  }
  return queryProjectById(connection, byAlias.project_id);
}

function insertPathAlias(connection: SqliteConnection, projectId: string, projectPath: string, createdAt: string): void {
  const claim = connection.database
    .query<AliasRow, [string]>("SELECT project_id FROM project_aliases WHERE alias_kind = 'path' AND alias_value = ?")
    .get(projectPath);
  if (claim && claim.project_id !== projectId) {
    throw new ProjectIdentityConflictError(
      projectPath,
      `Project path ${projectPath} is already an alias of another project.`,
      { path: projectPath },
    );
  }
  if (claim) {
    return;
  }
  connection.database.run(
    "INSERT INTO project_aliases (project_id, alias_kind, alias_value, created_at) VALUES (?, 'path', ?, ?)",
    [projectId, projectPath, createdAt],
  );
}

function insertRemoteAlias(connection: SqliteConnection, projectId: string, normalizedRemote: string, createdAt: string): void {
  const claim = connection.database
    .query<AliasRow, [string]>("SELECT project_id FROM project_aliases WHERE alias_kind = 'remote' AND alias_value = ?")
    .get(normalizedRemote);
  if (claim && claim.project_id !== projectId) {
    throw new ProjectIdentityConflictError(
      normalizedRemote,
      "A normalized remote is already an alias of another project.",
      { remote: normalizedRemote },
    );
  }
  if (claim) {
    return;
  }
  connection.database.run(
    "INSERT INTO project_aliases (project_id, alias_kind, alias_value, created_at) VALUES (?, 'remote', ?, ?)",
    [projectId, normalizedRemote, createdAt],
  );
}

function toResolvedProject(row: ProjectRow): ResolvedProject {
  return {
    id: row.id,
    path: row.path,
    remoteHash: row.remote_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Resolves a project identity for a working directory, preferring the hashed
 * normalized VCS remote and falling back to the canonical path. Missing
 * projects are created; a path-resolved project without a remote binds the
 * supplied remote. Conflicting identity claims (a path or remote already
 * belonging to another project) are refused — relink and merge are separate
 * explicit operations.
 */
export function resolveProjectIdentity(connection: SqliteConnection, input: ResolveProjectIdentityInput): ProjectIdentityResult {
  const canonicalPath = normalizeProjectPath(input.projectPath);
  const normalizedRemote = input.remoteUrl === undefined ? null : normalizeVcsRemote(input.remoteUrl);
  const remoteHash = normalizedRemote === null ? null : hashVcsRemote(normalizedRemote);
  const now = (input.now ?? new Date()).toISOString();

  return connection.database.transaction((): ProjectIdentityResult => {
    if (remoteHash) {
      const remoteMatch = queryProjectByRemoteHash(connection, remoteHash) ?? queryProjectByRemoteAlias(connection, normalizedRemote!);
      if (remoteMatch) {
        insertPathAlias(connection, remoteMatch.id, canonicalPath, now);
        return { project: toResolvedProject(remoteMatch), resolution: "remote-match" };
      }
    }

    const pathMatch = queryProjectByPath(connection, canonicalPath);
    if (pathMatch) {
      if (remoteHash) {
        if (pathMatch.remote_hash && pathMatch.remote_hash !== remoteHash) {
          throw new ProjectIdentityConflictError(
            canonicalPath,
            "Project already has a different remote; relink explicitly to change it.",
            { remote: normalizedRemote! },
          );
        }
        const hashClaim = queryProjectByRemoteHash(connection, remoteHash);
        if (hashClaim && hashClaim.id !== pathMatch.id) {
          throw new ProjectIdentityConflictError(
            canonicalPath,
            "Another project already uses this remote; merge or relink explicitly.",
            { remote: normalizedRemote! },
          );
        }
        if (!pathMatch.remote_hash) {
          connection.database.run("UPDATE projects SET remote_hash = ?, updated_at = ? WHERE id = ?", [
            remoteHash,
            now,
            pathMatch.id,
          ]);
        }
        insertRemoteAlias(connection, pathMatch.id, normalizedRemote!, now);
      }
      insertPathAlias(connection, pathMatch.id, canonicalPath, now);
      const boundRemote = remoteHash !== null && pathMatch.remote_hash === null;
      return {
        project: toResolvedProject(boundRemote ? { ...pathMatch, remote_hash: remoteHash, updated_at: now } : pathMatch),
        resolution: "path-match",
      };
    }

    const projectId = randomUUID();
    const projectRow: ProjectRow = {
      id: projectId,
      remote_hash: remoteHash,
      path: canonicalPath,
      created_at: now,
      updated_at: now,
    };
    connection.database.run(
      "INSERT INTO projects (id, remote_hash, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      [projectRow.id, projectRow.remote_hash, projectRow.path, projectRow.created_at, projectRow.updated_at],
    );
    insertPathAlias(connection, projectId, canonicalPath, now);
    if (normalizedRemote) {
      insertRemoteAlias(connection, projectId, normalizedRemote, now);
    }
    return { project: toResolvedProject(projectRow), resolution: "created" };
  })();
}

/**
 * Explicitly changes a project's primary path and/or remote association.
 * This is the deliberate operation referenced when resolveProjectIdentity
 * refuses a conflict. Updates the primary row, adds new path/remote aliases,
 * and returns the before/after state.
 */
export function relinkProject(connection: SqliteConnection, input: RelinkProjectInput): RelinkProjectResult {
  if (!input.newPath && !input.newRemoteUrl) {
    throw new ProjectIdentityError("", "At least one of newPath or newRemoteUrl is required.");
  }

  const now = (input.now ?? new Date()).toISOString();

  return connection.database.transaction((): RelinkProjectResult => {
    const project = queryProjectById(connection, input.projectId);
    if (!project) {
      throw new ProjectIdentityError(input.projectId, `Project ${input.projectId} not found.`);
    }

    let newPath = project.path;
    let newRemoteHash = project.remote_hash;

    if (input.newPath) {
      const canonicalPath = normalizeProjectPath(input.newPath);
      const existing = queryProjectByPath(connection, canonicalPath);
      if (existing && existing.id !== project.id) {
        throw new ProjectIdentityConflictError(
          canonicalPath,
          `Path ${canonicalPath} is already used by project ${existing.id}.`,
          { path: canonicalPath },
        );
      }
      connection.database.run("UPDATE projects SET path = ?, updated_at = ? WHERE id = ?", [
        canonicalPath,
        now,
        project.id,
      ]);
      insertPathAlias(connection, project.id, canonicalPath, now);
      newPath = canonicalPath;
    }

    if (input.newRemoteUrl) {
      const normalizedRemote = normalizeVcsRemote(input.newRemoteUrl);
      if (!normalizedRemote) {
        throw new ProjectIdentityError(input.newRemoteUrl, `Could not normalize remote URL "${input.newRemoteUrl}".`);
      }
      const remoteHash = hashVcsRemote(normalizedRemote);
      const existing = queryProjectByRemoteHash(connection, remoteHash);
      if (existing && existing.id !== project.id) {
        throw new ProjectIdentityConflictError(
          project.path,
          `Remote is already used by project ${existing.id}.`,
          { remote: normalizedRemote },
        );
      }
      connection.database.run("UPDATE projects SET remote_hash = ?, updated_at = ? WHERE id = ?", [
        remoteHash,
        now,
        project.id,
      ]);
      insertRemoteAlias(connection, project.id, normalizedRemote, now);
      newRemoteHash = remoteHash;
    }

    return {
      projectId: project.id,
      previousPath: project.path,
      path: newPath,
      previousRemoteHash: project.remote_hash,
      remoteHash: newRemoteHash,
    };
  })();
}

/**
 * Explicitly consolidates a duplicate project into a survivor. Both rows are
 * identities for the same repository that resolveProjectIdentity refused to
 * reconcile (e.g. a path-only record and a remote-keyed record for clones at
 * different paths). The survivor keeps its primary path and remote; the
 * absorbed project's path/remote aliases transfer, its project-scoped lessons,
 * pending candidates, and tasks move, and a document index that can be rebuilt
 * from authoritative sources is dropped. Global lessons have no project and
 * are never touched.
 */
export function mergeProjects(connection: SqliteConnection, input: MergeProjectsInput): MergeProjectsResult {
  if (input.survivorProjectId === input.absorbedProjectId) {
    throw new ProjectIdentityError(input.survivorProjectId, "A project cannot be merged into itself.");
  }

  const now = (input.now ?? new Date()).toISOString();

  return connection.database.transaction((): MergeProjectsResult => {
    const survivor = queryProjectById(connection, input.survivorProjectId);
    if (!survivor) {
      throw new ProjectIdentityError(input.survivorProjectId, `Project ${input.survivorProjectId} not found.`);
    }
    const absorbed = queryProjectById(connection, input.absorbedProjectId);
    if (!absorbed) {
      throw new ProjectIdentityError(input.absorbedProjectId, `Project ${input.absorbedProjectId} not found.`);
    }

    // Transfer every alias claim to the survivor. Absorbed and survivor
    // cannot share an alias value (the table's primary key is global), so a
    // non-null claim at insert time always belongs to a third project and is
    // a real conflict.
    const absorbedAliases = connection.database
      .query<{ alias_kind: string; alias_value: string; created_at: string }, [string]>(
        "SELECT alias_kind, alias_value, created_at FROM project_aliases WHERE project_id = ?",
      )
      .all(absorbed.id);
    connection.database.run("DELETE FROM project_aliases WHERE project_id = ?", [absorbed.id]);
    const transferredPathAliases = new Set<string>();
    const transferredRemoteAliases = new Set<string>();
    for (const alias of absorbedAliases) {
      if (alias.alias_kind === "path") {
        insertPathAlias(connection, survivor.id, alias.alias_value, alias.created_at);
        transferredPathAliases.add(alias.alias_value);
      } else {
        insertRemoteAlias(connection, survivor.id, alias.alias_value, alias.created_at);
        transferredRemoteAliases.add(alias.alias_value);
      }
    }

    // The primary path and remote must survive the absorbed row's deletion:
    // re-claim them for the survivor unless an alias row already carries them.
    // A primary path claimed by a third project while the absorbed project
    // lacks its own alias row is an inconsistent database, but refusing with
    // the canonical conflict error is safer than silently stealing the claim.
    const primaryPathClaim = queryPathAliasClaim(connection, absorbed.path);
    if (!primaryPathClaim) {
      insertPathAlias(connection, survivor.id, absorbed.path, absorbed.created_at);
      transferredPathAliases.add(absorbed.path);
    } else if (primaryPathClaim.project_id !== survivor.id) {
      insertPathAlias(connection, survivor.id, absorbed.path, absorbed.created_at);
    }

    // Document indexes are disposable: source files remain authoritative and
    // the project activation reindex rebuilds missing rows on the survivor.
    // Moving them would fight the chunk/source consistency triggers, so they
    // are dropped with the absorbed project instead of reassigned.
    const droppedDocumentSources =
      connection.database
        .query<{ count: number }, [string]>("SELECT count(*) AS count FROM document_sources WHERE project_id = ?")
        .get(absorbed.id)?.count ?? 0;
    const droppedDocumentChunks =
      connection.database
        .query<{ count: number }, [string]>("SELECT count(*) AS count FROM document_chunks WHERE project_id = ?")
        .get(absorbed.id)?.count ?? 0;
    connection.database.run("DELETE FROM document_sources WHERE project_id = ?", [absorbed.id]);

    // bun's run().changes counts cascaded deletes and FTS-trigger writes, so
    // moved-row counts come from before/after deltas instead.
    const movedLessons = countProjectScopedRows(connection, "lessons", absorbed.id);
    const movedPendingCandidates = countProjectScopedRows(
      connection,
      "pending_lesson_candidates",
      absorbed.id,
    );
    const movedTasks = countProjectScopedRows(connection, "tasks", absorbed.id);

    connection.database.run("UPDATE lessons SET project_id = ? WHERE project_id = ?", [survivor.id, absorbed.id]);
    connection.database.run("UPDATE pending_lesson_candidates SET project_id = ? WHERE project_id = ?", [
      survivor.id,
      absorbed.id,
    ]);

    connection.database.run("DROP TRIGGER tasks_identity_update");
    connection.database.run("UPDATE tasks SET project_id = ? WHERE project_id = ?", [survivor.id, absorbed.id]);
    connection.database.run(CREATE_TASKS_IDENTITY_UPDATE_TRIGGER_SQL);

    const survivorSettings = connection.database
      .query<{ project_id: string }, [string]>("SELECT project_id FROM project_settings WHERE project_id = ?")
      .get(survivor.id);
    const keptSurvivorSettings = survivorSettings !== null && survivorSettings !== undefined;
    if (keptSurvivorSettings) {
      connection.database.run("DELETE FROM project_settings WHERE project_id = ?", [absorbed.id]);
    } else {
      connection.database.run("UPDATE project_settings SET project_id = ? WHERE project_id = ?", [
        survivor.id,
        absorbed.id,
      ]);
    }

    // The absorbed row must be gone before its remote can be adopted: the
    // projects.remote_hash unique index forbids two rows sharing a hash.
    connection.database.run("DELETE FROM projects WHERE id = ?", [absorbed.id]);

    const adoptedRemoteHash = survivor.remote_hash === null && absorbed.remote_hash !== null;
    connection.database.run("UPDATE projects SET remote_hash = ?, updated_at = ? WHERE id = ?", [
      adoptedRemoteHash ? absorbed.remote_hash : survivor.remote_hash,
      now,
      survivor.id,
    ]);

    return {
      survivorProjectId: survivor.id,
      absorbedProjectId: absorbed.id,
      movedLessons,
      movedPendingCandidates,
      movedTasks,
      transferredPathAliases: [...transferredPathAliases].sort(),
      transferredRemoteAliases: [...transferredRemoteAliases].sort(),
      adoptedRemoteHash,
      droppedDocumentSources,
      droppedDocumentChunks,
      keptSurvivorSettings,
    };
  })();
}

function queryPathAliasClaim(connection: SqliteConnection, aliasValue: string): AliasRow | undefined {
  return (
    connection.database
      .query<AliasRow, [string]>("SELECT project_id FROM project_aliases WHERE alias_kind = 'path' AND alias_value = ?")
      .get(aliasValue) ?? undefined
  );
}

function countProjectScopedRows(connection: SqliteConnection, table: string, projectId: string): number {
  return (
    connection.database
      .query<{ count: number }, [string]>(`SELECT count(*) AS count FROM ${table} WHERE project_id = ?`)
      .get(projectId)?.count ?? 0
  );
}
