import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

import { ensureOwnerOnlyDirectory, ensureOwnerOnlyFile } from "./paths.js";
import { scanTextForSecrets } from "./secrets.js";

export const DIAGNOSTIC_SCHEMA_VERSION = 1 as const;
export const MAX_DIAGNOSTIC_RECORD_BYTES = 4_096;
export const MAX_LOCAL_DIAGNOSTICS = 100;
export const MAX_LOCAL_DIAGNOSTICS_BYTES = MAX_DIAGNOSTIC_RECORD_BYTES * MAX_LOCAL_DIAGNOSTICS + MAX_LOCAL_DIAGNOSTICS;

const MAX_IDENTIFIER_LENGTH = 64;
const MAX_DIAGNOSTIC_SUMMARY_BYTES = 2_048;
const DIAGNOSTIC_LOCK_TIMEOUT_MS = 500;
const DIAGNOSTIC_LOCK_RETRY_MS = 10;
const STALE_DIAGNOSTIC_LOCK_MS = 30_000;
const redactedPath = "[REDACTED_PATH]";
const truncatedSummary = "[TRUNCATED]";
const embeddedPathStartPattern = /file:\/\/|\\\\|\b[a-z]:[\\/]|\/(?=[^\s/])|(?<![:/\\])\.\.?[\\/]|(?<![:/\\])\S[^\r\n\\/]*[\\/]/iu;
const diagnosticTemporaryFilePattern = /^[0-9]+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i;

type DiagnosticLockMetadata = Readonly<{
  pid: number;
  createdAt: string;
}>;

export type DiagnosticSeverity = "info" | "warning" | "error";

export type LocalDiagnostic = Readonly<{
  schemaVersion: typeof DIAGNOSTIC_SCHEMA_VERSION;
  timestamp: string;
  component: string;
  code: string;
  severity: DiagnosticSeverity;
  summary: string;
  path?: typeof redactedPath;
}>;

export type LocalDiagnosticInput = Readonly<{
  component: string;
  code: string;
  severity: DiagnosticSeverity;
  summary: string;
  path?: string;
}>;

export type LocalDiagnosticFileInput = Readonly<{
  filePath: string;
  now?: () => Date;
}>;

export type HealthCheckStatus = "healthy" | "degraded" | "unavailable";

export type HealthCheck = Readonly<{
  component: string;
  status: HealthCheckStatus;
  reason?: string;
}>;

export type HealthReport = Readonly<{
  generatedAt: string;
  status: HealthCheckStatus;
  externalTelemetry: false;
  checks: ReadonlyArray<HealthCheck>;
  diagnostics: Readonly<{
    info: number;
    warning: number;
    error: number;
  }>;
}>;

export class LocalDiagnosticReadError extends Error {
  readonly filePath: string;

  constructor(filePath: string, cause: unknown) {
    super(`Could not read local diagnostics at ${filePath}.`, { cause });
    this.name = "LocalDiagnosticReadError";
    this.filePath = filePath;
  }
}

export class LocalDiagnosticWriteError extends Error {
  readonly filePath: string;

  constructor(filePath: string, cause: unknown) {
    super(`Could not write local diagnostics at ${filePath}.`, { cause });
    this.name = "LocalDiagnosticWriteError";
    this.filePath = filePath;
  }
}

function requireIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || value.length > MAX_IDENTIFIER_LENGTH || !/^[a-z0-9][a-z0-9._-]*$/i.test(value)) {
    throw new TypeError(`${label} must contain only letters, numbers, dots, underscores, or hyphens.`);
  }
  return value;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) {
    return value;
  }
  const availableBytes = maximumBytes - Buffer.byteLength(truncatedSummary, "utf8");
  let prefix = "";
  let prefixBytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (prefixBytes + characterBytes > availableBytes) {
      break;
    }
    prefix += character;
    prefixBytes += characterBytes;
  }
  return `${prefix}${truncatedSummary}`;
}

function redactEmbeddedPaths(summary: string): string {
  const pathStart = summary.search(embeddedPathStartPattern);
  return pathStart === -1 ? summary : `${summary.slice(0, pathStart)}${redactedPath}`;
}

