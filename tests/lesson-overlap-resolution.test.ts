import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  migrateSqliteSchema,
  openSqliteConnection,
  proposeLessonCandidate,
  releaseSchemaMigrations,
  resolvePendingLessonOverlap,
  type LessonCandidateDraft,
  type SecretScanResult,
  type SqliteConnection,
} from "../src/core/index.js";

function withDatabase(run: (connection: SqliteConnection) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-overlap-resolution-"));
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
    "2026-09-06T00:00:00.000Z",
    "2026-09-06T00:00:00.000Z",
  ]);
}

function insertConfirmedLesson(
  connection: SqliteConnection,
  lessonId: string,
  opts: { title: string; body: string; scope?: "global" | "project"; projectId?: string | null },
): void {
  const scope = opts.scope ?? "global";
  const projectId = opts.projectId ?? null;
  connection.database.run(
    "INSERT INTO lessons (id, project_id, scope, active_version, created_at, updated_at) VALUES (?, ?, ?, 1, '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z')",
    [lessonId, projectId, scope],
  );
  connection.database.run(
    "INSERT INTO lesson_versions (lesson_id, version, title, body, rationale, applicability_json, provenance_json, created_at) VALUES (?, 1, ?, ?, 'Original.', '{}', '{}', '2026-09-05T00:00:00.000Z')",
    [lessonId, opts.title, opts.body],
  );
}

const clearScan: SecretScanResult = {
  disposition: "clear",
  findings: [],
  redactedText: "",
};

const acknowledgmentScan: SecretScanResult = {
  disposition: "acknowledgment-required",
  findings: [
    {
      confidence: "low",
      kinds: ["hash"],
      region: { start: 0, end: 10 },
      scannerRuleIds: ["test-rule"],
    },
  ],
  redactedText: "[REDACTED] rest",
};

function draftFor(overrides: Partial<LessonCandidateDraft> = {}): LessonCandidateDraft {
  return {
    title: overrides.title ?? "Updated naming convention",
    body: overrides.body ?? "Use snake_case for variables instead.",
    rationale: overrides.rationale ?? "Team decided to switch.",
    applicability: overrides.applicability ?? { taskTypes: ["coding"] },
    provenance: overrides.provenance ?? { source: "correction" },
  };
}

function proposeCandidate(
  connection: SqliteConnection,
  draft: LessonCandidateDraft,
  opts?: { scope?: "global" | "project"; projectId?: string | null; secretScan?: SecretScanResult; now?: Date },
) {
  return proposeLessonCandidate(connection, {
    projectId: opts?.projectId ?? null,
    scope: opts?.scope ?? "global",
    draft,
    secretScan: opts?.secretScan ?? clearScan,
    ...(opts?.now === undefined ? {} : { now: opts.now, reviewWindowDays: 1 }),
  });
}

function pendingCandidateCount(connection: SqliteConnection): number {
  return connection.database.query<{ count: number }, []>("SELECT count(*) AS count FROM pending_lesson_candidates").get()!
    .count;
}

function lessonState(connection: SqliteConnection, lessonId: string): { active_version: number; version_count: number } {
  const active = connection.database
    .query<{ active_version: number | null }, [string]>("SELECT active_version FROM lessons WHERE id = ?")
    .get(lessonId);
  const versionCount = connection.database
    .query<{ count: number }, [string]>("SELECT count(*) AS count FROM lesson_versions WHERE lesson_id = ?")
    .get(lessonId);
  return {
    active_version: active?.active_version ?? -1,
    version_count: versionCount?.count ?? 0,
  };
}

// --- happy path ---

test("resolves by superseding with the stored draft verbatim and rejecting the candidate", () => {
  withDatabase((connection) => {
    insertConfirmedLesson(connection, "lesson-1", {
      title: "Old naming convention",
      body: "Use camelCase for variables.",
    });
    const draft = draftFor();
    const candidate = proposeCandidate(connection, draft);

    const result = resolvePendingLessonOverlap(connection, {
      candidateId: candidate.id,
      overlappingLessonId: "lesson-1",
      callerProjectId: null,
    });

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.supersession.lessonId).toBe("lesson-1");
    expect(result.supersession.supersededVersion).toBe(1);
    expect(result.supersession.version).toBe(2);
    expect(result.supersession.activeVersion).toBe(2);

    const superseded = connection.database
      .query<{ superseded_by_version: number | null }, [string, number]>(
        "SELECT superseded_by_version FROM lesson_versions WHERE lesson_id = ? AND version = ?",
      )
      .get("lesson-1", 1);
    expect(superseded?.superseded_by_version).toBe(2);

    const replacement = connection.database
      .query<{ title: string; body: string; rationale: string; applicability_json: string; provenance_json: string }, [string, number]>(
        "SELECT title, body, rationale, applicability_json, provenance_json FROM lesson_versions WHERE lesson_id = ? AND version = ?",
      )
      .get("lesson-1", 2);
    expect(replacement?.title).toBe(draft.title);
    expect(replacement?.body).toBe(draft.body);
    expect(replacement?.rationale).toBe(draft.rationale);
    expect(JSON.parse(replacement?.applicability_json ?? "{}")).toEqual(draft.applicability);
    expect(JSON.parse(replacement?.provenance_json ?? "{}")).toEqual(draft.provenance);

    expect(pendingCandidateCount(connection)).toBe(0);
  });
});

