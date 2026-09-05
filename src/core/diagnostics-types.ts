export const DIAGNOSTIC_SCHEMA_VERSION = 1 as const;
export const MAX_DIAGNOSTIC_RECORD_BYTES = 4_096;
export const MAX_LOCAL_DIAGNOSTICS = 100;
export const MAX_LOCAL_DIAGNOSTICS_BYTES = MAX_DIAGNOSTIC_RECORD_BYTES * MAX_LOCAL_DIAGNOSTICS + MAX_LOCAL_DIAGNOSTICS;

export const MAX_IDENTIFIER_LENGTH = 64;
export const MAX_DIAGNOSTIC_SUMMARY_BYTES = 2_048;
export const DIAGNOSTIC_LOCK_TIMEOUT_MS = 500;
export const DIAGNOSTIC_LOCK_RETRY_MS = 10;
export const STALE_DIAGNOSTIC_LOCK_MS = 30_000;
export const redactedPath = "[REDACTED_PATH]";
export const truncatedSummary = "[TRUNCATED]";
export const embeddedPathStartPattern = /file:\/\/|\\\\|\b[a-z]:[\\/]|\/(?=[^\s/])|(?<![:/\\])\.\.?[\\/]|(?<![:/\\])\S[^\r\n\\/]*[\\/]/iu;
export const diagnosticTemporaryFilePattern = /^[0-9]+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i;

export type DiagnosticLockMetadata = Readonly<{
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
