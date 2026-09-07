import { expect, test } from "bun:test";

import {
  applyInjection,
  clearPendingInjection,
  createInjectionState,
  prepareInjection,
} from "../../src/opencode/context-injection.js";
import type { ResolvedFeatureToggles } from "../../src/types/feature-toggle-types.js";
import type { LexicalLessonResult } from "../../src/types/lesson-retrieval-types.js";
import type { RetrieveLessonsFn } from "../../src/types/context-injection-types.js";

function enabledToggles(): ResolvedFeatureToggles {
  return {
    privateMode: false,
    retrieval: true,
    recording: true,
    modelTelemetry: true,
    routing: false,
  };
}

function privateToggles(): ResolvedFeatureToggles {
  return {
    privateMode: true,
    retrieval: false,
    recording: false,
    modelTelemetry: false,
    routing: false,
  };
}

function disabledRetrievalToggles(): ResolvedFeatureToggles {
  return {
    privateMode: false,
    retrieval: false,
    recording: true,
    modelTelemetry: true,
    routing: false,
  };
}

function makeLesson(id: string, overrides?: Partial<LexicalLessonResult>): LexicalLessonResult {
  return {
    lessonId: id,
    version: 1,
    projectId: null,
    scope: "global",
    title: `Lesson ${id}`,
    body: `Body of lesson ${id}`,
    rationale: "test rationale",
    applicability: {},
    provenance: {},
    createdAt: "2026-09-05T00:00:00.000Z",
    lexicalRank: 1,
    ...overrides,
  };
}

function stubRetrieve(lessons: LexicalLessonResult[]): RetrieveLessonsFn {
  return async () => ({
    lessons: lessons.map((lesson) => ({
      ...lesson,
      semanticRank: null,
      similarity: null,
      score: 0,
      contributions: {
        reciprocalRankFusion: 0,
        exactTaskDimensions: 0,
      },
    })),
    semantic: {
      status: "unavailable",
      candidateCount: 0,
      error: "not installed",
    },
  });
}

const emptyRetrieve: RetrieveLessonsFn = async () => ({
  lessons: [],
  semantic: {
    status: "unavailable",
    candidateCount: 0,
    error: "not installed",
  },
});

test("createInjectionState returns empty state", () => {
  const state = createInjectionState();
  expect(state.pending.size).toBe(0);
});

test("prepareInjection skips when private mode is active", async () => {
  const state = createInjectionState();
  const result = await prepareInjection(state, privateToggles(), {
    sessionId: "s1",
    query: "test query",
    projectId: "p1",
    now: "2026-09-06T00:00:00.000Z",
  }, emptyRetrieve);

  expect(result.status).toBe("skipped");
  if (result.status === "skipped") {
    expect(result.reason).toBe("private-mode");
  }
  expect(state.pending.size).toBe(0);
});

test("prepareInjection skips when retrieval is disabled", async () => {
  const state = createInjectionState();
  const result = await prepareInjection(state, disabledRetrievalToggles(), {
    sessionId: "s1",
    query: "test query",
    projectId: "p1",
    now: "2026-09-06T00:00:00.000Z",
  }, emptyRetrieve);

  expect(result.status).toBe("skipped");
  if (result.status === "skipped") {
    expect(result.reason).toBe("retrieval-disabled");
  }
});

test("prepareInjection skips on empty query", async () => {
  const state = createInjectionState();
  const result = await prepareInjection(state, enabledToggles(), {
    sessionId: "s1",
    query: "",
    projectId: "p1",
    now: "2026-09-06T00:00:00.000Z",
  }, emptyRetrieve);

  expect(result.status).toBe("skipped");
  if (result.status === "skipped") {
    expect(result.reason).toBe("empty-query");
  }
});

test("prepareInjection skips on whitespace-only query", async () => {
  const state = createInjectionState();
  const result = await prepareInjection(state, enabledToggles(), {
    sessionId: "s1",
    query: "   \n\t  ",
    projectId: "p1",
    now: "2026-09-06T00:00:00.000Z",
  }, emptyRetrieve);

  expect(result.status).toBe("skipped");
  if (result.status === "skipped") {
    expect(result.reason).toBe("empty-query");
  }
});

