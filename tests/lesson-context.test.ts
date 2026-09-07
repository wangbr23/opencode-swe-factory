import { expect, test } from "bun:test";

import {
  DEFAULT_LESSON_TOKEN_BUDGET,
  estimateTokenCount,
  packLessonContext,
} from "../src/core/lesson-context.js";
import type { LexicalLessonResult } from "../src/core/index.js";
import type { SuppressedLesson } from "../src/types/lesson-conflict-suppression-types.js";

function makeLessonResult(overrides: Partial<LexicalLessonResult> & { lessonId: string }): LexicalLessonResult {
  return {
    version: 1,
    projectId: null,
    scope: "global",
    title: `Lesson ${overrides.lessonId}`,
    body: `Body of lesson ${overrides.lessonId}`,
    rationale: "test rationale",
    applicability: {},
    provenance: {},
    createdAt: "2026-09-05T00:00:00.000Z",
    lexicalRank: 1,
    ...overrides,
  };
}

test("empty kept list produces empty block", () => {
  const result = packLessonContext({
    kept: [],
    suppressed: [],
    query: "test query",
  });

  expect(result.block).toBe("");
  expect(result.packed).toHaveLength(0);
  expect(result.excluded).toHaveLength(0);
  expect(result.receipt.packedCount).toBe(0);
  expect(result.receipt.estimatedTokensUsed).toBe(0);
});

test("single lesson within budget is packed", () => {
  const lesson = makeLessonResult({ lessonId: "L1" });
  const result = packLessonContext({
    kept: [lesson],
    suppressed: [],
    query: "test",
  });

  expect(result.packed).toHaveLength(1);
  expect(result.packed[0]!.lessonId).toBe("L1");
  expect(result.packed[0]!.title).toBe("Lesson L1");
  expect(result.packed[0]!.body).toBe("Body of lesson L1");
  expect(result.block).toContain("## Confirmed Lessons");
  expect(result.block).toContain("### Lesson L1 [global]");
  expect(result.block).toContain("[lesson L1 v1]");
  expect(result.block).toContain("Body of lesson L1");
  expect(result.receipt.packedCount).toBe(1);
  expect(result.receipt.excludedByBudgetCount).toBe(0);
});

test("multiple lessons within budget are all packed in order", () => {
  const lessons = [
    makeLessonResult({ lessonId: "L1", scope: "project", projectId: "P1", lexicalRank: 1 }),
    makeLessonResult({ lessonId: "L2", scope: "global", lexicalRank: 2 }),
  ];
  const result = packLessonContext({
    kept: lessons,
    suppressed: [],
    query: "test",
  });

  expect(result.packed).toHaveLength(2);
  expect(result.packed[0]!.lessonId).toBe("L1");
  expect(result.packed[1]!.lessonId).toBe("L2");
  expect(result.block).toContain("[project]");
  expect(result.block).toContain("[global]");
  const projectIndex = result.block.indexOf("[project]");
  const globalIndex = result.block.indexOf("[global]");
  expect(projectIndex).toBeLessThan(globalIndex);
});

test("budget exceeded excludes later lessons", () => {
  const lessons = [
    makeLessonResult({ lessonId: "L1", body: "short" }),
    makeLessonResult({ lessonId: "L2", body: "also short" }),
    makeLessonResult({ lessonId: "L3", body: "this one too" }),
  ];
  const result = packLessonContext({
    kept: lessons,
    suppressed: [],
    query: "test",
    tokenBudget: 30,
  });

  expect(result.packed.length).toBeGreaterThanOrEqual(1);
  expect(result.packed.length).toBeLessThan(3);
  const packedIds = result.packed.map((p) => p.lessonId);
  const excludedIds = result.excluded.filter((e) => e.reason === "budget-exceeded").map((e) => e.lessonId);
  expect(packedIds[0]).toBe("L1");
  expect(excludedIds.length).toBeGreaterThan(0);
  expect(result.receipt.excludedByBudgetCount).toBe(excludedIds.length);
});

test("large single lesson exceeding budget produces empty block", () => {
  const lesson = makeLessonResult({
    lessonId: "L1",
    body: "x".repeat(500),
  });
  const result = packLessonContext({
    kept: [lesson],
    suppressed: [],
    query: "test",
    tokenBudget: 10,
  });

  expect(result.block).toBe("");
  expect(result.packed).toHaveLength(0);
  expect(result.excluded).toHaveLength(1);
  expect(result.excluded[0]!.reason).toBe("budget-exceeded");
  expect(result.receipt.estimatedTokensUsed).toBe(0);
});

