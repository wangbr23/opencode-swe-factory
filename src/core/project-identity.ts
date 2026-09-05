import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, normalize } from "node:path";

import type { SqliteConnection } from "./sqlite.js";

const REMOTE_HASH_ALGORITHM = "sha256";
const SUPPORTED_REMOTE_PROTOCOLS = new Set(["http:", "https:", "ssh:", "git:"]);

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

export type ResolvedProject = Readonly<{
  id: string;
  path: string;
  remoteHash: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type ProjectResolution = "remote-match" | "path-match" | "created";

export type ProjectIdentityResult = Readonly<{
  project: ResolvedProject;
  resolution: ProjectResolution;
}>;

export type ResolveProjectIdentityInput = Readonly<{
  projectPath: string;
  remoteUrl?: string;
  now?: Date;
}>;

type ProjectRow = Readonly<{
  id: string;
  remote_hash: string | null;
  path: string;
  created_at: string;
  updated_at: string;
}>;

type AliasRow = Readonly<{
  project_id: string;
}>;

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