test("prepareInjection returns empty when no lessons match", async () => {
  const state = createInjectionState();
  const result = await prepareInjection(state, enabledToggles(), {
    sessionId: "s1",
    query: "some query",
    projectId: "p1",
    now: "2026-09-06T00:00:00.000Z",
  }, emptyRetrieve);

  expect(result.status).toBe("empty");
  if (result.status === "empty") {
    expect(result.receipt.packedCount).toBe(0);
    expect(result.receipt.retrievedCount).toBe(0);
  }
  expect(state.pending.size).toBe(0);
});

test("prepareInjection stores pending when lessons are found", async () => {
  const state = createInjectionState();
  const lessons = [makeLesson("L1")];
  const result = await prepareInjection(state, enabledToggles(), {
    sessionId: "s1",
    messageId: "m1",
    query: "test query",
    projectId: "p1",
    now: "2026-09-06T00:00:00.000Z",
  }, stubRetrieve(lessons));

  expect(result.status).toBe("prepared");
  if (result.status === "prepared") {
    expect(result.pending.sessionId).toBe("s1");
    expect(result.pending.messageId).toBe("m1");
    expect(result.pending.block).toContain("Lesson L1");
    expect(result.pending.receipt.packedCount).toBe(1);
    expect(result.pending.receipt.semantic).toEqual({ status: "unavailable", candidateCount: 0 });
    expect(result.pending.preparedAt).toBe("2026-09-06T00:00:00.000Z");
  }
  expect(state.pending.size).toBe(1);
  expect(state.pending.has("s1")).toBe(true);
});

test("prepareInjection exposes successful semantic availability in its receipt", async () => {
  const state = createInjectionState();
  const result = await prepareInjection(state, enabledToggles(), {
    sessionId: "s1",
    query: "test query",
    projectId: "p1",
  }, async () => ({
    lessons: [{
      ...makeLesson("L1"),
      semanticRank: 1,
      similarity: 1,
      score: 1,
      contributions: { reciprocalRankFusion: 1, exactTaskDimensions: 0 },
    }],
    semantic: { status: "available", candidateCount: 1 },
  }));

  expect(result.status).toBe("prepared");
  if (result.status === "prepared") {
    expect(result.pending.receipt.semantic).toEqual({ status: "available", candidateCount: 1 });
  }
});

test("prepareInjection suppresses on ambiguous correlation and clears stale pending", async () => {
  const state = createInjectionState();
  const lessons = [makeLesson("L1")];

  const first = await prepareInjection(state, enabledToggles(), {
    sessionId: "s1",
    messageId: "m1",
    query: "first query",
    projectId: "p1",
    now: "2026-09-06T00:00:00.000Z",
  }, stubRetrieve(lessons));
  expect(first.status).toBe("prepared");
  expect(state.pending.size).toBe(1);

  const second = await prepareInjection(state, enabledToggles(), {
    sessionId: "s1",
    messageId: "m2",
    query: "second query",
    projectId: "p1",
    now: "2026-09-06T00:01:00.000Z",
  }, stubRetrieve(lessons));

  expect(second.status).toBe("skipped");
  if (second.status === "skipped") {
    expect(second.reason).toBe("ambiguous-correlation");
  }
  expect(state.pending.size).toBe(0);
});

test("prepareInjection returns failed when retrieval throws", async () => {
  const state = createInjectionState();
  const failingRetrieve: RetrieveLessonsFn = async () => {
    throw new Error("FTS5 not available");
  };

  const result = await prepareInjection(state, enabledToggles(), {
    sessionId: "s1",
    query: "test query",
    projectId: "p1",
    now: "2026-09-06T00:00:00.000Z",
  }, failingRetrieve);

  expect(result.status).toBe("failed");
  if (result.status === "failed") {
    expect(result.error).toBe("FTS5 not available");
  }
  expect(state.pending.size).toBe(0);
});

