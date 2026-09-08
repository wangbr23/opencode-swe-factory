import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  DOCUMENT_CONTENT_HASH_ALGORITHM,
  MARKDOWN_FILE_EXTENSIONS,
  type AdmitCuratedDocumentSourcesInput,
  type AdmittedDocumentSource,
  type CollectedDocumentFile,
  type DocumentAdmissionLimits,
  type DocumentAdmissionResult,
  type DocumentSourceType,
  type SkippedDocumentSource,
} from "../../types/document-admission-types.js";
import { scanTextForSecrets } from "../secrets.js";

export type {
  AdmitCuratedDocumentSourcesInput,
  AdmittedDocumentSource,
  DocumentAdmissionLimits,
  DocumentAdmissionResult,
  DocumentAdmissionSkipReason,
  DocumentSecretScanSummary,
  DocumentSourceType,
  SkippedDocumentSource,
} from "../../types/document-admission-types.js";

export class DocumentAdmissionInputError extends Error {}

function requireNonEmptyString(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DocumentAdmissionInputError(`${label} must be a non-empty string.`);
  }
}

function validateLimits(limits: DocumentAdmissionLimits): void {
  for (const [name, value] of [
    ["maxFileBytes", limits.maxFileBytes],
    ["maxTotalBytes", limits.maxTotalBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new DocumentAdmissionInputError(`limits.${name} must be a positive safe integer.`);
    }
  }
}

function isWithin(root: string, path: string): boolean {
  const pathFromRoot = relative(root, path);
  if (pathFromRoot === "") {
    return true;
  }
  return !pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot);
}

function resolveFromProject(projectRoot: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(projectRoot, path);
}

function canonicalizePaths(projectRoot: string, paths: ReadonlyArray<string>, label: string): ReadonlyArray<string> {
  return paths.map((path, index) => {
    requireNonEmptyString(path, `${label}[${index}]`);
    const resolvedPath = resolveFromProject(projectRoot, path);
    try {
      return realpathSync(resolvedPath);
    } catch {
      return resolvedPath;
    }
  });
}

function isExplicitlyApproved(path: string, approvals: ReadonlyArray<string>): boolean {
  return approvals.some((approvedPath) => isWithin(approvedPath, path));
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}

function inferSourceType(path: string): DocumentSourceType {
  const lowerPath = path.toLowerCase().split(sep).join("/");
  const fileName = basename(lowerPath);
  if (fileName === "agents.md" || fileName === "claude.md" || fileName === "cleancode.md") {
    return "project-instructions";
  }
  if (fileName === "todo.md") {
    return "task-state";
  }
  if (fileName === "journal.md") {
    return "journal";
  }
  if (fileName === "decisions.md") {
    return "decision";
  }
  if (lowerPath.startsWith("docs/specs/") || lowerPath.includes("/docs/specs/")) {
    return "specification";
  }
  if (lowerPath.startsWith("docs/designs/") || lowerPath.includes("/docs/designs/")) {
    return "design";
  }
  return "documentation";
}

