import { randomUUID } from "node:crypto";

import { markVersionSuperseded } from "./lesson-supersession.js";
import { DEFAULT_CANDIDATE_REVIEW_WINDOW_DAYS } from "../types/lessons-types.js";
import type {
  ApprovedLesson,
  LessonCandidate,
  LessonCandidateDraft,
  LessonCandidateReviewOutcome,
  LessonScope,
  ListPendingCandidatesInput,
  PendingLessonCandidateSummary,
  ProposeLessonCandidateInput,
  ReviewLessonCandidateInput,
} from "../types/lessons-types.js";
import type { SecretScanDisposition, SecretScanResult } from "./secrets.js";
import type { SqliteConnection } from "./sqlite.js";

export { DEFAULT_CANDIDATE_REVIEW_WINDOW_DAYS } from "../types/lessons-types.js";
export type {
  ApprovedLesson,
  LessonCandidate,
  LessonCandidateDecision,
  LessonCandidateDraft,
  LessonCandidateReviewOutcome,
  LessonScope,
  ListPendingCandidatesInput,
  PendingLessonCandidateSummary,
  ProposeLessonCandidateInput,
  ReviewLessonCandidateInput,
} from "../types/lessons-types.js";

export class LessonCandidateError extends Error {
  readonly candidateId: string | undefined;

  constructor(message: string, candidateId?: string) {
    super(message);
    this.name = "LessonCandidateError";
    this.candidateId = candidateId;
  }
}

export class LessonCandidateExpiredError extends LessonCandidateError {}

/**
 * The pending_candidates table stores a single draft_json document, so the
 * secret-scan verdict rides inside it. This envelope is parsed strictly on
 * read; scan regions let the approval UI show the exact flagged region.
 */
type StoredCandidate = Readonly<{
  draft: LessonCandidateDraft;
  secretScan: Pick<SecretScanResult, "disposition" | "findings">;
}>;

type CandidateRow = Readonly<{
  id: string;
  project_id: string | null;
  scope: LessonScope;
  draft_json: string;
  created_at: string;
  expires_at: string;
}>;