// --- missing inputs ---

test("fails when the candidate does not exist and leaves the lesson untouched", () => {
  withDatabase((connection) => {
    insertConfirmedLesson(connection, "lesson-1", { title: "Existing", body: "Existing body." });

    const result = resolvePendingLessonOverlap(connection, {
      candidateId: "no-such-candidate",
      overlappingLessonId: "lesson-1",
      callerProjectId: null,
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("not found");
    }
    expect(lessonState(connection, "lesson-1")).toEqual({ active_version: 1, version_count: 1 });
  });
});

test("fails when the overlapping lesson does not exist and keeps the candidate pending", () => {
  withDatabase((connection) => {
    const candidate = proposeCandidate(connection, draftFor());

    const result = resolvePendingLessonOverlap(connection, {
      candidateId: candidate.id,
      overlappingLessonId: "no-such-lesson",
      callerProjectId: null,
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("not found");
    }
    expect(pendingCandidateCount(connection)).toBe(1);
  });
});

// --- expiry ---

test("fails atomically when the candidate expired and mutates nothing", () => {
  withDatabase((connection) => {
    insertConfirmedLesson(connection, "lesson-1", { title: "Existing", body: "Existing body." });
    const candidate = proposeCandidate(connection, draftFor(), { now: new Date("2026-09-01T00:00:00.000Z") });

    const result = resolvePendingLessonOverlap(connection, {
      candidateId: candidate.id,
      overlappingLessonId: "lesson-1",
      callerProjectId: null,
      now: new Date("2026-09-10T00:00:00.000Z"),
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("expired");
    }
    expect(lessonState(connection, "lesson-1")).toEqual({ active_version: 1, version_count: 1 });
    expect(pendingCandidateCount(connection)).toBe(1);
  });
});

// --- scope and project guards ---

test("fails when candidate and lesson scopes do not match", () => {
  withDatabase((connection) => {
    insertProject(connection, "proj-1");
    insertConfirmedLesson(connection, "lesson-1", { title: "Global lesson", body: "Global body." });
    const candidate = proposeCandidate(connection, draftFor(), { scope: "project", projectId: "proj-1" });

    const result = resolvePendingLessonOverlap(connection, {
      candidateId: candidate.id,
      overlappingLessonId: "lesson-1",
      callerProjectId: "proj-1",
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("does not match");
    }
    expect(lessonState(connection, "lesson-1")).toEqual({ active_version: 1, version_count: 1 });
    expect(pendingCandidateCount(connection)).toBe(1);
  });
});

test("rejects a caller outside the candidate's project", () => {
  withDatabase((connection) => {
    insertProject(connection, "proj-a");
    insertProject(connection, "proj-b");
    insertConfirmedLesson(connection, "lesson-1", {
      title: "Project lesson",
      body: "Project body.",
      scope: "project",
      projectId: "proj-b",
    });
    const candidate = proposeCandidate(connection, draftFor(), { scope: "project", projectId: "proj-b" });

    const unauthorized = resolvePendingLessonOverlap(connection, {
      candidateId: candidate.id,
      overlappingLessonId: "lesson-1",
      callerProjectId: "proj-a",
    });
    expect(unauthorized.status).toBe("failed");
    if (unauthorized.status === "failed") {
      expect(unauthorized.error).toContain("project");
    }

    const unauthenticated = resolvePendingLessonOverlap(connection, {
      candidateId: candidate.id,
      overlappingLessonId: "lesson-1",
      callerProjectId: null,
    });
    expect(unauthenticated.status).toBe("failed");

    expect(lessonState(connection, "lesson-1")).toEqual({ active_version: 1, version_count: 1 });
    expect(pendingCandidateCount(connection)).toBe(1);
  });
});

test("authorizes the candidate's own project to resolve", () => {
  withDatabase((connection) => {
    insertProject(connection, "proj-b");
    insertConfirmedLesson(connection, "lesson-1", {
      title: "Project lesson",
      body: "Project body.",
      scope: "project",
      projectId: "proj-b",
    });
    const candidate = proposeCandidate(connection, draftFor(), { scope: "project", projectId: "proj-b" });

    const result = resolvePendingLessonOverlap(connection, {
      candidateId: candidate.id,
      overlappingLessonId: "lesson-1",
      callerProjectId: "proj-b",
    });

    expect(result.status).toBe("resolved");
  });
});

test("a global candidate carries no caller-project requirement", () => {
  withDatabase((connection) => {
    insertProject(connection, "proj-a");
    insertConfirmedLesson(connection, "lesson-1", { title: "Global lesson", body: "Global body." });
    const candidate = proposeCandidate(connection, draftFor());

    const result = resolvePendingLessonOverlap(connection, {
      candidateId: candidate.id,
      overlappingLessonId: "lesson-1",
      callerProjectId: "proj-a",
    });

    expect(result.status).toBe("resolved");
  });
});

// --- secret acknowledgment gate ---

test("requires explicit acknowledgment for candidates carrying low-confidence secret findings", () => {
  withDatabase((connection) => {
    insertConfirmedLesson(connection, "lesson-1", { title: "Existing", body: "Existing body." });
    const candidate = proposeCandidate(connection, draftFor(), { secretScan: acknowledgmentScan });

    const withoutAcknowledgment = resolvePendingLessonOverlap(connection, {
      candidateId: candidate.id,
      overlappingLessonId: "lesson-1",
      callerProjectId: null,
    });
    expect(withoutAcknowledgment.status).toBe("failed");
    if (withoutAcknowledgment.status === "failed") {
      expect(withoutAcknowledgment.error).toContain("acknowledgment");
    }
    expect(lessonState(connection, "lesson-1")).toEqual({ active_version: 1, version_count: 1 });

    const withAcknowledgment = resolvePendingLessonOverlap(connection, {
      candidateId: candidate.id,
      overlappingLessonId: "lesson-1",
      callerProjectId: null,
      acknowledgedSecretRisk: true,
    });
    expect(withAcknowledgment.status).toBe("resolved");
  });
});

// --- atomicity ---

test("a rejection failure after supersession rolls back the whole transaction", () => {
  withDatabase((connection) => {
    insertConfirmedLesson(connection, "lesson-1", { title: "Old naming convention", body: "Use camelCase." });
    const candidate = proposeCandidate(connection, draftFor());

    const originalRun = connection.database.run.bind(connection.database);
    connection.database.run = (...args: Parameters<typeof originalRun>) => {
      const command = args[0];
      if (typeof command === "string" && command.startsWith("DELETE FROM pending_lesson_candidates")) {
        throw new Error("Injected candidate rejection failure.");
      }
      return originalRun(...args);
    };

    const result = resolvePendingLessonOverlap(connection, {
      candidateId: candidate.id,
      overlappingLessonId: "lesson-1",
      callerProjectId: null,
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("Injected candidate rejection failure");
    }
    expect(lessonState(connection, "lesson-1")).toEqual({ active_version: 1, version_count: 1 });
    expect(pendingCandidateCount(connection)).toBe(1);
  });
});

test("a target lesson superseded mid-review fails the resolution without mutating anything", () => {
  withDatabase((connection) => {
    insertConfirmedLesson(connection, "lesson-1", { title: "Old naming convention", body: "Use camelCase." });
    connection.database.run(
      "INSERT INTO lesson_versions (lesson_id, version, title, body, rationale, applicability_json, provenance_json, created_at) VALUES (?, 2, 'Newest', 'Newest body.', 'Newest.', '{}', '{}', '2026-09-06T00:00:00.000Z')",
      ["lesson-1"],
    );
    connection.database.run("UPDATE lesson_versions SET superseded_by_version = 2 WHERE lesson_id = ? AND version = 1", [
      "lesson-1",
    ]);
    const candidate = proposeCandidate(connection, draftFor());

    const result = resolvePendingLessonOverlap(connection, {
      candidateId: candidate.id,
      overlappingLessonId: "lesson-1",
      callerProjectId: null,
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("already superseded");
    }
    expect(lessonState(connection, "lesson-1")).toEqual({ active_version: 1, version_count: 2 });
    expect(pendingCandidateCount(connection)).toBe(1);
  });
});