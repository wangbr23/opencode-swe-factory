import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  migrateSqliteSchema,
  openSqliteConnection,
  proposeLessonCandidate,
  releaseSchemaMigrations,
  type SecretScanResult,
  type SqliteConnection,
} from "../../src/core/index.js";
import {
  handleCommitLesson,
  handleProposeLesson,
} from "../../src/opencode/lesson-tools.js";
import type { ScanTextFn } from "../../src/types/lesson-tool-types.js";

function withDatabase(run: (connection: SqliteConnection) => void | Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-lesson-tools-"));
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

const clearScan: SecretScanResult = {
  disposition: "clear",
  findings: [],
  redactedText: "",
};

const blockedScan: SecretScanResult = {
  disposition: "blocked",
  findings: [
    {
      confidence: "high",
      kinds: ["credential"],
      region: { start: 0, end: 20 },
      scannerRuleIds: ["test-rule"],
    },
  ],
  redactedText: "[REDACTED]",
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
const stubBlockedScan: ScanTextFn = async () => blockedScan;
const stubAcknowledgmentScan: ScanTextFn = async () => acknowledgmentScan;

test("handleProposeLesson creates a global pending candidate", async () => {
  await withDatabase(async (connection) => {
    const result = await handleProposeLesson(connection, null, stubClearScan, {
      title: "Run tests before commits",
      body: "Always run bun test before committing changes.",
      rationale: "User corrected a commit without tests.",
      scope: "global",
    });

    expect(result.status).toBe("proposed");
    if (result.status === "proposed") {
      expect(result.candidate.scope).toBe("global");
      expect(result.candidate.projectId).toBeNull();
      expect(result.candidate.draft.title).toBe("Run tests before commits");
      expect(result.candidate.draft.body).toBe("Always run bun test before committing changes.");
      expect(result.candidate.requiresAcknowledgment).toBe(false);
    }
  });
});

test("handleProposeLesson creates a project-scoped pending candidate", async () => {
  await withDatabase(async (connection) => {
    insertProject(connection, "proj-1");

    const result = await handleProposeLesson(connection, "proj-1", stubClearScan, {
      title: "Use snake_case in Python files",
      body: "All Python variables should use snake_case naming.",
      rationale: "Correction from code review.",
      scope: "project",
    });

    expect(result.status).toBe("proposed");
    if (result.status === "proposed") {
      expect(result.candidate.scope).toBe("project");
      expect(result.candidate.projectId).toBe("proj-1");
    }
  });
});

test("handleProposeLesson returns blocked when secret scan finds high-confidence secrets", async () => {
  await withDatabase(async (connection) => {
    const result = await handleProposeLesson(connection, null, stubBlockedScan, {
      title: "API key usage",
      body: "Use the key sk-live-abc123 for production.",
      rationale: "Production setup.",
      scope: "global",
    });

    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.reason).toContain("secret");
    }
  });
});

test("handleProposeLesson allows acknowledgment-required scans and marks the candidate", async () => {
  await withDatabase(async (connection) => {
    const result = await handleProposeLesson(connection, null, stubAcknowledgmentScan, {
      title: "Hash verification",
      body: "Verify checksums before deployment.",
      rationale: "Security practice.",
      scope: "global",
    });

    expect(result.status).toBe("proposed");
    if (result.status === "proposed") {
      expect(result.candidate.requiresAcknowledgment).toBe(true);
    }
  });
});