test("prepareInjection captures non-Error throws as strings", async () => {
  const state = createInjectionState();
  const failingRetrieve: RetrieveLessonsFn = async () => {
    throw "raw string error";
  };

  const result = await prepareInjection(state, enabledToggles(), {
    sessionId: "s1",
    query: "test query",
    projectId: "p1",
  }, failingRetrieve);

  expect(result.status).toBe("failed");
  if (result.status === "failed") {
    expect(result.error).toBe("raw string error");
  }
});

test("applyInjection skips when sessionId is undefined", () => {
  const state = createInjectionState();
  const system = ["existing block"];
  const result = applyInjection(state, undefined, system);

  expect(result.status).toBe("skipped");
  if (result.status === "skipped") {
    expect(result.reason).toBe("no-session-id");
  }
  expect(system).toEqual(["existing block"]);
});

test("applyInjection skips when no pending injection exists", () => {
  const state = createInjectionState();
  const system = ["existing block"];
  const result = applyInjection(state, "s1", system);

  expect(result.status).toBe("skipped");
  if (result.status === "skipped") {
    expect(result.reason).toBe("no-pending-injection");
  }
  expect(system).toEqual(["existing block"]);
});

test("applyInjection merges into existing primary system block", async () => {
  const state = createInjectionState();
  const lessons = [makeLesson("L1")];
  await prepareInjection(state, enabledToggles(), {
    sessionId: "s1",
    query: "test",
    projectId: "p1",
    now: "2026-09-06T00:00:00.000Z",
  }, stubRetrieve(lessons));

  const system = ["existing system instructions"];
  const result = applyInjection(state, "s1", system);

  expect(result.status).toBe("applied");
  expect(system).toHaveLength(1);
  expect(system[0]).toStartWith("existing system instructions\n\n");
  expect(system[0]).toContain("Confirmed Lessons");
  expect(system[0]).toContain("Lesson L1");
});

test("applyInjection pushes block when system array is empty", async () => {
  const state = createInjectionState();
  const lessons = [makeLesson("L1")];
  await prepareInjection(state, enabledToggles(), {
    sessionId: "s1",
    query: "test",
    projectId: "p1",
    now: "2026-09-06T00:00:00.000Z",
  }, stubRetrieve(lessons));

  const system: string[] = [];
  const result = applyInjection(state, "s1", system);

  expect(result.status).toBe("applied");
  expect(system).toHaveLength(1);
  expect(system[0]).toContain("Confirmed Lessons");
});

test("applyInjection clears pending state after application", async () => {
  const state = createInjectionState();
  const lessons = [makeLesson("L1")];
  await prepareInjection(state, enabledToggles(), {
    sessionId: "s1",
    query: "test",
    projectId: "p1",
    now: "2026-09-06T00:00:00.000Z",
  }, stubRetrieve(lessons));

  expect(state.pending.size).toBe(1);
  applyInjection(state, "s1", ["block"]);
  expect(state.pending.size).toBe(0);

  const secondApply = applyInjection(state, "s1", ["block"]);
  expect(secondApply.status).toBe("skipped");
});

test("applyInjection returns receipt with correct counts", async () => {
  const state = createInjectionState();
  const lessons = [
    makeLesson("L1", {
      scope: "project",
      projectId: "p1",
      title: "Snake case variables",
      body: "Use snake_case for all Python variable names in this project.",
    }),
    makeLesson("L2", {
      title: "Error handling pattern",
      body: "Wrap external API calls in try-catch with structured logging.",
    }),
  ];
  await prepareInjection(state, enabledToggles(), {
    sessionId: "s1",
    query: "test",
    projectId: "p1",
    now: "2026-09-06T00:00:00.000Z",
  }, stubRetrieve(lessons));

  const result = applyInjection(state, "s1", ["block"]);

  expect(result.status).toBe("applied");
  if (result.status === "applied") {
    expect(result.receipt.packedCount).toBe(2);
    expect(result.receipt.retrievedCount).toBe(2);
    expect(result.receipt.suppressedCount).toBe(0);
  }
});

