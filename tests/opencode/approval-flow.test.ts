import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  migrateSqliteSchema,
  openSqliteConnection,
  proposeLessonCandidate,
  releaseSchemaMigrations,
  supersedeLesson,
  type SecretScanResult,
  type SqliteConnection,
} from "../../src/core/index.js";
import {
  editAndRepropose,
  formatApprovalCard,
  resolveOverlap,
} from "../../src/opencode/approval-flow.js";
import { handleProposeLesson } from "../../src/opencode/lesson-tools.js";
import type { ProposeLessonToolResult, ScanTextFn } from "../../src/types/lesson-tool-types.js";
import type { LessonCandidate } from "../../src/types/lessons-types.js";
import type { LessonOverlapMatch } from "../../src/types/lesson-duplicate-detection-types.js";

function withDatabase(run: (connection: SqliteConnection) => void | Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-approval-flow-"));
  const connection = openSqliteConnection(join(directory, "memory.sqlite"));
  migrateSqliteSchema(connection, releaseSchemaMigrations);
  const result = run(connection);
  const cleanup = () => {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  };
  if (result instanceof Promise) {
    return result.finally(cleanup);
  }
  cleanup();
  return Promise.resolve();
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

const stubClearScan: ScanTextFn = async () => clearScan;

function makeCandidate(overrides?: Partial<LessonCandidate>): LessonCandidate {
  return {
    id: "candidate-1",
    projectId: null,
    scope: "global",
    draft: {
      title: "Test lesson",
      body: "Test body content.",
      rationale: "Test rationale.",
      applicability: {},
      provenance: {},
    },
    secretScan: { disposition: "clear", findings: [] },
    requiresAcknowledgment: false,
    createdAt: "2026-09-06T00:00:00.000Z",
    expiresAt: "2026-09-13T00:00:00.000Z",
    ...overrides,
  };
}

function makeOverlap(overrides?: Partial<LessonOverlapMatch>): LessonOverlapMatch {
  return {
    lessonId: "overlap-1",
    version: 1,
    scope: "global",
    projectId: null,
    title: "Existing lesson",
    body: "Existing body content.",
    relation: "potential-conflict",
    titleOverlap: 0.3,
    bodyOverlap: 0.25,
    lexicalRank: 1,
    ...overrides,
  };
}

// --- formatApprovalCard tests ---

test("formatApprovalCard formats a global lesson proposal", () => {
  const result: ProposeLessonToolResult = {
    status: "proposed",
    candidate: makeCandidate(),
    overlaps: [],
  };

  const card = formatApprovalCard(result);

  expect(card).toContain("Lesson Candidate");
  expect(card).toContain("Title: Test lesson");
  expect(card).toContain("Scope: global");
  expect(card).toContain("Test body content.");
  expect(card).toContain("Rationale: Test rationale.");
  expect(card).toContain("Candidate ID: candidate-1");
  expect(card).toContain(
    "Present this candidate for approval now via the question tool",
  );
  expect(card).not.toContain("Project:");
  expect(card).not.toContain("Warning:");
  expect(card).not.toContain("Overlapping");
});

test("formatApprovalCard shows project ID for project-scoped lessons", () => {
  const result: ProposeLessonToolResult = {
    status: "proposed",
    candidate: makeCandidate({ scope: "project", projectId: "proj-1" }),
    overlaps: [],
  };

  const card = formatApprovalCard(result);

  expect(card).toContain("Scope: project");
  expect(card).toContain("Project: proj-1");
});

test("formatApprovalCard shows secret acknowledgment warning", () => {
  const result: ProposeLessonToolResult = {
    status: "proposed",
    candidate: makeCandidate({ requiresAcknowledgment: true }),
    overlaps: [],
  };

  const card = formatApprovalCard(result);

  expect(card).toContain("Warning:");
  expect(card).toContain("acknowledgment");
});

test("formatApprovalCard shows overlapping lessons with relation and percentage", () => {
  const result: ProposeLessonToolResult = {
    status: "proposed",
    candidate: makeCandidate(),
    overlaps: [
      makeOverlap({ relation: "duplicate", bodyOverlap: 0.85, title: "Duplicate lesson" }),
      makeOverlap({
        lessonId: "overlap-2",
        relation: "potential-conflict",
        bodyOverlap: 0.22,
        title: "Conflicting lesson",
      }),
    ],
  };

  const card = formatApprovalCard(result);

  expect(card).toContain("Overlapping confirmed lessons:");
  expect(card).toContain('[duplicate] "Duplicate lesson"');
  expect(card).toContain("85% body overlap");
  expect(card).toContain('[potential-conflict] "Conflicting lesson"');
  expect(card).toContain("22% body overlap");
});

test("formatApprovalCard handles blocked result", () => {
  const result: ProposeLessonToolResult = {
    status: "blocked",
    reason: "High-confidence secret findings.",
  };

  const card = formatApprovalCard(result);

  expect(card).toContain("blocked");
  expect(card).toContain("High-confidence secret findings.");
});

test("formatApprovalCard handles failed result", () => {
  const result: ProposeLessonToolResult = {
    status: "failed",
    error: "Database unavailable.",
  };

  const card = formatApprovalCard(result);

  expect(card).toContain("failed");
  expect(card).toContain("Database unavailable.");
});

// --- editAndRepropose tests ---

test("editAndRepropose rejects old candidate and creates new one with edited content", async () => {
  await withDatabase(async (connection) => {
    const original = proposeLessonCandidate(connection, {
      projectId: null,
      scope: "global",
      draft: {
        title: "Original title",
        body: "Original body content.",
        rationale: "Original rationale.",
        applicability: {},
        provenance: {},
      },
      secretScan: clearScan,
    });

    const result = await editAndRepropose(connection, null, stubClearScan, {
      candidateId: original.id,
      title: "Edited title",
      body: "Edited body with improved content.",
      rationale: "Improved rationale after user feedback.",
      scope: "global",
    });

    expect(result.status).toBe("proposed");
    if (result.status === "proposed") {
      expect(result.candidate.draft.title).toBe("Edited title");
      expect(result.candidate.draft.body).toBe("Edited body with improved content.");
      expect(result.candidate.id).not.toBe(original.id);
    }

    const remaining = connection.database
      .query<{ id: string }, []>("SELECT id FROM pending_lesson_candidates")
      .all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).not.toBe(original.id);
  });
});

