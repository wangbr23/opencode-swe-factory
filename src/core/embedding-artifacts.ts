import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  PINNED_EMBEDDING_ARTIFACTS,
  PINNED_EMBEDDING_ARTIFACT_BASE_URL,
} from "./embedding-artifact-manifest.js";
import { ensureOwnerOnlyDirectory } from "./paths.js";
import type {
  DownloadEmbeddingArtifactFn,
  EmbeddingArtifactFileStatus,
  EmbeddingArtifactState,
  InstallEmbeddingArtifactsInput,
  InstallEmbeddingArtifactsResult,
  PinnedEmbeddingArtifact,
  ResolveEmbeddingArtifactDirectoryInput,
  VerifyEmbeddingArtifactsInput,
  VerifyEmbeddingArtifactsResult,
} from "../types/embedding-artifact-types.js";

export type EmbeddingArtifactErrorCode =
  | "private-mode"
  | "downloads-disabled"
  | "download-failed"
  | "checksum-mismatch"
  | "symlink"
  | "artifact-path";

export class EmbeddingArtifactError extends Error {
  readonly code: EmbeddingArtifactErrorCode;

  constructor(code: EmbeddingArtifactErrorCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "EmbeddingArtifactError";
    this.code = code;
  }
}

const ARTIFACT_HASH_ALGORITHM = "sha256";

export type {
  DownloadEmbeddingArtifactFn,
  EmbeddingArtifactFileState,
  EmbeddingArtifactFileStatus,
  EmbeddingArtifactState,
  InstallEmbeddingArtifactsInput,
  InstallEmbeddingArtifactsResult,
  PinnedEmbeddingArtifact,
  ResolveEmbeddingArtifactDirectoryInput,
  VerifyEmbeddingArtifactsInput,
  VerifyEmbeddingArtifactsResult,
} from "../types/embedding-artifact-types.js";

export function resolveEmbeddingArtifactDirectory(
  input: ResolveEmbeddingArtifactDirectoryInput,
): string {
  if (input.configArtifactDirectory !== null) {
    return input.configArtifactDirectory;
  }
  return join(input.cacheDirectory, "embeddings");
}

function requireRegularFile(path: string, artifactPath: string): void {
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink()) {
    throw new EmbeddingArtifactError(
      "symlink",
      `Embedding artifact ${artifactPath} is a symbolic link; symbolic links are not supported.`,
    );
  }
}

function sha256Hex(content: Uint8Array): string {
  return createHash(ARTIFACT_HASH_ALGORITHM).update(content).digest("hex");
}

export function verifyEmbeddingArtifacts(input: VerifyEmbeddingArtifactsInput): VerifyEmbeddingArtifactsResult {
  const artifacts = input.artifacts ?? PINNED_EMBEDDING_ARTIFACTS;
  const files: EmbeddingArtifactFileStatus[] = artifacts.map((artifact) => {
    const filePath = join(input.artifactDirectory, artifact.path);
    const existing = lstatSync(filePath, { throwIfNoEntry: false });
    if (existing === undefined) {
      return { path: artifact.path, sha256: artifact.sha256, state: "missing" as const };
    }
    requireRegularFile(filePath, artifact.path);
    if (!existing.isFile()) {
      return { path: artifact.path, sha256: artifact.sha256, state: "corrupt" as const };
    }
    const actual = sha256Hex(readFileSync(filePath));
    const state = actual === artifact.sha256 ? ("verified" as const) : ("corrupt" as const);
    return { path: artifact.path, sha256: artifact.sha256, state };
  });

  return {
    artifactDirectory: input.artifactDirectory,
    state: aggregateArtifactState(files),
    files,
  };
}

function aggregateArtifactState(files: ReadonlyArray<EmbeddingArtifactFileStatus>): EmbeddingArtifactState {
  if (files.every((file) => file.state === "verified")) {
    return "verified";
  }
  if (files.some((file) => file.state === "corrupt")) {
    return "corrupt";
  }
  if (files.every((file) => file.state === "missing")) {
    return "not-installed";
  }
  return "incomplete";
}

async function defaultDownloadArtifact(url: string): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (cause) {
    throw new EmbeddingArtifactError("download-failed", `Artifact download request for ${url} failed.`, { cause });
  }
  if (!response.ok) {
    throw new EmbeddingArtifactError(
      "download-failed",
      `Artifact download for ${url} failed with status ${response.status}.`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

export async function installEmbeddingArtifacts(
  input: InstallEmbeddingArtifactsInput,
): Promise<InstallEmbeddingArtifactsResult> {
  if (input.privateModeEnabled === true) {
    throw new EmbeddingArtifactError(
      "private-mode",
      "Private mode never initiates artifact downloads. Disable private mode to install embedding artifacts.",
    );
  }
  if (!input.allowRemoteDownloads) {
    throw new EmbeddingArtifactError(
      "downloads-disabled",
      "Remote artifact downloads are disabled by the embeddings.allowRemoteDownloads setting. Enable it to install embedding artifacts.",
    );
  }

  const artifacts = input.artifacts ?? PINNED_EMBEDDING_ARTIFACTS;
  const downloadFile = input.downloadFile ?? defaultDownloadArtifact;
  ensureOwnerOnlyDirectory(input.artifactDirectory);

  const current = verifyEmbeddingArtifacts({ artifactDirectory: input.artifactDirectory, artifacts });
  const downloadedFiles: string[] = [];
  const skippedFiles: string[] = [];

  for (const artifact of artifacts) {
    const status = current.files.find((file) => file.path === artifact.path);
    if (status !== undefined && status.state === "verified") {
      skippedFiles.push(artifact.path);
      continue;
    }

    const url = `${PINNED_EMBEDDING_ARTIFACT_BASE_URL}/${artifact.path}`;
    const content = await downloadFile(url);
    const actual = sha256Hex(content);
    if (actual !== artifact.sha256) {
      throw new EmbeddingArtifactError(
        "checksum-mismatch",
        `Downloaded artifact ${artifact.path} does not match the pinned checksum. Installation aborted; verified artifacts were left unchanged.`,
      );
    }

    const finalPath = join(input.artifactDirectory, artifact.path);
    requireRegularFile(finalPath, artifact.path);
    mkdirSync(dirname(finalPath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${finalPath}.${randomUUID()}.tmp`;
    writeFileSync(temporaryPath, content, { mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    rmSync(finalPath, { force: true });
    renameSync(temporaryPath, finalPath);
    downloadedFiles.push(artifact.path);
  }

  const verification = verifyEmbeddingArtifacts({ artifactDirectory: input.artifactDirectory, artifacts });
  return {
    artifactDirectory: input.artifactDirectory,
    downloadedFiles,
    skippedFiles,
    verification,
  };
}
