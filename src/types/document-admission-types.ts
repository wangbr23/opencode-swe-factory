import type { SecretFinding, SecretScanDisposition } from "./secrets-types.js";

export const DOCUMENT_CONTENT_HASH_ALGORITHM = "sha256";
export const MARKDOWN_FILE_EXTENSIONS: ReadonlySet<string> = new Set([".md", ".markdown"]);

export type DocumentSourceType =
  | "project-instructions"
  | "task-state"
  | "journal"
  | "decision"
  | "specification"
  | "design"
  | "documentation";

export type DocumentAdmissionSkipReason =
  | "missing"
  | "unreadable"
  | "outside-project"
  | "unsupported-path-type"
  | "unsupported-file-type"
  | "duplicate"
  | "file-too-large"
  | "total-size-limit"
  | "binary"
  | "secret-blocked"
  | "secret-acknowledgment-required"
  | "secret-scan-failed";

export type DocumentAdmissionLimits = Readonly<{
  maxFileBytes: number;
  maxTotalBytes: number;
}>;

export type AdmitCuratedDocumentSourcesInput = Readonly<{
  projectId: string;
  projectRoot: string;
  curatedPaths: ReadonlyArray<string>;
  explicitlyApprovedExternalPaths?: ReadonlyArray<string>;
  acknowledgedSecretPaths?: ReadonlyArray<string>;
  limits: DocumentAdmissionLimits;
}>;

export type DocumentSecretScanSummary = Readonly<{
  disposition: SecretScanDisposition;
  findings: ReadonlyArray<SecretFinding>;
}>;

export type AdmittedDocumentSource = Readonly<{
  projectId: string;
  scope: "project";
  path: string;
  relativePath: string | null;
  sourceType: DocumentSourceType;
  content: string;
  contentHash: string;
  sizeBytes: number;
  modifiedAt: string;
  secretScan: DocumentSecretScanSummary;
  secretRiskAcknowledged: boolean;
}>;

export type SkippedDocumentSource = Readonly<{
  path: string;
  reason: DocumentAdmissionSkipReason;
  sizeBytes?: number;
  secretScan?: DocumentSecretScanSummary;
}>;

export type DocumentAdmissionResult = Readonly<{
  admitted: ReadonlyArray<AdmittedDocumentSource>;
  skipped: ReadonlyArray<SkippedDocumentSource>;
  totalBytes: number;
}>;

export type CollectedDocumentFile = Readonly<{
  canonicalPath: string;
  relativePath: string | null;
  sizeBytes: number;
  modifiedAt: string;
}>;