test("concurrent sessions do not cross-contaminate", async () => {
  const state = createInjectionState();
  const lessonsA = [makeLesson("LA", { title: "Lesson A" })];
  const lessonsB = [makeLesson("LB", { title: "Lesson B" })];

  await prepareInjection(state, enabledToggles(), {
    sessionId: "session-a",
    query: "query a",
    projectId: "p1",
    now: "2026-09-06T00:00:00.000Z",
  }, stubRetrieve(lessonsA));

  await prepareInjection(state, enabledToggles(), {
    sessionId: "session-b",
    query: "query b",
    projectId: "p2",
    now: "2026-09-06T00:00:00.000Z",
  }, stubRetrieve(lessonsB));

  expect(state.pending.size).toBe(2);

  const systemA = ["instructions for A"];
  const resultA = applyInjection(state, "session-a", systemA);
  expect(resultA.status).toBe("applied");
  expect(systemA[0]).toContain("Lesson A");
  expect(systemA[0]).not.toContain("Lesson B");

  const systemB = ["instructions for B"];
  const resultB = applyInjection(state, "session-b", systemB);
  expect(resultB.status).toBe("applied");
  expect(systemB[0]).toContain("Lesson B");
  expect(systemB[0]).not.toContain("Lesson A");

  expect(state.pending.size).toBe(0);
});

test("clearPendingInjection removes a pending entry", async () => {
  const state = createInjectionState();
  const lessons = [makeLesson("L1")];
  await prepareInjection(state, enabledToggles(), {
    sessionId: "s1",
    query: "test",
    projectId: "p1",
    now: "2026-09-06T00:00:00.000Z",
  }, stubRetrieve(lessons));

  expect(state.pending.size).toBe(1);
  const cleared = clearPendingInjection(state, "s1");
  expect(cleared).toBe(true);
  expect(state.pending.size).toBe(0);
});

test("clearPendingInjection returns false for nonexistent session", () => {
  const state = createInjectionState();
  const cleared = clearPendingInjection(state, "nonexistent");
  expect(cleared).toBe(false);
});

test("prepareInjection without messageId stores undefined messageId", async () => {
  const state = createInjectionState();
  const lessons = [makeLesson("L1")];
  const result = await prepareInjection(state, enabledToggles(), {
    sessionId: "s1",
    query: "test",
    projectId: "p1",
    now: "2026-09-06T00:00:00.000Z",
  }, stubRetrieve(lessons));

  expect(result.status).toBe("prepared");
  if (result.status === "prepared") {
    expect(result.pending.messageId).toBeUndefined();
  }
});

test("prepareInjection preserves system block with multiple existing entries", async () => {
  const state = createInjectionState();
  const lessons = [makeLesson("L1")];
  await prepareInjection(state, enabledToggles(), {
    sessionId: "s1",
    query: "test",
    projectId: "p1",
    now: "2026-09-06T00:00:00.000Z",
  }, stubRetrieve(lessons));

  const system = ["primary block", "secondary block"];
  applyInjection(state, "s1", system);

  expect(system).toHaveLength(2);
  expect(system[0]).toContain("Confirmed Lessons");
  expect(system[1]).toBe("secondary block");
});

test("full round-trip: prepare then apply produces correct injection", async () => {
  const state = createInjectionState();
  const lessons = [
    makeLesson("L1", {
      scope: "project",
      projectId: "p1",
      title: "Use snake_case for variables",
      body: "Always use snake_case naming for Python variables.",
    }),
  ];

  const prepareResult = await prepareInjection(state, enabledToggles(), {
    sessionId: "s1",
    messageId: "m1",
    query: "variable naming conventions",
    projectId: "p1",
    now: "2026-09-06T00:00:00.000Z",
  }, stubRetrieve(lessons));

  expect(prepareResult.status).toBe("prepared");

  const system = ["You are a helpful coding assistant."];
  const applyResult = applyInjection(state, "s1", system);

  expect(applyResult.status).toBe("applied");
  if (applyResult.status === "applied") {
    expect(applyResult.receipt.query).toBe("variable naming conventions");
    expect(applyResult.receipt.packedCount).toBe(1);
  }

  expect(system[0]).toContain("You are a helpful coding assistant.");
  expect(system[0]).toContain("Use snake_case for variables");
  expect(system[0]).toContain("snake_case naming");
  expect(system[0]).toContain("[project]");
});