test("suppressed lessons appear as conflict-suppressed exclusions", () => {
  const kept = [makeLessonResult({ lessonId: "L1" })];
  const suppressed: SuppressedLesson[] = [
    { lessonId: "L2", conflictsWith: "L1", bodyOverlap: 0.35 },
  ];
  const result = packLessonContext({
    kept,
    suppressed,
    query: "test",
  });

  expect(result.packed).toHaveLength(1);
  expect(result.excluded).toHaveLength(1);
  const ex = result.excluded[0]!;
  expect(ex.reason).toBe("conflict-suppressed");
  if (ex.reason === "conflict-suppressed") {
    expect(ex.conflictsWith).toBe("L1");
    expect(ex.bodyOverlap).toBe(0.35);
  }
  expect(result.receipt.suppressedCount).toBe(1);
  expect(result.receipt.retrievedCount).toBe(2);
});

test("receipt tracks all counts correctly", () => {
  const kept = [
    makeLessonResult({ lessonId: "L1", body: "fits" }),
    makeLessonResult({ lessonId: "L2", body: "x".repeat(500) }),
  ];
  const suppressed: SuppressedLesson[] = [
    { lessonId: "L3", conflictsWith: "L1", bodyOverlap: 0.2 },
  ];
  const result = packLessonContext({
    kept,
    suppressed,
    query: "my query",
    tokenBudget: 50,
  });

  expect(result.receipt.query).toBe("my query");
  expect(result.receipt.retrievedCount).toBe(3);
  expect(result.receipt.suppressedCount).toBe(1);
  expect(result.receipt.packedCount).toBe(1);
  expect(result.receipt.excludedByBudgetCount).toBe(1);
  expect(result.receipt.tokenBudget).toBe(50);
  expect(result.receipt.estimatedTokensUsed).toBeGreaterThan(0);
});

test("custom token estimator is used", () => {
  const lesson = makeLessonResult({ lessonId: "L1", body: "hello" });
  const calls: string[] = [];
  const customEstimator = (text: string) => {
    calls.push(text);
    return 1;
  };
  const result = packLessonContext({
    kept: [lesson],
    suppressed: [],
    query: "test",
    tokenBudget: 100,
    estimateTokens: customEstimator,
  });

  expect(calls.length).toBeGreaterThan(0);
  expect(result.packed).toHaveLength(1);
  expect(result.packed[0]!.estimatedTokens).toBe(1);
});

test("default budget constant is applied when not specified", () => {
  const result = packLessonContext({
    kept: [],
    suppressed: [],
    query: "test",
  });

  expect(result.receipt.tokenBudget).toBe(DEFAULT_LESSON_TOKEN_BUDGET);
  expect(DEFAULT_LESSON_TOKEN_BUDGET).toBe(2000);
});

test("estimateTokenCount heuristic produces reasonable values", () => {
  expect(estimateTokenCount("")).toBe(0);
  expect(estimateTokenCount("word")).toBe(1);
  expect(estimateTokenCount("hello world")).toBe(3);
  expect(estimateTokenCount("a".repeat(100))).toBe(25);
});

test("block format includes header, scope tags, and stable lesson citations", () => {
  const lessons = [
    makeLessonResult({ lessonId: "L1", scope: "project", projectId: "P1", title: "Project Rule" }),
    makeLessonResult({ lessonId: "L2", scope: "global", title: "Global Rule" }),
  ];
  const result = packLessonContext({
    kept: lessons,
    suppressed: [],
    query: "test",
  });

  expect(result.block.startsWith("## Confirmed Lessons")).toBe(true);
  expect(result.block).toContain("### Project Rule [project]");
  expect(result.block).toContain("[lesson L1 v1]");
  expect(result.block).toContain("### Global Rule [global]");
  expect(result.block).toContain("[lesson L2 v1]");
});

test("mixed suppressed and budget-excluded are both in excluded list", () => {
  const kept = [
    makeLessonResult({ lessonId: "L1", body: "fits in budget" }),
    makeLessonResult({ lessonId: "L2", body: "x".repeat(1000) }),
  ];
  const suppressed: SuppressedLesson[] = [
    { lessonId: "L3", conflictsWith: "L1", bodyOverlap: 0.4 },
  ];
  const result = packLessonContext({
    kept,
    suppressed,
    query: "test",
    tokenBudget: 50,
  });

  const reasons = result.excluded.map((e) => e.reason);
  expect(reasons).toContain("conflict-suppressed");
  expect(reasons).toContain("budget-exceeded");
  expect(result.excluded).toHaveLength(2);
});

test("packed lessons preserve version and scope from input", () => {
  const lesson = makeLessonResult({
    lessonId: "L1",
    version: 3,
    scope: "project",
    projectId: "P1",
  });
  const result = packLessonContext({
    kept: [lesson],
    suppressed: [],
    query: "test",
  });

  expect(result.packed[0]!.version).toBe(3);
  expect(result.packed[0]!.scope).toBe("project");
});
