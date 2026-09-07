import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  completeTask,
  createTask,
  evaluateAutomaticLessonProposal,
  LESSON_PROPOSAL_TRIGGER_CONSTANTS,
  listPendingLessonCandidates,
  migrateSqliteSchema,
  openSqliteConnection,
  persistTaskProfile,
  proposeLessonCandidate,
  recordCorrectionLessonEvidence,
  recordExplicitFeedback,
  recordToolOutcomeSignal,
  releaseSchemaMigrations,
  resolveProjectIdentity,
  reviewLessonCandidate,
  type SqliteConnection,
} from "../src/core/index.js";
import type { SecretScanResult } from "../src/core/secrets.js";

const BASE = Date.parse("2026-09-06T12:00:00.000Z");

const clearScan = {
  disposition: "clear",
  findings: [],
  redactedText: "",
} as const satisfies SecretScanResult;

function at(minuteOffset: number): Date {
  return new Date(BASE + minuteOffset * 60 * 1000);
}

function withTestDatabase(run: (connection: SqliteConnection, projectId: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(
    join(tmpdir(), "opencode-swe-factory-lesson-proposal-triggers-"),
  );
  const connection = openSqliteConnection(join(directory, "memory.sqlite"));
  migrateSqliteSchema(connection, releaseSchemaMigrations);
  const { project } = resolveProjectIdentity(connection, { projectPath: "/repos/trigger-test" });
  return run(connection, project.id).finally(() => {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  });
}

function createVerifiedTask(
  connection: SqliteConnection,
  projectId: string,
  sessionId: string,
  when: Date,
  options?: Readonly<{ summary?: string; complete?: boolean }>,
): string {
  const task = createTask(connection, {
    projectId,
    sessionId,
    boundary: "top-level",
    now: when,
  });
  persistTaskProfile(connection, {
    taskId: task.taskId,
    profile: {
      taxonomyVersion: 1,
      activity: "implement",
      domain: "backend",
      complexity: "medium",
      risk: "low",
      stack: ["typescript"],
      signals: ["activity-lexical"],
      summary: options?.summary ?? "Add a small module.",
    },
    now: when,
  });
  recordToolOutcomeSignal(connection, {
    taskId: task.taskId,
    record: { tool: "bash", exitCode: 0, commandText: "bun test", observedAt: when },
    now: when,
  });
  if (options?.complete !== false) {
    completeTask(connection, { taskId: task.taskId, now: when });
  }
  return task.taskId;
}

function confirmCorrectionLesson(connection: SqliteConnection): { lessonId: string; version: number } {
  const candidate = proposeLessonCandidate(connection, {
    projectId: null,
    scope: "global",
    draft: {
      title: "Run tests before commits",
      body: "Always run bun test before committing.",
      rationale: "User corrected a commit without tests.",
      applicability: {},
      provenance: { source: "correction" },
    },
    secretScan: clearScan,
  });
  const outcome = reviewLessonCandidate(connection, {
    candidateId: candidate.id,
    decision: "approve",
  });
  if (outcome.status !== "approved") {
    throw new Error("Expected the correction lesson to be approved in the test fixture.");
  }
  return { lessonId: outcome.lesson.lessonId, version: outcome.lesson.version };
}

test("repeated verified success proposes a pending project candidate", async () => {
  await withTestDatabase(async (connection, projectId) => {
    const taskIds = [
      createVerifiedTask(connection, projectId, "s1", at(1)),
      createVerifiedTask(connection, projectId, "s2", at(2)),
      createVerifiedTask(connection, projectId, "s3", at(3)),
    ];

    const result = await evaluateAutomaticLessonProposal(connection, {
      projectId,
      now: at(4),
    });

    expect(result.status).toBe("triggered");
    if (result.status !== "triggered") return;
    expect(result.triggerKind).toBe("repeated-success");
    expect(result.evidence.map((task) => task.taskId)).toEqual(taskIds);
    expect(result.evidence[0]?.verifiedCategories).toEqual(["test"]);

    expect(result.candidate.scope).toBe("project");
    expect(result.candidate.projectId).toBe(projectId);
    expect(result.candidate.requiresAcknowledgment).toBe(false);
    expect(result.candidate.draft.title).toBe("Verified method for implement");
    expect(result.candidate.draft.body).toContain(taskIds[0]!);
    expect(result.candidate.draft.provenance).toMatchObject({
      trigger: LESSON_PROPOSAL_TRIGGER_CONSTANTS.automaticProvenanceTrigger,
      triggerKind: "repeated-success",
      evidenceTaskIds: taskIds,
      verificationCategories: ["test"],
    });

    const pending = listPendingLessonCandidates(connection);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe(result.candidate.id);
  });
});

test("silence and generic command successes never trigger a proposal", async () => {
  await withTestDatabase(async (connection, projectId) => {
    createVerifiedTask(connection, projectId, "s1", at(1), { complete: false });
    const silent = createTask(connection, {
      projectId,
      sessionId: "s-silent",
      boundary: "top-level",
      now: at(1),
    });
    completeTask(connection, { taskId: silent.taskId, now: at(1) });
    for (const session of ["s2", "s3", "s4"]) {
      const taskId = createVerifiedTask(connection, projectId, session, at(2));
      connection.database.run("DELETE FROM outcome_signals WHERE task_id = ?", [taskId]);
      recordToolOutcomeSignal(connection, {
        taskId,
        record: { tool: "bash", exitCode: 0, commandText: "bun run dev", observedAt: at(2) },
        now: at(2),
      });
      completeTask(connection, { taskId, now: at(2) });
    }

    const result = await evaluateAutomaticLessonProposal(connection, {
      projectId,
      now: at(5),
    });

    expect(result).toMatchObject({
      status: "no-trigger",
      reason: "below-repeated-success-threshold",
      qualifyingTaskCount: 3,
      strongSignalTaskCount: 0,
    });
  });
});

test("any effective negative signal disqualifies its task", async () => {
  await withTestDatabase(async (connection, projectId) => {
    const failed = createVerifiedTask(connection, projectId, "s1", at(1));
    recordToolOutcomeSignal(connection, {
      taskId: failed,
      record: { tool: "bash", exitCode: 1, commandText: "bun test", observedAt: at(1) },
      now: at(1),
    });
    createVerifiedTask(connection, projectId, "s2", at(2));
    createVerifiedTask(connection, projectId, "s3", at(3));

    const result = await evaluateAutomaticLessonProposal(connection, {
      projectId,
      now: at(4),
    });

    expect(result).toMatchObject({
      status: "no-trigger",
      reason: "below-repeated-success-threshold",
      qualifyingTaskCount: 2,
    });
  });
});

test("a linked correction lesson disqualifies its task", async () => {
  await withTestDatabase(async (connection, projectId) => {
    const corrected = createVerifiedTask(connection, projectId, "s1", at(1));
    const { lessonId, version } = confirmCorrectionLesson(connection);
    recordCorrectionLessonEvidence(connection, { taskId: corrected, lessonId, lessonVersion: version });
    createVerifiedTask(connection, projectId, "s2", at(2));
    createVerifiedTask(connection, projectId, "s3", at(3));

    const result = await evaluateAutomaticLessonProposal(connection, {
      projectId,
      now: at(4),
    });

    expect(result).toMatchObject({
      status: "no-trigger",
      reason: "below-repeated-success-threshold",
      qualifyingTaskCount: 2,
    });
  });
});

test("explicit acceptance is a strong signal even for a single task", async () => {
  await withTestDatabase(async (connection, projectId) => {
    const taskId = createVerifiedTask(connection, projectId, "s1", at(1));
    recordExplicitFeedback(connection, { taskId, feedbackKind: "acceptance", now: at(2) });

    const result = await evaluateAutomaticLessonProposal(connection, {
      projectId,
      now: at(3),
    });

    expect(result.status).toBe("triggered");
    if (result.status !== "triggered") return;
    expect(result.triggerKind).toBe("strong-signal");
    expect(result.evidence.map((task) => task.taskId)).toEqual([taskId]);
    expect(result.candidate.draft.rationale).toContain("acceptance");
  });
});

test("a retracted acceptance no longer counts as a strong signal", async () => {
  await withTestDatabase(async (connection, projectId) => {
    const taskId = createVerifiedTask(connection, projectId, "s1", at(1));
    recordExplicitFeedback(connection, { taskId, feedbackKind: "acceptance", now: at(2) });
    recordExplicitFeedback(connection, { taskId, feedbackKind: "correction", now: at(3) });

    const result = await evaluateAutomaticLessonProposal(connection, {
      projectId,
      now: at(4),
    });

    expect(result).toMatchObject({
      status: "no-trigger",
      reason: "no-qualifying-tasks",
      qualifyingTaskCount: 0,
      strongSignalTaskCount: 0,
    });
  });
});

test("strong-signal takes precedence over repeated success", async () => {
  await withTestDatabase(async (connection, projectId) => {
    const accepted = createVerifiedTask(connection, projectId, "s1", at(1));
    recordExplicitFeedback(connection, { taskId: accepted, feedbackKind: "acceptance", now: at(2) });
    createVerifiedTask(connection, projectId, "s2", at(3));
    createVerifiedTask(connection, projectId, "s3", at(4));
    createVerifiedTask(connection, projectId, "s4", at(5));

    const result = await evaluateAutomaticLessonProposal(connection, {
      projectId,
      now: at(6),
    });

    expect(result.status).toBe("triggered");
    if (result.status !== "triggered") return;
    expect(result.triggerKind).toBe("strong-signal");
    expect(result.evidence.map((task) => task.taskId)).toEqual([accepted]);
  });
});

test("a pending automatic candidate blocks a second proposal until rejected", async () => {
  await withTestDatabase(async (connection, projectId) => {
    for (const session of ["s1", "s2", "s3"]) {
      createVerifiedTask(connection, projectId, session, at(1));
    }
    const first = await evaluateAutomaticLessonProposal(connection, { projectId, now: at(4) });
    expect(first.status).toBe("triggered");
    if (first.status !== "triggered") return;

    createVerifiedTask(connection, projectId, "s4", at(5));
    const second = await evaluateAutomaticLessonProposal(connection, { projectId, now: at(6) });
    expect(second).toMatchObject({ status: "no-trigger", reason: "pending-automatic-candidate" });

    reviewLessonCandidate(connection, { candidateId: first.candidate.id, decision: "reject" });
    const third = await evaluateAutomaticLessonProposal(connection, { projectId, now: at(7) });
    expect(third.status).toBe("triggered");
  });
});

test("approval consumes cited tasks; fresh successes trigger a new proposal", async () => {
  await withTestDatabase(async (connection, projectId) => {
    const firstBatch = [
      createVerifiedTask(connection, projectId, "s1", at(1)),
      createVerifiedTask(connection, projectId, "s2", at(2)),
      createVerifiedTask(connection, projectId, "s3", at(3)),
    ];
    const first = await evaluateAutomaticLessonProposal(connection, { projectId, now: at(4) });
    expect(first.status).toBe("triggered");
    if (first.status !== "triggered") return;
    reviewLessonCandidate(connection, { candidateId: first.candidate.id, decision: "approve" });

    const drained = await evaluateAutomaticLessonProposal(connection, { projectId, now: at(5) });
    expect(drained).toMatchObject({
      status: "no-trigger",
      reason: "no-qualifying-tasks",
      qualifyingTaskCount: 0,
    });

    const secondBatch = [
      createVerifiedTask(connection, projectId, "s4", at(6)),
      createVerifiedTask(connection, projectId, "s5", at(7)),
      createVerifiedTask(connection, projectId, "s6", at(8)),
    ];
    const second = await evaluateAutomaticLessonProposal(connection, { projectId, now: at(9) });
    expect(second.status).toBe("triggered");
    if (second.status !== "triggered") return;
    expect(second.evidence.map((task) => task.taskId)).toEqual(secondBatch);
    expect(second.evidence.some((task) => firstBatch.includes(task.taskId))).toBe(false);
  });
});

test("manual draft provenance without the automatic marker never dedups", async () => {
  await withTestDatabase(async (connection, projectId) => {
    const cited = createVerifiedTask(connection, projectId, "s1", at(1));
    createVerifiedTask(connection, projectId, "s2", at(2));
    createVerifiedTask(connection, projectId, "s3", at(3));
    proposeLessonCandidate(connection, {
      projectId,
      scope: "project",
      draft: {
        title: "Manual lesson",
        body: "Written by the agent.",
        rationale: "Explicit correction.",
        applicability: {},
        provenance: { evidenceTaskIds: [cited] },
      },
      secretScan: clearScan,
    });

    const result = await evaluateAutomaticLessonProposal(connection, { projectId, now: at(4) });

    expect(result.status).toBe("triggered");
  });
});

test("incomplete tasks are excluded from evidence", async () => {
  await withTestDatabase(async (connection, projectId) => {
    createVerifiedTask(connection, projectId, "s1", at(1), { complete: false });
    createVerifiedTask(connection, projectId, "s2", at(2));
    createVerifiedTask(connection, projectId, "s3", at(3));

    const result = await evaluateAutomaticLessonProposal(connection, {
      projectId,
      now: at(4),
    });

    expect(result).toMatchObject({
      status: "no-trigger",
      reason: "below-repeated-success-threshold",
      qualifyingTaskCount: 2,
    });
  });
});

test("the since cursor excludes earlier completions", async () => {
  await withTestDatabase(async (connection, projectId) => {
    createVerifiedTask(connection, projectId, "s1", at(1));
    createVerifiedTask(connection, projectId, "s2", at(2));
    createVerifiedTask(connection, projectId, "s3", at(3));

    const before = await evaluateAutomaticLessonProposal(connection, {
      projectId,
      since: at(2).toISOString(),
      now: at(4),
    });
    expect(before).toMatchObject({
      status: "no-trigger",
      reason: "below-repeated-success-threshold",
      qualifyingTaskCount: 2,
    });

    const all = await evaluateAutomaticLessonProposal(connection, { projectId, now: at(4) });
    expect(all.status).toBe("triggered");
  });
});

test("low-confidence secret matches carry acknowledgment into the automatic proposal", async () => {
  await withTestDatabase(async (connection, projectId) => {
    createVerifiedTask(connection, projectId, "s1", at(1), {
      summary: "Use token = ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
    });
    createVerifiedTask(connection, projectId, "s2", at(2));
    createVerifiedTask(connection, projectId, "s3", at(3));

    const result = await evaluateAutomaticLessonProposal(connection, { projectId, now: at(4) });

    expect(result).toMatchObject({ status: "triggered", triggerKind: "repeated-success" });
    if (result.status !== "triggered") return;
    expect(result.candidate.requiresAcknowledgment).toBe(true);
  });
});

test("high-confidence secrets in task summaries block the automatic proposal", async () => {
  await withTestDatabase(async (connection, projectId) => {
    createVerifiedTask(connection, projectId, "s1", at(1), {
      summary: "Rotate the key tonight at 02:00 UTC using value ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
    });
    createVerifiedTask(connection, projectId, "s2", at(2));
    createVerifiedTask(connection, projectId, "s3", at(3));

    const result = await evaluateAutomaticLessonProposal(connection, { projectId, now: at(4) });

    expect(result).toMatchObject({ status: "blocked", triggerKind: "repeated-success" });
    expect(listPendingLessonCandidates(connection)).toHaveLength(0);
  });
});

test("input validation rejects empty projects and weak repetition thresholds", async () => {
  await withTestDatabase(async (connection, projectId) => {
    await expect(evaluateAutomaticLessonProposal(connection, { projectId: "" })).rejects.toThrow(
      "projectId must be a non-empty string.",
    );
    await expect(
      evaluateAutomaticLessonProposal(connection, { projectId, minVerifiedSuccesses: 1 }),
    ).rejects.toThrow("minVerifiedSuccesses must be an integer of at least 2");
  });
});