function serializeDiagnostic(diagnostic: LocalDiagnostic): string {
  const serialized = JSON.stringify(diagnostic);
  if (Buffer.byteLength(serialized, "utf8") > MAX_DIAGNOSTIC_RECORD_BYTES) {
    throw new TypeError("Diagnostic record exceeds the maximum size.");
  }
  return serialized;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isExistingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireDiagnosticLock(filePath: string): Promise<() => void> {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + DIAGNOSTIC_LOCK_TIMEOUT_MS;

  while (true) {
    let createdLock = false;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(lockPath, "wx", 0o600);
      createdLock = true;
      const metadata: DiagnosticLockMetadata = { pid: process.pid, createdAt: new Date().toISOString() };
      writeFileSync(descriptor, JSON.stringify(metadata), "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      ensureOwnerOnlyFile(lockPath);
      return () => rmSync(lockPath, { force: true });
    } catch (error) {
      try {
        if (descriptor !== undefined) {
          closeSync(descriptor);
        }
      } finally {
        if (createdLock) {
          rmSync(lockPath, { force: true });
        }
      }
      if (!isExistingFileError(error)) {
        throw error;
      }
      if (recoverDiagnosticLock(lockPath)) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("Timed out acquiring the local diagnostics lock.");
      }
      await delay(DIAGNOSTIC_LOCK_RETRY_MS);
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH");
  }
}

function parseDiagnosticLockMetadata(lockPath: string): DiagnosticLockMetadata | undefined {
  try {
    const value = JSON.parse(readFileSync(lockPath, "utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    const metadata = value as Record<string, unknown>;
    if (
      typeof metadata.pid !== "number" ||
      !Number.isSafeInteger(metadata.pid) ||
      metadata.pid <= 0 ||
      typeof metadata.createdAt !== "string" ||
      !Number.isFinite(Date.parse(metadata.createdAt))
    ) {
      return undefined;
    }
    return { pid: metadata.pid, createdAt: metadata.createdAt };
  } catch {
    return undefined;
  }
}

function recoverDiagnosticLock(lockPath: string): boolean {
  let lockStat: ReturnType<typeof statSync>;
  try {
    lockStat = statSync(lockPath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return true;
    }
    throw error;
  }

  const metadata = parseDiagnosticLockMetadata(lockPath);
  const canRecover = metadata === undefined
    ? lockStat.mtimeMs <= Date.now() - STALE_DIAGNOSTIC_LOCK_MS
    : !isProcessAlive(metadata.pid);
  if (!canRecover) {
    return false;
  }

  const recoveryPath = `${lockPath}.${randomUUID()}.recovery`;
  try {
    renameSync(lockPath, recoveryPath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return true;
    }
    throw error;
  }
  rmSync(recoveryPath, { force: true });
  return true;
}

function removeOrphanDiagnosticTemporaryFiles(filePath: string): void {
  const directory = dirname(filePath);
  const temporaryPrefix = `.${basename(filePath)}.`;
  for (const entry of readdirSync(directory)) {
    if (!entry.startsWith(temporaryPrefix)) {
      continue;
    }
    const metadata = entry.slice(temporaryPrefix.length);
    const separator = metadata.indexOf(".");
    if (separator === -1 || !diagnosticTemporaryFilePattern.test(metadata)) {
      continue;
    }
    const pid = Number(metadata.slice(0, separator));
    const temporaryPath = join(directory, entry);
    if (isProcessAlive(pid) || !lstatSync(temporaryPath).isFile()) {
      continue;
    }
    rmSync(temporaryPath);
  }
}

function writeDiagnosticsAtomically(filePath: string, contents: string): void {
  const temporaryPath = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);

  try {
    writeFileSync(temporaryPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    ensureOwnerOnlyFile(temporaryPath);
    renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // The original write failure is more actionable; a later write will use a distinct temporary path.
    }
    throw error;
  }
}

function isDiagnosticSeverity(value: unknown): value is DiagnosticSeverity {
  return value === "info" || value === "warning" || value === "error";
}

function isHealthCheckStatus(value: unknown): value is HealthCheckStatus {
  return value === "healthy" || value === "degraded" || value === "unavailable";
}

function parseDiagnostic(value: unknown): LocalDiagnostic {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Diagnostic record must be an object.");
  }
  const record = value as Record<string, unknown>;
  const path = record.path;
  if (
    record.schemaVersion !== DIAGNOSTIC_SCHEMA_VERSION ||
    typeof record.timestamp !== "string" ||
    !Number.isFinite(Date.parse(record.timestamp)) ||
    typeof record.component !== "string" ||
    typeof record.code !== "string" ||
    !isDiagnosticSeverity(record.severity) ||
    typeof record.summary !== "string" ||
    redactEmbeddedPaths(record.summary) !== record.summary ||
    (path !== undefined && path !== redactedPath)
  ) {
    throw new TypeError("Diagnostic record is invalid.");
  }
  requireIdentifier(record.component, "Diagnostic component");
  requireIdentifier(record.code, "Diagnostic code");
  return {
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    timestamp: record.timestamp,
    component: record.component,
    code: record.code,
    severity: record.severity,
    summary: record.summary,
    ...(path === undefined ? {} : { path: redactedPath }),
  };
}

function validateHistoricalDiagnostic(value: unknown): LocalDiagnostic {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > MAX_DIAGNOSTIC_RECORD_BYTES) {
    throw new TypeError("Diagnostic record exceeds the maximum size.");
  }
  return parseDiagnostic(value);
}