test("editAndRepropose fails when original candidate does not exist", async () => {
  await withDatabase(async (connection) => {
    const result = await editAndRepropose(connection, null, stubClearScan, {
      candidateId: "nonexistent-id",
      title: "New title",
      body: "New body.",
      rationale: "Rationale.",
      scope: "global",
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("not found");
    }
  });
});

test("editAndRepropose can change scope from global to project", async () => {
  await withDatabase(async (connection) => {
    insertProject(connection, "proj-1");

    const original = proposeLessonCandidate(connection, {
      projectId: null,
      scope: "global",
      draft: {
        title: "Was global",
        body: "This lesson started as global.",
        rationale: "Reason.",
        applicability: {},
        provenance: {},
      },
      secretScan: clearScan,
    });

    const result = await editAndRepropose(connection, "proj-1", stubClearScan, {
      candidateId: original.id,
      title: "Now project-scoped",
      body: "This lesson is now project-scoped.",
      rationale: "Scope correction.",
      scope: "project",
    });

    expect(result.status).toBe("proposed");
    if (result.status === "proposed") {
      expect(result.candidate.scope).toBe("project");
      expect(result.candidate.projectId).toBe("proj-1");
    }
  });
});

test("editAndRepropose preserves applicability and provenance when provided", async () => {
  await withDatabase(async (connection) => {
    const original = proposeLessonCandidate(connection, {
      projectId: null,
      scope: "global",
      draft: {
        title: "Original",
        body: "Original body.",
        rationale: "Original rationale.",
        applicability: {},
        provenance: {},
      },
      secretScan: clearScan,
    });

    const result = await editAndRepropose(connection, null, stubClearScan, {
      candidateId: original.id,
      title: "Edited",
      body: "Edited body.",
      rationale: "Edited rationale.",
      scope: "global",
      applicability: { languages: ["python"] },
      provenance: { source: "manual-edit" },
    });

    expect(result.status).toBe("proposed");
    if (result.status === "proposed") {
      expect(result.candidate.draft.applicability).toEqual({ languages: ["python"] });
      expect(result.candidate.draft.provenance).toEqual({ source: "manual-edit" });
    }
  });
});

// --- resolveOverlap tests ---

test("resolveOverlap supersedes overlapping lesson and rejects candidate", () => {
  withDatabase((connection) => {
    insertConfirmedLesson(connection, "lesson-1", {
      title: "Old naming convention",
      body: "Use camelCase for variables.",
    });

    const candidate = proposeLessonCandidate(connection, {
      projectId: null,
      scope: "global",
      draft: {
        title: "Updated naming convention",
        body: "Use snake_case for variables instead.",
        rationale: "Team decided to switch.",
        applicability: {},
        provenance: {},
      },
      secretScan: clearScan,
    });

    const result = resolveOverlap(connection, {
      candidateId: candidate.id,
      overlappingLessonId: "lesson-1",
      draft: {
        title: "Updated naming convention",
        body: "Use snake_case for variables instead.",
        rationale: "Team decided to switch.",
        applicability: {},
        provenance: {},
      },
    });

    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.supersession.lessonId).toBe("lesson-1");
      expect(result.supersession.supersededVersion).toBe(1);
      expect(result.supersession.version).toBe(2);
    }

    const candidates = connection.database
      .query<{ id: string }, []>("SELECT id FROM pending_lesson_candidates")
      .all();
    expect(candidates).toHaveLength(0);

    const activeVersion = connection.database
      .query<{ active_version: number }, [string]>("SELECT active_version FROM lessons WHERE id = ?")
      .get("lesson-1");
    expect(activeVersion!.active_version).toBe(2);
  });
});

