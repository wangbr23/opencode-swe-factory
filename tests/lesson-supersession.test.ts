import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LessonSupersessionError,
  migrateSqliteSchema,
  openSqliteConnection,
  proposeLessonCandidate,
  readActiveLessonVersion,
  releaseSchemaMigrations,
  reviewLessonCandidate,
  supersedeLesson,
  type SecretScanResult,
  type SqliteConnection,
} from "../src/core/index.js";

function withDatabase(run: (connection: SqliteConnection) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-supersession-"));
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

function draftFor(overrides: Partial<{ title: string; body: string }> = {}) {
  return {
    title: overrides.title ?? "Run tests before commits",
    body: overrides.body ?? "Always run bun test before committing.",
    rationale: "User corrected a commit without tests.",
    applicability: { taskTypes: ["commit"] },
    provenance: { source: "correction" },
  };
}

/** Creates one approved global lesson through the normal approval flow. */
function createApprovedLesson(connection: SqliteConnection, title?: string): string {
  const candidate = proposeLessonCandidate(connection, {
    projectId: null,
    scope: "global",
    draft: draftFor(title === undefined ? {} : { title }),
    secretScan: clearScan,
  });
  const outcome = reviewLessonCandidate(connection, { candidateId: candidate.id, decision: "approve" });
  if (outcome.status !== "approved") {
    throw new Error("Expected approval in test setup.");
  }
  return outcome.lesson.lessonId;
}

test("reads the active version with parsed metadata", () => {
  withDatabase((connection) => {
    const lessonId = createApprovedLesson(connection);

    const active = readActiveLessonVersion(connection, lessonId);
    expect(active).not.toBeNull();
    expect(active?.version).toBe(1);
    expect(active?.supersededByVersion).toBeNull();
    expect(active?.title).toBe("Run tests before commits");
    expect(active?.applicability).toEqual({ taskTypes: ["commit"] });
    expect(active?.provenance).toEqual({ source: "correction" });
  });
});

test("returns null for unknown lessons", () => {
  withDatabase((connection) => {
    expect(readActiveLessonVersion(connection, "no-such-lesson")).toBeNull();
  });
});

test("superseding creates a new immutable version and preserves prior content and provenance", () => {
  withDatabase((connection) => {
    const lessonId = createApprovedLesson(connection);
    const original = readActiveLessonVersion(connection, lessonId);
    if (!original) {
      throw new Error("Expected an active version in test setup.");
    }

    const result = supersedeLesson(connection, {
      lessonId,
      draft: {
        title: "Run tests and typecheck",
        body: "Run bun test and tsc before committing.",
        rationale: "Refined after review.",
        applicability: { taskTypes: ["commit", "refactor"] },
        provenance: { source: "merge" },
      },
      now: new Date("2026-09-05T00:00:00.000Z"),
    });

    expect(result).toEqual({
      lessonId,
      supersededVersion: 1,
      version: 2,
      activeVersion: 2,
    });

    const active = readActiveLessonVersion(connection, lessonId);
    expect(active?.version).toBe(2);
    expect(active?.title).toBe("Run tests and typecheck");
    expect(active?.supersededByVersion).toBeNull();

    const versions = connection.database
      .query<{ version: number; title: string; superseded_by_version: number | null; created_at: string }, [string]>(
        "SELECT version, title, superseded_by_version, created_at FROM lesson_versions WHERE lesson_id = ? ORDER BY version",
      )
      .all(lessonId);
    expect(versions[0]?.created_at).toBe(original.createdAt);
    expect(versions[0]).toEqual({
      version: 1,
      title: "Run tests before commits",
      superseded_by_version: 2,
      created_at: original.createdAt,
    });
    expect(versions[1]).toEqual({
      version: 2,
      title: "Run tests and typecheck",
      superseded_by_version: null,
      created_at: "2026-09-05T00:00:00.000Z",
    });
  });
});

test("builds a supersession chain and refuses dangling pointers at the schema level", () => {
  withDatabase((connection) => {
    const lessonId = createApprovedLesson(connection);
    supersedeLesson(connection, { lessonId, draft: draftFor({ title: "v2" }) });
    supersedeLesson(connection, { lessonId, draft: draftFor({ title: "v3" }) });

    // Version history forms a chain: 1 -> 2 -> 3, active is 3.
    expect(
      connection.database
        .query<{ version: number; superseded_by_version: number | null }, [string]>(
          "SELECT version, superseded_by_version FROM lesson_versions WHERE lesson_id = ? ORDER BY version",
        )
        .all(lessonId),
    ).toEqual([
      { version: 1, superseded_by_version: 2 },
      { version: 2, superseded_by_version: 3 },
      { version: 3, superseded_by_version: null },
    ]);
    expect(readActiveLessonVersion(connection, lessonId)?.version).toBe(3);

    // The composite foreign key refuses a supersession pointer to a
    // nonexistent version, so the chain can never dangle.
    expect(() =>
      connection.database.run("UPDATE lesson_versions SET superseded_by_version = 99 WHERE lesson_id = ? AND version = 1", [lessonId]),
    ).toThrow(/FOREIGN KEY/);
  });
});

test("detects an active-version pointer left on a superseded version", () => {
  withDatabase((connection) => {
    const lessonId = createApprovedLesson(connection);
    supersedeLesson(connection, { lessonId, draft: draftFor({ title: "v2" }) });

    // active_version has no FK by design (the state machine owns it), so a
    // pointer left on a superseded version must be detected as invalid.
    connection.database.run("UPDATE lessons SET active_version = 1 WHERE id = ?", [lessonId]);
    expect(() => readActiveLessonVersion(connection, lessonId)).toThrow(/marked superseded/);
  });
});

test("approval through the candidate flow marks the previous version superseded", () => {
  withDatabase((connection) => {
    const lessonId = createApprovedLesson(connection);

    const second = proposeLessonCandidate(connection, {
      projectId: null,
      scope: "global",
      draft: draftFor({ title: "Run typecheck too" }),
      secretScan: clearScan,
    });
    reviewLessonCandidate(connection, { candidateId: second.id, decision: "approve" });

    const versions = connection.database
      .query<{ version: number; superseded_by_version: number | null }, [string]>(
        "SELECT version, superseded_by_version FROM lesson_versions WHERE lesson_id = ? ORDER BY version",
      )
      .all(lessonId);
    expect(versions).toEqual([
      { version: 1, superseded_by_version: 2 },
      { version: 2, superseded_by_version: null },
    ]);
    expect(readActiveLessonVersion(connection, lessonId)?.version).toBe(2);
  });
});

test("supersede refuses unknown lessons and never rewrites immutable content", () => {
  withDatabase((connection) => {
    expect(() => supersedeLesson(connection, { lessonId: "missing", draft: draftFor() })).toThrow(LessonSupersessionError);

    const lessonId = createApprovedLesson(connection);
    supersedeLesson(connection, {
      lessonId,
      draft: { ...draftFor(), title: "Edited body", body: "Edited." },
      now: new Date("2026-09-05T00:00:00.000Z"),
    });

    // Version 1 rows keep their original content after supersession.
    expect(
      connection.database
        .query<{ title: string; body: string }, [string, number]>(
          "SELECT title, body FROM lesson_versions WHERE lesson_id = ? AND version = ?",
        )
        .get(lessonId, 1),
    ).toEqual({ title: "Run tests before commits", body: "Always run bun test before committing." });
  });
});