export async function writeLocalDiagnostic(
  input: LocalDiagnosticInput,
  file: LocalDiagnosticFileInput,
): Promise<LocalDiagnostic> {
  const component = requireIdentifier(input.component, "Diagnostic component");
  const code = requireIdentifier(input.code, "Diagnostic code");
  if (!isDiagnosticSeverity(input.severity)) {
    throw new TypeError("Diagnostic severity is invalid.");
  }
  if (typeof input.summary !== "string") {
    throw new TypeError("Diagnostic summary must be a string.");
  }

  const scan = await scanTextForSecrets(redactEmbeddedPaths(input.summary));
  const diagnostic: LocalDiagnostic = {
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    timestamp: (file.now ?? (() => new Date()))().toISOString(),
    component,
    code,
    severity: input.severity,
    summary: truncateUtf8(scan.redactedText, MAX_DIAGNOSTIC_SUMMARY_BYTES),
    ...(input.path === undefined ? {} : { path: redactedPath }),
  };

  let releaseLock: (() => void) | undefined;
  try {
    ensureOwnerOnlyDirectory(dirname(file.filePath));
    releaseLock = await acquireDiagnosticLock(file.filePath);
    removeOrphanDiagnosticTemporaryFiles(file.filePath);
    ensureOwnerOnlyFile(file.filePath);
    const existing = readLocalDiagnostics(file.filePath);
    const retained = [...existing, diagnostic].slice(-MAX_LOCAL_DIAGNOSTICS);
    const contents = `${retained.map(serializeDiagnostic).join("\n")}\n`;
    writeDiagnosticsAtomically(file.filePath, contents);
  } catch (error) {
    throw new LocalDiagnosticWriteError(file.filePath, error);
  } finally {
    releaseLock?.();
  }
  return diagnostic;
}

export function readLocalDiagnostics(filePath: string): ReadonlyArray<LocalDiagnostic> {
  try {
    if (statSync(filePath).size > MAX_LOCAL_DIAGNOSTICS_BYTES) {
      throw new TypeError("Diagnostic history exceeds the maximum size.");
    }
    const contents = readFileSync(filePath, "utf8");
    if (contents.trim().length === 0) {
      return [];
    }
    const lines = contents.trimEnd().split("\n");
    if (lines.length > MAX_LOCAL_DIAGNOSTICS) {
      throw new TypeError("Diagnostic history exceeds the maximum record count.");
    }
    return lines.map((line) => {
      if (Buffer.byteLength(line, "utf8") > MAX_DIAGNOSTIC_RECORD_BYTES) {
        throw new TypeError("Diagnostic record exceeds the maximum size.");
      }
      return parseDiagnostic(JSON.parse(line) as unknown);
    });
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw new LocalDiagnosticReadError(filePath, error);
  }
}

export function createHealthReport(
  checks: ReadonlyArray<HealthCheck>,
  diagnostics: ReadonlyArray<LocalDiagnostic> = [],
  now: () => Date = () => new Date(),
): HealthReport {
  const validatedChecks = checks.map((check) => {
    if (typeof check !== "object" || check === null || !isHealthCheckStatus(check.status)) {
      throw new TypeError("Health check is invalid.");
    }
    const component = requireIdentifier(check.component, "Health check component");
    const reason = check.reason === undefined ? undefined : requireIdentifier(check.reason, "Health check reason");
    return { component, status: check.status, ...(reason === undefined ? {} : { reason }) };
  });
  const counts: Record<DiagnosticSeverity, number> = { info: 0, warning: 0, error: 0 };
  for (const diagnostic of diagnostics) {
    counts[validateHistoricalDiagnostic(diagnostic).severity] += 1;
  }

  const status = validatedChecks.some((check) => check.status === "unavailable")
    ? "unavailable"
    : validatedChecks.some((check) => check.status === "degraded")
      ? "degraded"
      : "healthy";

  return {
    generatedAt: now().toISOString(),
    status,
    externalTelemetry: false,
    checks: validatedChecks,
    diagnostics: counts,
  };
}