type LessonRow = Readonly<{
  id: string;
  scope: LessonScope;
  project_id: string | null;
  active_version: number | null;
  created_at: string;
}>;

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new LessonCandidateError(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireJsonObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LessonCandidateError(`${label} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function parseDraft(input: unknown): LessonCandidateDraft {
  const record = requireJsonObject(input, "Candidate draft");
  for (const key of Object.keys(record)) {
    if (!["title", "body", "rationale", "applicability", "provenance"].includes(key)) {
      throw new LessonCandidateError(`Candidate draft contains unknown key "${key}".`);
    }
  }
  return {
    title: requireNonEmptyString(record.title, "Candidate draft title"),
    body: requireNonEmptyString(record.body, "Candidate draft body"),
    rationale: requireNonEmptyString(record.rationale, "Candidate draft rationale"),
    applicability: requireJsonObject(record.applicability ?? {}, "Candidate draft applicability"),
    provenance: requireJsonObject(record.provenance ?? {}, "Candidate draft provenance"),
  };
}

function parseStoredCandidate(draftJson: string): StoredCandidate {
  const envelope = requireJsonObject(JSON.parse(draftJson), "Stored candidate");
  for (const key of Object.keys(envelope)) {
    if (!["draft", "secretScan"].includes(key)) {
      throw new LessonCandidateError("Stored candidate draft has an unexpected shape.");
    }
  }
  const scan = requireJsonObject(envelope.secretScan ?? {}, "Stored candidate secretScan");
  const disposition = scan.disposition;
  if (disposition !== "clear" && disposition !== "acknowledgment-required") {
    throw new LessonCandidateError("Stored candidate secret scan disposition is invalid.");
  }
  return {
    draft: parseDraft(envelope.draft),
    secretScan: { disposition: disposition as SecretScanDisposition, findings: [] },
  };
}

function assertScopeConsistency(scope: LessonScope, projectId: string | null): void {
  if (scope === "project" && projectId === null) {
    throw new LessonCandidateError("Project-scoped lessons require a project id.");
  }
  if (scope === "global" && projectId !== null) {
    throw new LessonCandidateError("Global-scoped lessons must not carry a project id.");
  }
}

function getCandidateRow(connection: SqliteConnection, candidateId: string): CandidateRow {
  const row = connection.database
    .query<CandidateRow, [string]>(
      "SELECT id, project_id, scope, draft_json, created_at, expires_at FROM pending_lesson_candidates WHERE id = ?",
    )
    .get(candidateId);
  if (!row) {
    throw new LessonCandidateError(`Pending lesson candidate ${candidateId} was not found.`, candidateId);
  }
  return row;
}

function assertNotExpired(row: CandidateRow, now: Date): void {
  if (now.getTime() >= Date.parse(row.expires_at)) {
    throw new LessonCandidateExpiredError(`Pending lesson candidate ${row.id} expired at ${row.expires_at}.`, row.id);
  }
}

function nextLessonVersion(connection: SqliteConnection, lessonId: string): number {
  const row = connection.database
    .query<{ max_version: number | null }, [string]>("SELECT max(version) AS max_version FROM lesson_versions WHERE lesson_id = ?")
    .get(lessonId);
  return (row?.max_version ?? 0) + 1;
}

function commitApprovedVersion(
  connection: SqliteConnection,
  row: CandidateRow,
  draft: LessonCandidateDraft,
  approvedAt: string,
): ApprovedLesson {
  const existing = (
    connection.database
      .query<LessonRow, [string | null, LessonScope]>(
        "SELECT id, scope, project_id, active_version, created_at FROM lessons WHERE project_id IS ? AND scope = ?",
      )
      .get(row.project_id, row.scope) ?? undefined
  ) as LessonRow | undefined;

  let lessonId: string;
  let version: number;
  let activeVersion: number;
  let createdAt: string;

  if (existing) {
    lessonId = existing.id;
    createdAt = existing.created_at;
    version = nextLessonVersion(connection, lessonId);
    activeVersion = version;
    connection.database.run(
      "INSERT INTO lesson_versions (lesson_id, version, title, body, rationale, applicability_json, provenance_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        lessonId,
        version,
        draft.title,
        draft.body,
        draft.rationale,
        JSON.stringify(draft.applicability),
        JSON.stringify(draft.provenance),
        approvedAt,
      ],
    );
    if (existing.active_version !== null) {
      markVersionSuperseded(connection, lessonId, existing.active_version, activeVersion);
    }
    connection.database.run("UPDATE lessons SET active_version = ?, updated_at = ? WHERE id = ?", [
      activeVersion,
      approvedAt,
      lessonId,
    ]);
  } else {
    lessonId = randomUUID();
    version = 1;
    activeVersion = version;
    createdAt = approvedAt;
    connection.database.run(
      "INSERT INTO lessons (id, project_id, scope, active_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [lessonId, row.project_id, row.scope, activeVersion, approvedAt, approvedAt],
    );
    connection.database.run(
      "INSERT INTO lesson_versions (lesson_id, version, title, body, rationale, applicability_json, provenance_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        lessonId,
        version,
        draft.title,
        draft.body,
        draft.rationale,
        JSON.stringify(draft.applicability),
        JSON.stringify(draft.provenance),
        approvedAt,
      ],
    );
  }

  return { lessonId, version, scope: row.scope, projectId: row.project_id, activeVersion, createdAt };
}

/**
 * Creates a pending candidate from a validated, secret-scanned draft.
 * Blocked scans are refused here; acknowledgment-required scans persist the
 * verdict inside the stored draft so approval must carry an explicit
 * acknowledgment. The caller remains responsible for rendering flagged
 * regions from the scan result before asking the user to decide.
 */
export function proposeLessonCandidate(
  connection: SqliteConnection,
  input: ProposeLessonCandidateInput,
): LessonCandidate {
  assertScopeConsistency(input.scope, input.projectId);
  const draft = parseDraft(input.draft);

  if (input.secretScan.disposition === "blocked") {
    throw new LessonCandidateError("High-confidence secret findings block lesson candidates.");
  }

  const now = input.now ?? new Date();
  const reviewWindowDays = input.reviewWindowDays ?? DEFAULT_CANDIDATE_REVIEW_WINDOW_DAYS;
  if (!Number.isFinite(reviewWindowDays) || reviewWindowDays <= 0) {
    throw new LessonCandidateError("Candidate review window must be a positive number of days.");
  }
  const expiresAt = new Date(now.getTime() + reviewWindowDays * 24 * 60 * 60 * 1000).toISOString();
  const candidateId = randomUUID();
  const stored: StoredCandidate = {
    draft,
    secretScan: { disposition: input.secretScan.disposition, findings: [] },
  };

  connection.database.transaction(() => {
    connection.database.run(
      "INSERT INTO pending_lesson_candidates (id, project_id, scope, draft_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      [candidateId, input.projectId, input.scope, JSON.stringify(stored), now.toISOString(), expiresAt],
    );
  })();

  return {
    id: candidateId,
    projectId: input.projectId,
    scope: input.scope,
    draft,
    secretScan: { disposition: input.secretScan.disposition, findings: input.secretScan.findings },
    requiresAcknowledgment: input.secretScan.disposition === "acknowledgment-required",
    createdAt: now.toISOString(),
    expiresAt,
  };
}

/**
 * Applies the human decision for a pending candidate:
 * - approve: creates an immutable lesson version, activates it, deletes the candidate
 * - reject: deletes the candidate and its content without leaving a trace
 * - defer: leaves the candidate pending until its original expiry
 */
export function reviewLessonCandidate(
  connection: SqliteConnection,
  input: ReviewLessonCandidateInput,
): LessonCandidateReviewOutcome {
  const now = input.now ?? new Date();

  return connection.database.transaction((): LessonCandidateReviewOutcome => {
    const row = getCandidateRow(connection, input.candidateId);
    assertNotExpired(row, now);
    const stored = parseStoredCandidate(row.draft_json);

    if (input.decision === "reject") {
      connection.database.run("DELETE FROM pending_lesson_candidates WHERE id = ?", [row.id]);
      return { status: "rejected", deletedCandidateId: row.id };
    }

    if (input.decision === "defer") {
      return { status: "deferred", candidateId: row.id, expiresAt: row.expires_at };
    }

    if (stored.secretScan.disposition === "acknowledgment-required" && input.acknowledgedSecretRisk !== true) {
      throw new LessonCandidateError(
        "Candidate carries low-confidence secret findings; approval requires explicit acknowledgment.",
        row.id,
      );
    }

    const lesson = commitApprovedVersion(connection, row, stored.draft, now.toISOString());
    connection.database.run("DELETE FROM pending_lesson_candidates WHERE id = ?", [row.id]);
    return { status: "approved", lesson };
  })();
}

export function listPendingLessonCandidates(
  connection: SqliteConnection,
  input?: ListPendingCandidatesInput,
): ReadonlyArray<PendingLessonCandidateSummary> {
  const now = input?.now ?? new Date();
  const includeExpired = input?.includeExpired ?? false;

  const rows = connection.database
    .query<CandidateRow, []>(
      "SELECT id, project_id, scope, draft_json, created_at, expires_at FROM pending_lesson_candidates ORDER BY created_at ASC",
    )
    .all();

  const results: PendingLessonCandidateSummary[] = [];
  for (const row of rows) {
    const expired = now.getTime() >= Date.parse(row.expires_at);
    if (expired && !includeExpired) continue;
    const stored = parseStoredCandidate(row.draft_json);
    results.push({
      id: row.id,
      projectId: row.project_id,
      scope: row.scope,
      draft: stored.draft,
      requiresAcknowledgment: stored.secretScan.disposition === "acknowledgment-required",
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      expired,
    });
  }

  return results;
}
