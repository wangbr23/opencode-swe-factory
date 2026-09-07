import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildSessionEndCandidateReview,
  migrateSqliteSchema,
  openSqliteConnection,
  proposeLessonCandidate,
  releaseSchemaMigrations,
  type SecretScanResult,
  type SqliteConnection,
} from "../src/core/index.js";

function withDatabase(run: (connection: SqliteConnection) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-session-end-"));
  const connection = openSqliteConnection(join(directory, "memory.sqlite"));
  migrateSqliteSchema(connection, releaseSchemaMigrations);
  try {
    run(connection);
  } finally {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const clearScan = {
  disposition: "clear",
  findings: [],
  redactedText: "",
} as const satisfies SecretScanResult;

function draftFor(title: string) {
  return {
    title,
    body: "Always run bun test before committing.",
    rationale: "User corrected a commit without tests.",
    applicability: {},
    provenance: {},
  };
}

test("session-end review lists deferred candidates and removes expired ones", () => {
  withDatabase((connection) => {
    const now = new Date("2026-09-04T00:00:00.000Z");
    const kept = proposeLessonCandidate(connection, {
      projectId: null,
      scope: "global",
      draft: draftFor("Keep this lesson"),
      secretScan: clearScan,
      now,
      reviewWindowDays: 7,
    });
    const expired = proposeLessonCandidate(connection, {
      projectId: null,
      scope: "global",
      draft: draftFor("Already expired"),
      secretScan: clearScan,
      now,
      reviewWindowDays: 1,
    });

    const later = new Date("2026-09-06T00:00:00.000Z");
    const review = buildSessionEndCandidateReview(connection, { now: later });

    expect(review.removedExpiredCandidateIds).toEqual([expired.id]);
    expect(review.pendingCandidates).toHaveLength(1);
    expect(review.pendingCandidates[0]).toMatchObject({
      candidateId: kept.id,
      title: "Keep this lesson",
      scope: "global",
      projectId: null,
      expiresAt: kept.expiresAt,
      requiresAcknowledgment: false,
    });

    expect(buildSessionEndCandidateReview(connection, { now: later }).pendingCandidates).toHaveLength(1);
  });
});

test("session-end review reports an empty session with nothing pending", () => {
  withDatabase((connection) => {
    const review = buildSessionEndCandidateReview(connection);
    expect(review.removedExpiredCandidateIds).toEqual([]);
    expect(review.pendingCandidates).toEqual([]);
  });
});