function decodeText(buffer: Uint8Array): string | null {
  if (buffer.includes(0)) {
    return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function sortSkipped(skipped: SkippedDocumentSource[]): void {
  skipped.sort((left, right) => compareText(left.path, right.path) || compareText(left.reason, right.reason));
}

export async function admitCuratedDocumentSources(
  input: AdmitCuratedDocumentSourcesInput,
): Promise<DocumentAdmissionResult> {
  requireNonEmptyString(input.projectId, "projectId");
  requireNonEmptyString(input.projectRoot, "projectRoot");
  if (!isAbsolute(input.projectRoot)) {
    throw new DocumentAdmissionInputError("projectRoot must be absolute.");
  }
  validateLimits(input.limits);
  input.curatedPaths.forEach((path, index) => requireNonEmptyString(path, `curatedPaths[${index}]`));

  let canonicalProjectRoot: string;
  try {
    canonicalProjectRoot = realpathSync(input.projectRoot);
    if (!statSync(canonicalProjectRoot).isDirectory()) {
      throw new DocumentAdmissionInputError("projectRoot must be a directory.");
    }
  } catch (error) {
    if (error instanceof DocumentAdmissionInputError) {
      throw error;
    }
    throw new DocumentAdmissionInputError("projectRoot must be an existing readable directory.");
  }

  const resolvedProjectRoot = resolve(input.projectRoot);
  const externalApprovals = canonicalizePaths(
    resolvedProjectRoot,
    input.explicitlyApprovedExternalPaths ?? [],
    "explicitlyApprovedExternalPaths",
  );
  const secretAcknowledgments = new Set(
    canonicalizePaths(resolvedProjectRoot, input.acknowledgedSecretPaths ?? [], "acknowledgedSecretPaths"),
  );
  const skipped: SkippedDocumentSource[] = [];
  const files = new Map<string, CollectedDocumentFile>();
  const visitedDirectories = new Set<string>();

  function collect(path: string): void {
    const resolvedPath = resolveFromProject(resolvedProjectRoot, path);
    let canonicalPath: string;
    let stats: ReturnType<typeof statSync>;
    try {
      canonicalPath = realpathSync(resolvedPath);
      stats = statSync(canonicalPath);
    } catch (error) {
      skipped.push({ path: resolvedPath, reason: errorCode(error) === "ENOENT" ? "missing" : "unreadable" });
      return;
    }

    const traversesOutsideProject = !isWithin(resolvedProjectRoot, resolvedPath);
    const resolvesOutsideProject = !isWithin(canonicalProjectRoot, canonicalPath);
    const escapesProject = traversesOutsideProject || resolvesOutsideProject;
    if (escapesProject && !isExplicitlyApproved(canonicalPath, externalApprovals)) {
      skipped.push({ path: resolvedPath, reason: "outside-project" });
      return;
    }

    if (stats.isDirectory()) {
      if (visitedDirectories.has(canonicalPath)) {
        return;
      }
      visitedDirectories.add(canonicalPath);
      let entries: string[];
      try {
        entries = readdirSync(resolvedPath, { encoding: "utf8" }).sort();
      } catch {
        skipped.push({ path: resolvedPath, reason: "unreadable" });
        return;
      }
      for (const entry of entries) {
        collect(join(resolvedPath, entry));
      }
      return;
    }

    if (!stats.isFile()) {
      skipped.push({ path: resolvedPath, reason: "unsupported-path-type" });
      return;
    }
    if (!MARKDOWN_FILE_EXTENSIONS.has(extname(canonicalPath).toLowerCase())) {
      skipped.push({ path: resolvedPath, reason: "unsupported-file-type", sizeBytes: stats.size });
      return;
    }
    if (files.has(canonicalPath)) {
      skipped.push({ path: resolvedPath, reason: "duplicate", sizeBytes: stats.size });
      return;
    }

    files.set(canonicalPath, {
      canonicalPath,
      relativePath: isWithin(canonicalProjectRoot, canonicalPath)
        ? relative(canonicalProjectRoot, canonicalPath).split(sep).join("/")
        : null,
      sizeBytes: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    });
  }

  for (const curatedPath of input.curatedPaths) {
    collect(curatedPath);
  }

  const admitted: AdmittedDocumentSource[] = [];
  let totalBytes = 0;
  for (const file of [...files.values()].sort((left, right) => compareText(left.canonicalPath, right.canonicalPath))) {
    if (file.sizeBytes > input.limits.maxFileBytes) {
      skipped.push({ path: file.canonicalPath, reason: "file-too-large", sizeBytes: file.sizeBytes });
      continue;
    }
    if (totalBytes + file.sizeBytes > input.limits.maxTotalBytes) {
      skipped.push({ path: file.canonicalPath, reason: "total-size-limit", sizeBytes: file.sizeBytes });
      continue;
    }

    let buffer: Uint8Array;
    try {
      buffer = readFileSync(file.canonicalPath);
    } catch {
      skipped.push({ path: file.canonicalPath, reason: "unreadable" });
      continue;
    }
    if (buffer.byteLength > input.limits.maxFileBytes) {
      skipped.push({ path: file.canonicalPath, reason: "file-too-large", sizeBytes: buffer.byteLength });
      continue;
    }
    if (totalBytes + buffer.byteLength > input.limits.maxTotalBytes) {
      skipped.push({ path: file.canonicalPath, reason: "total-size-limit", sizeBytes: buffer.byteLength });
      continue;
    }

    const content = decodeText(buffer);
    if (content === null) {
      skipped.push({ path: file.canonicalPath, reason: "binary", sizeBytes: buffer.byteLength });
      continue;
    }

    let secretScan: Awaited<ReturnType<typeof scanTextForSecrets>>;
    try {
      secretScan = await scanTextForSecrets(content);
    } catch {
      skipped.push({ path: file.canonicalPath, reason: "secret-scan-failed", sizeBytes: buffer.byteLength });
      continue;
    }
    const secretScanSummary = { disposition: secretScan.disposition, findings: secretScan.findings };
    if (secretScan.disposition === "blocked") {
      skipped.push({
        path: file.canonicalPath,
        reason: "secret-blocked",
        sizeBytes: buffer.byteLength,
        secretScan: secretScanSummary,
      });
      continue;
    }
    const secretRiskAcknowledged =
      secretScan.disposition === "acknowledgment-required" && secretAcknowledgments.has(file.canonicalPath);
    if (secretScan.disposition === "acknowledgment-required" && !secretRiskAcknowledged) {
      skipped.push({
        path: file.canonicalPath,
        reason: "secret-acknowledgment-required",
        sizeBytes: buffer.byteLength,
        secretScan: secretScanSummary,
      });
      continue;
    }

    admitted.push({
      projectId: input.projectId,
      scope: "project",
      path: file.canonicalPath,
      relativePath: file.relativePath,
      sourceType: inferSourceType(file.relativePath ?? file.canonicalPath),
      content,
      contentHash: createHash(DOCUMENT_CONTENT_HASH_ALGORITHM).update(buffer).digest("hex"),
      sizeBytes: buffer.byteLength,
      modifiedAt: file.modifiedAt,
      secretScan: secretScanSummary,
      secretRiskAcknowledged,
    });
    totalBytes += buffer.byteLength;
  }

  sortSkipped(skipped);
  return { admitted, skipped, totalBytes };
}
