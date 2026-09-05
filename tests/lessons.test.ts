import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LessonCandidateError,
  LessonCandidateExpiredError,
  migrateSqliteSchema,
  openSqliteConnection,
  proposeLessonCandidate,
  releaseSchemaMigrations,
  reviewLessonCandidate,
  type SecretScanResult,
  type SqliteConnection,
} from "../src/core/index.js";

function withDatabase(run: (connection: SqliteConnection) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-lessons-"));
  const connection = openSqliteConnection(join(directory, "memory.sqlite"));
  migrateSqliteSchema(connection, releaseSchemaMigrations);
  try {
    run(connection);
  } finally {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function insertProject(connection: SqliteConnection, id: string): void {
  connection.database.run("INSERT INTO projects (id, path, created_at, updated_at) VALUES (?, ?, ?, ?)", [
    id,
    `/repos/${id}`,
    "2026-09-04T00:00:00.000Z",
    "2026-09-04T00:00:00.000Z",
  ]);
}

const clearScan = {
  disposition: "clear",
  findings: [],
  redactedText: "",
} as const satisfies SecretScanResult;

const acknowledgmentScan = {
  disposition: "acknowledgment-required",
  findings: [
    {
      confidence: "low" as const,
      kinds: ["hash" as const],
      region: { start: 0, end: 10 },
      scannerRuleIds: ["test-rule"],
    },
  ],
  redactedText: "[REDACTED] rest",
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

test("proposes a candidate with a review window and refuses blocked scans", () => {
  withDatabase((connection) => {
    const now = new Date("2026-09-04T00:00:00.000Z");
    const candidate = proposeLessonCandidate(connection, {
      projectId: null,
      scope: "global",
      draft: draftFor(),
      secretScan: clearScan,
      now,
    });

    expect(candidate.requiresAcknowledgment).toBe(false);
    expect(candidate.expiresAt).toBe("2026-09-11T00:00:00.000Z");

    const envelope = JSON.parse(
      connection.database.query<{ draft_json: string }, []>("SELECT draft_json FROM pending_lesson_candidates").get()!
        .draft_json,
    );
    expect(envelope.secretScan.disposition).toBe("clear");
    expect(envelope.draft.title).toBe("Run tests before commits");

    expect(() =>
      proposeLessonCandidate(connection, {
        projectId: null,
        scope: "global",
        draft: draftFor(),
        secretScan: { disposition: "blocked", findings: [], redactedText: "" },
        now,
      }),
    ).toThrow(LessonCandidateError);
    expect(
      connection.database.query<{ count: number }, []>("SELECT count(*) AS count FROM pending_lesson_candidates").get(),
    ).toEqual({ count: 1 });
  });
});

test("approving a candidate creates an active immutable version and removes the candidate", () => {
  withDatabase((connection) => {
    const candidate = proposeLessonCandidate(connection, {
      projectId: null,
      scope: "global",
      draft: draftFor(),
      secretScan: clearScan,
      now: new Date("2026-09-04T00:00:00.000Z"),
    });

    const outcome = reviewLessonCandidate(connection, {
      candidateId: candidate.id,
      decision: "approve",
      now: new Date("2026-09-04T12:00:00.000Z"),
    });

    expect(outcome.status).toBe("approved");
    if (outcome.status !== "approved") {
      return;
    }
    expect(outcome.lesson.version).toBe(1);
    expect(outcome.lesson.activeVersion).toBe(1);
    expect(outcome.lesson.scope).toBe("global");
    expect(outcome.lesson.projectId).toBeNull();

    expect(connection.database.query<{ active_version: number }, []>("SELECT active_version FROM lessons").get()).toEqual({
      active_version: 1,
    });
    expect(connection.database.query<{ title: string }, []>("SELECT title FROM lesson_versions").all()).toEqual([
      { title: "Run tests before commits" },
    ]);
    expect(
      connection.database.query<{ count: number }, []>("SELECT count(*) AS count FROM pending_lesson_candidates").get(),
    ).toEqual({ count: 0 });
  });
});

test("rejecting a candidate deletes its content without creating a lesson", () => {
  withDatabase((connection) => {
    const candidate = proposeLessonCandidate(connection, {
      projectId: null,
      scope: "global",
      draft: draftFor(),
      secretScan: clearScan,
    });

    const outcome = reviewLessonCandidate(connection, { candidateId: candidate.id, decision: "reject" });

    expect(outcome).toEqual({ status: "rejected", deletedCandidateId: candidate.id });
    expect(
      connection.database.query<{ count: number }, []>("SELECT count(*) AS count FROM pending_lesson_candidates").get(),
    ).toEqual({ count: 0 });
    expect(connection.database.query<{ count: number }, []>("SELECT count(*) AS count FROM lessons").get()).toEqual({
      count: 0,
    });
  });
});

test("deferring keeps the candidate until its original expiry", () => {
  withDatabase((connection) => {
    const candidate = proposeLessonCandidate(connection, {
      projectId: null,
      scope: "global",
      draft: draftFor(),
      secretScan: clearScan,
      now: new Date("2026-09-04T00:00:00.000Z"),
    });

    const outcome = reviewLessonCandidate(connection, {
      candidateId: candidate.id,
      decision: "defer",
      now: new Date("2026-09-06T00:00:00.000Z"),
    });

    expect(outcome).toEqual({ status: "deferred", candidateId: candidate.id, expiresAt: candidate.expiresAt });
    expect(
      connection.database.query<{ count: number }, []>("SELECT count(*) AS count FROM pending_lesson_candidates").get(),
    ).toEqual({ count: 1 });
  });
});

test("a later approval creates a superseding immutable version", () => {
  withDatabase((connection) => {
    const first = proposeLessonCandidate(connection, {
      projectId: null,
      scope: "global",
      draft: draftFor(),
      secretScan: clearScan,
    });
    reviewLessonCandidate(connection, { candidateId: first.id, decision: "approve" });

    const second = proposeLessonCandidate(connection, {
      projectId: null,
      scope: "global",
      draft: draftFor({ title: "Run typecheck too" }),
      secretScan: clearScan,
    });
    const outcome = reviewLessonCandidate(connection, { candidateId: second.id, decision: "approve" });

    expect(outcome.status).toBe("approved");
    if (outcome.status === "approved") {
      expect(outcome.lesson.version).toBe(2);
      expect(outcome.lesson.activeVersion).toBe(2);
    }
    expect(connection.database.query<{ count: number }, []>("SELECT count(*) AS count FROM lessons").get()).toEqual({
      count: 1,
    });
    expect(connection.database.query<{ count: number }, []>("SELECT count(*) AS count FROM lesson_versions").get()).toEqual({
      count: 2,
    });
  });
});

test("approval requires explicit acknowledgment for low-confidence secret findings", () => {
  withDatabase((connection) => {
    const candidate = proposeLessonCandidate(connection, {
      projectId: null,
      scope: "global",
      draft: draftFor(),
      secretScan: acknowledgmentScan,
    });
    expect(candidate.requiresAcknowledgment).toBe(true);

    expect(() => reviewLessonCandidate(connection, { candidateId: candidate.id, decision: "approve" })).toThrow(
      /acknowledgment/,
    );

    const outcome = reviewLessonCandidate(connection, {
      candidateId: candidate.id,
      decision: "approve",
      acknowledgedSecretRisk: true,
    });
    expect(outcome.status).toBe("approved");
  });
});

test("expired candidates cannot be reviewed", () => {
  withDatabase((connection) => {
    const candidate = proposeLessonCandidate(connection, {
      projectId: null,
      scope: "global",
      draft: draftFor(),
      secretScan: clearScan,
      now: new Date("2026-09-04T00:00:00.000Z"),
      reviewWindowDays: 1,
    });

    expect(() =>
      reviewLessonCandidate(connection, {
        candidateId: candidate.id,
        decision: "approve",
        now: new Date("2026-09-05T00:00:00.000Z"),
      }),
    ).toThrow(LessonCandidateExpiredError);
  });
});

test("project and global candidates resolve to separate lessons", () => {
  withDatabase((connection) => {
    insertProject(connection, "proj-1");
    const projectCandidate = proposeLessonCandidate(connection, {
      projectId: "proj-1",
      scope: "project",
      draft: draftFor(),
      secretScan: clearScan,
    });
    reviewLessonCandidate(connection, { candidateId: projectCandidate.id, decision: "approve" });

    const globalCandidate = proposeLessonCandidate(connection, {
      projectId: null,
      scope: "global",
      draft: draftFor(),
      secretScan: clearScan,
    });
    reviewLessonCandidate(connection, { candidateId: globalCandidate.id, decision: "approve" });

    expect(connection.database.query<{ count: number }, []>("SELECT count(*) AS count FROM lessons").get()).toEqual({
      count: 2,
    });
    expect(
      connection.database.query<{ scope: string }, []>("SELECT scope FROM lessons ORDER BY scope").all(),
    ).toEqual([{ scope: "global" }, { scope: "project" }]);
  });
});

test("enforces scope and project consistency and validates drafts at the boundary", () => {
  withDatabase((connection) => {
    expect(() =>
      proposeLessonCandidate(connection, {
        projectId: null,
        scope: "project",
        draft: draftFor(),
        secretScan: clearScan,
      }),
    ).toThrow(/Project-scoped lessons require a project id/);

    insertProject(connection, "proj-1");
    expect(() =>
      proposeLessonCandidate(connection, {
        projectId: "proj-1",
        scope: "global",
        draft: draftFor(),
        secretScan: clearScan,
      }),
    ).toThrow(/Global-scoped lessons must not carry a project id/);

    expect(() =>
      proposeLessonCandidate(connection, {
        projectId: null,
        scope: "global",
        draft: draftFor({ title: "   " }),
        secretScan: clearScan,
      }),
    ).toThrow(/title/);

    expect(() =>
      proposeLessonCandidate(connection, {
        projectId: null,
        scope: "global",
        draft: { ...draftFor(), applicability: [] as unknown as Record<string, unknown> },
        secretScan: clearScan,
      }),
    ).toThrow(/applicability/);

    expect(() => reviewLessonCandidate(connection, { candidateId: "missing", decision: "approve" })).toThrow(
      LessonCandidateError,
    );
  });
});