test("handleProposeLesson fails when project scope is used without a project context", async () => {
  await withDatabase(async (connection) => {
    const result = await handleProposeLesson(connection, null, stubClearScan, {
      title: "Project rule",
      body: "Some project-specific rule.",
      rationale: "Convention.",
      scope: "project",
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("project");
    }
  });
});

test("handleProposeLesson returns overlapping lessons when duplicates exist", async () => {
  await withDatabase(async (connection) => {
    insertProject(connection, "proj-1");

    proposeLessonCandidate(connection, {
      projectId: null,
      scope: "global",
      draft: {
        title: "Run tests before commits",
        body: "Always run bun test before committing changes.",
        rationale: "First correction.",
        applicability: {},
        provenance: {},
      },
      secretScan: clearScan,
    });
    const firstCandidate = connection.database
      .query<{ id: string }, []>("SELECT id FROM pending_lesson_candidates LIMIT 1")
      .get()!;
    connection.database.run(
      `INSERT INTO lessons (id, project_id, scope, active_version, created_at, updated_at)
       VALUES ('lesson-1', NULL, 'global', 1, '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z')`,
    );
    connection.database.run(
      `INSERT INTO lesson_versions (lesson_id, version, title, body, rationale, applicability_json, provenance_json, created_at)
       VALUES ('lesson-1', 1, 'Run tests before commits', 'Always run bun test before committing changes.', 'Original.', '{}', '{}', '2026-09-05T00:00:00.000Z')`,
    );
    connection.database.run("DELETE FROM pending_lesson_candidates WHERE id = ?", [firstCandidate.id]);

    const result = await handleProposeLesson(connection, "proj-1", stubClearScan, {
      title: "Run tests before commits",
      body: "Always run bun test before committing changes.",
      rationale: "User repeated the same correction.",
      scope: "global",
    });

    expect(result.status).toBe("proposed");
    if (result.status === "proposed") {
      expect(result.overlaps.length).toBeGreaterThan(0);
      expect(result.overlaps[0]!.lessonId).toBe("lesson-1");
      expect(result.overlaps[0]!.relation).toBe("duplicate");
    }
  });
});

test("handleProposeLesson returns empty overlaps when no duplicates exist", async () => {
  await withDatabase(async (connection) => {
    const result = await handleProposeLesson(connection, null, stubClearScan, {
      title: "Unique lesson title",
      body: "Completely unique lesson body content.",
      rationale: "New insight.",
      scope: "global",
    });

    expect(result.status).toBe("proposed");
    if (result.status === "proposed") {
      expect(result.overlaps).toHaveLength(0);
    }
  });
});

test("handleProposeLesson preserves applicability and provenance metadata", async () => {
  await withDatabase(async (connection) => {
    const result = await handleProposeLesson(connection, null, stubClearScan, {
      title: "Test lesson",
      body: "Content of the lesson.",
      rationale: "Testing metadata.",
      scope: "global",
      applicability: { taskTypes: ["refactor"], languages: ["typescript"] },
      provenance: { source: "correction", sessionId: "s1" },
    });

    expect(result.status).toBe("proposed");
    if (result.status === "proposed") {
      expect(result.candidate.draft.applicability).toEqual({ taskTypes: ["refactor"], languages: ["typescript"] });
      expect(result.candidate.draft.provenance).toEqual({ source: "correction", sessionId: "s1" });
    }
  });
});

test("handleProposeLesson defaults applicability and provenance to empty objects", async () => {
  await withDatabase(async (connection) => {
    const result = await handleProposeLesson(connection, null, stubClearScan, {
      title: "Minimal lesson",
      body: "Lesson without metadata.",
      rationale: "Testing defaults.",
      scope: "global",
    });

    expect(result.status).toBe("proposed");
    if (result.status === "proposed") {
      expect(result.candidate.draft.applicability).toEqual({});
      expect(result.candidate.draft.provenance).toEqual({});
    }
  });
});

test("handleProposeLesson returns failed when scanner throws", async () => {
  await withDatabase(async (connection) => {
    const failingScan: ScanTextFn = async () => {
      throw new Error("Scanner unavailable");
    };

    const result = await handleProposeLesson(connection, null, failingScan, {
      title: "Test",
      body: "Body",
      rationale: "Rationale",
      scope: "global",
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toBe("Scanner unavailable");
    }
  });
});

test("handleProposeLesson uses global scope for global lessons even with project context", async () => {
  await withDatabase(async (connection) => {
    insertProject(connection, "proj-1");

    const result = await handleProposeLesson(connection, "proj-1", stubClearScan, {
      title: "Global rule from project",
      body: "This is a global lesson proposed from a project context.",
      rationale: "Universal practice.",
      scope: "global",
    });

    expect(result.status).toBe("proposed");
    if (result.status === "proposed") {
      expect(result.candidate.scope).toBe("global");
      expect(result.candidate.projectId).toBeNull();
    }
  });
});

// --- handleCommitLesson tests ---

test("handleCommitLesson approves a pending candidate and creates a confirmed lesson", async () => {
  await withDatabase((connection) => {
    const candidate = proposeLessonCandidate(connection, {
      projectId: null,
      scope: "global",
      draft: {
        title: "Approved lesson",
        body: "This lesson should be confirmed.",
        rationale: "User approved.",
        applicability: {},
        provenance: {},
      },
      secretScan: clearScan,
    });

    const result = handleCommitLesson(connection, {
      candidateId: candidate.id,
      decision: "approve",
    });

    expect(result.status).toBe("committed");
    if (result.status === "committed") {
      expect(result.outcome.status).toBe("approved");
      if (result.outcome.status === "approved") {
        expect(result.outcome.lesson.scope).toBe("global");
        expect(result.outcome.lesson.version).toBe(1);
      }
    }
  });
});

test("handleCommitLesson rejects a pending candidate", async () => {
  await withDatabase((connection) => {
    const candidate = proposeLessonCandidate(connection, {
      projectId: null,
      scope: "global",
      draft: {
        title: "Rejected lesson",
        body: "This lesson should be rejected.",
        rationale: "Not useful.",
        applicability: {},
        provenance: {},
      },
      secretScan: clearScan,
    });

    const result = handleCommitLesson(connection, {
      candidateId: candidate.id,
      decision: "reject",
    });

    expect(result.status).toBe("committed");
    if (result.status === "committed") {
      expect(result.outcome.status).toBe("rejected");
    }
  });
});

test("handleCommitLesson defers a pending candidate", async () => {
  await withDatabase((connection) => {
    const candidate = proposeLessonCandidate(connection, {
      projectId: null,
      scope: "global",
      draft: {
        title: "Deferred lesson",
        body: "This lesson needs more thought.",
        rationale: "Uncertain.",
        applicability: {},
        provenance: {},
      },
      secretScan: clearScan,
    });

    const result = handleCommitLesson(connection, {
      candidateId: candidate.id,
      decision: "defer",
    });

    expect(result.status).toBe("committed");
    if (result.status === "committed") {
      expect(result.outcome.status).toBe("deferred");
      if (result.outcome.status === "deferred") {
        expect(result.outcome.candidateId).toBe(candidate.id);
      }
    }
  });
});

test("handleCommitLesson fails for nonexistent candidate", () => {
  withDatabase((connection) => {
    const result = handleCommitLesson(connection, {
      candidateId: "nonexistent-id",
      decision: "approve",
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("not found");
    }
  });
});

test("handleCommitLesson fails when acknowledgment-required candidate is approved without flag", () => {
  withDatabase((connection) => {
    const candidate = proposeLessonCandidate(connection, {
      projectId: null,
      scope: "global",
      draft: {
        title: "Lesson with low-confidence findings",
        body: "Some content with hash-like patterns.",
        rationale: "Testing acknowledgment.",
        applicability: {},
        provenance: {},
      },
      secretScan: acknowledgmentScan,
    });

    const result = handleCommitLesson(connection, {
      candidateId: candidate.id,
      decision: "approve",
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("acknowledgment");
    }
  });
});

test("handleCommitLesson approves acknowledgment-required candidate with explicit flag", () => {
  withDatabase((connection) => {
    const candidate = proposeLessonCandidate(connection, {
      projectId: null,
      scope: "global",
      draft: {
        title: "Acknowledged lesson",
        body: "Content with acknowledged findings.",
        rationale: "User accepted risk.",
        applicability: {},
        provenance: {},
      },
      secretScan: acknowledgmentScan,
    });

    const result = handleCommitLesson(connection, {
      candidateId: candidate.id,
      decision: "approve",
      acknowledgedSecretRisk: true,
    });

    expect(result.status).toBe("committed");
    if (result.status === "committed") {
      expect(result.outcome.status).toBe("approved");
    }
  });
});

test("full round-trip: propose then commit creates a retrievable confirmed lesson", async () => {
  await withDatabase(async (connection) => {
    const proposed = await handleProposeLesson(connection, null, stubClearScan, {
      title: "Always use strict mode",
      body: "Enable strict mode in all TypeScript config files.",
      rationale: "Caught a type error that strict mode would have prevented.",
      scope: "global",
    });

    expect(proposed.status).toBe("proposed");
    if (proposed.status !== "proposed") return;

    const committed = handleCommitLesson(connection, {
      candidateId: proposed.candidate.id,
      decision: "approve",
    });

    expect(committed.status).toBe("committed");
    if (committed.status !== "committed") return;
    expect(committed.outcome.status).toBe("approved");
    if (committed.outcome.status !== "approved") return;

    const lessonId = committed.outcome.lesson.lessonId;
    const row = connection.database
      .query<{ title: string; body: string }, [string]>(
        `SELECT title, body FROM lesson_versions WHERE lesson_id = ? AND version = 1`,
      )
      .get(lessonId);

    expect(row).not.toBeNull();
    expect(row!.title).toBe("Always use strict mode");
    expect(row!.body).toBe("Enable strict mode in all TypeScript config files.");
  });
});