test("resolveOverlap with a merged draft combines content from both sources", () => {
  withDatabase((connection) => {
    insertConfirmedLesson(connection, "lesson-1", {
      title: "Error handling basics",
      body: "Always catch errors at API boundaries.",
    });

    const candidate = proposeLessonCandidate(connection, {
      projectId: null,
      scope: "global",
      draft: {
        title: "Error handling with logging",
        body: "Log structured errors with context.",
        rationale: "Complementary practice.",
        applicability: {},
        provenance: {},
      },
      secretScan: clearScan,
    });

    const result = resolveOverlap(connection, {
      candidateId: candidate.id,
      overlappingLessonId: "lesson-1",
      draft: {
        title: "Error handling and logging",
        body: "Always catch errors at API boundaries. Log structured errors with context.",
        rationale: "Merged from original and new lesson.",
        applicability: {},
        provenance: { mergedFrom: [candidate.id] },
      },
    });

    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      const version = connection.database
        .query<{ body: string }, [string, number]>(
          "SELECT body FROM lesson_versions WHERE lesson_id = ? AND version = ?",
        )
        .get("lesson-1", result.supersession.version);
      expect(version!.body).toContain("API boundaries");
      expect(version!.body).toContain("structured errors");
    }
  });
});

test("resolveOverlap fails when overlapping lesson does not exist", () => {
  withDatabase((connection) => {
    const candidate = proposeLessonCandidate(connection, {
      projectId: null,
      scope: "global",
      draft: {
        title: "Test",
        body: "Body.",
        rationale: "Rationale.",
        applicability: {},
        provenance: {},
      },
      secretScan: clearScan,
    });

    const result = resolveOverlap(connection, {
      candidateId: candidate.id,
      overlappingLessonId: "nonexistent",
      draft: {
        title: "Replacement",
        body: "New body.",
        rationale: "Replacing.",
        applicability: {},
        provenance: {},
      },
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("not found");
    }
  });
});

test("resolveOverlap fails when candidate does not exist", () => {
  withDatabase((connection) => {
    insertConfirmedLesson(connection, "lesson-1", {
      title: "Existing",
      body: "Existing body.",
    });

    const result = resolveOverlap(connection, {
      candidateId: "nonexistent-candidate",
      overlappingLessonId: "lesson-1",
      draft: {
        title: "Replacement",
        body: "New body.",
        rationale: "Replacing.",
        applicability: {},
        provenance: {},
      },
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("not found");
    }
  });
});

// --- Full flow tests ---

test("full flow: propose, format card, then approve", async () => {
  await withDatabase(async (connection) => {
    const proposed = await handleProposeLesson(connection, null, stubClearScan, {
      title: "Always use strict mode",
      body: "Enable strict mode in all TypeScript config files.",
      rationale: "Caught a type error that strict mode would have prevented.",
      scope: "global",
    });

    expect(proposed.status).toBe("proposed");
    if (proposed.status !== "proposed") return;

    const card = formatApprovalCard(proposed);
    expect(card).toContain("Always use strict mode");
    expect(card).toContain("Candidate ID:");
    expect(card).toContain(proposed.candidate.id);
  });
});

test("full flow: propose with overlap, then resolve via supersede", async () => {
  await withDatabase(async (connection) => {
    insertProject(connection, "proj-1");
    insertConfirmedLesson(connection, "lesson-1", {
      title: "Use strict TypeScript config",
      body: "Enable strict mode in TypeScript compiler options for type safety.",
    });

    const proposed = await handleProposeLesson(connection, "proj-1", stubClearScan, {
      title: "Use strict TypeScript config",
      body: "Enable strict mode in TypeScript compiler options for type safety and better error detection.",
      rationale: "Expanded the existing lesson.",
      scope: "global",
    });

    expect(proposed.status).toBe("proposed");
    if (proposed.status !== "proposed") return;

    const card = formatApprovalCard(proposed);
    expect(card).toContain("Overlapping confirmed lessons:");

    const overlap = proposed.overlaps[0];
    expect(overlap).toBeDefined();

    const resolved = resolveOverlap(connection, {
      candidateId: proposed.candidate.id,
      overlappingLessonId: overlap!.lessonId,
      draft: proposed.candidate.draft,
    });

    expect(resolved.status).toBe("resolved");
    if (resolved.status === "resolved") {
      expect(resolved.supersession.lessonId).toBe("lesson-1");
    }
  });
});

test("full flow: propose, edit, then approve", async () => {
  await withDatabase(async (connection) => {
    const proposed = await handleProposeLesson(connection, null, stubClearScan, {
      title: "Draft title",
      body: "Draft body that needs improvement.",
      rationale: "Initial attempt.",
      scope: "global",
    });

    expect(proposed.status).toBe("proposed");
    if (proposed.status !== "proposed") return;

    const edited = await editAndRepropose(connection, null, stubClearScan, {
      candidateId: proposed.candidate.id,
      title: "Improved title",
      body: "Refined body with better explanation.",
      rationale: "User refined the lesson content.",
      scope: "global",
    });

    expect(edited.status).toBe("proposed");
    if (edited.status !== "proposed") return;

    expect(edited.candidate.id).not.toBe(proposed.candidate.id);
    expect(edited.candidate.draft.title).toBe("Improved title");

    const card = formatApprovalCard(edited);
    expect(card).toContain("Improved title");
  });
});
