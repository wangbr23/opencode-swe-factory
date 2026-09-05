import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cleanupExpiredCandidates,
  listPendingLessonCandidates,
  migrateSqliteSchema,
  openSqliteConnection,
  proposeLessonCandidate,
  releaseSchemaMigrations,
  type SecretScanResult,
  type SqliteConnection,
} from "../src/core/index.js";

function withDatabase(run: (connection: SqliteConnection) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-cleanup-"));
  const connection = openSqliteConnection(join(directory, "memory.sqlite"));
  migrateSqliteSchema(connection, releaseSchemaMigrations);
  try {
    run(connection);
  } finally {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const clearScan: SecretScanResult = {
  disposition: "clear",
  findings: [],
  redactedText: "",
};

function insertCandidate(
  connection: SqliteConnection,
  reviewWindowDays: number,
  now?: Date,
) {
  const base = {
    projectId: null,
    scope: "global" as const,
    draft: {
      title: "Test lesson",
      body: "Test body content for the lesson",
      rationale: "Testing cleanup.",
      applicability: {},
      provenance: {},
    },
    secretScan: clearScan,
    reviewWindowDays,
  };
  return proposeLessonCandidate(connection, now ? { ...base, now } : base);
}

test("cleanup deletes expired candidates", () => {
  withDatabase((connection) => {
    const past = new Date("2026-01-01T00:00:00.000Z");
    insertCandidate(connection, 1, past);

    const now = new Date("2026-01-10T00:00:00.000Z");
    const result = cleanupExpiredCandidates(connection, { now });

    expect(result.deletedCount).toBe(1);
    expect(result.deletedIds).toHaveLength(1);

    const remaining = listPendingLessonCandidates(connection, { now, includeExpired: true });
    expect(remaining).toHaveLength(0);
  });
});

test("cleanup preserves non-expired candidates", () => {
  withDatabase((connection) => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    insertCandidate(connection, 30, now);

    const result = cleanupExpiredCandidates(connection, { now });

    expect(result.deletedCount).toBe(0);
    expect(result.deletedIds).toHaveLength(0);

    const remaining = listPendingLessonCandidates(connection, { now });
    expect(remaining).toHaveLength(1);
  });
});

test("cleanup returns empty result when no candidates exist", () => {
  withDatabase((connection) => {
    const result = cleanupExpiredCandidates(connection);
    expect(result.deletedCount).toBe(0);
    expect(result.deletedIds).toHaveLength(0);
  });
});

test("cleanup deletes only expired candidates in a mixed set", () => {
  withDatabase((connection) => {
    const baseline = new Date("2026-01-01T00:00:00.000Z");
    const expired1 = insertCandidate(connection, 1, baseline);
    const expired2 = insertCandidate(connection, 2, baseline);
    insertCandidate(connection, 30, baseline);

    const now = new Date("2026-01-05T00:00:00.000Z");
    const result = cleanupExpiredCandidates(connection, { now });

    expect(result.deletedCount).toBe(2);
    expect(result.deletedIds).toContain(expired1.id);
    expect(result.deletedIds).toContain(expired2.id);

    const remaining = listPendingLessonCandidates(connection, { now });
    expect(remaining).toHaveLength(1);
  });
});

test("cleanup returns correct deleted IDs", () => {
  withDatabase((connection) => {
    const past = new Date("2026-01-01T00:00:00.000Z");
    const candidate = insertCandidate(connection, 1, past);

    const now = new Date("2026-01-10T00:00:00.000Z");
    const result = cleanupExpiredCandidates(connection, { now });

    expect(result.deletedIds).toEqual([candidate.id]);
  });
});

test("cleanup uses current time when no input is provided", () => {
  withDatabase((connection) => {
    const farPast = new Date("2020-01-01T00:00:00.000Z");
    insertCandidate(connection, 1, farPast);

    const result = cleanupExpiredCandidates(connection);

    expect(result.deletedCount).toBe(1);
  });
});

test("cleanup handles candidate expiring exactly at now", () => {
  withDatabase((connection) => {
    const created = new Date("2026-01-01T00:00:00.000Z");
    insertCandidate(connection, 1, created);

    const exactExpiry = new Date("2026-01-02T00:00:00.000Z");
    const result = cleanupExpiredCandidates(connection, { now: exactExpiry });

    expect(result.deletedCount).toBe(1);
  });
});
