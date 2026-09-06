import { expect, test } from "bun:test";

import {
  suppressConflictingLessons,
  type LexicalLessonResult,
} from "../src/core/index.js";

function makeResult(overrides: Partial<LexicalLessonResult> & { lessonId: string; body: string }): LexicalLessonResult {
  return {
    version: 1,
    projectId: null,
    scope: "global",
    title: overrides.title ?? "Lesson",
    rationale: "Test rationale",
    applicability: {},
    provenance: {},
    createdAt: "2026-09-05T00:00:00.000Z",
    lexicalRank: 1,
    ...overrides,
  };
}

test("keeps non-conflicting lessons", () => {
  const results: LexicalLessonResult[] = [
    makeResult({ lessonId: "a", body: "Run tests before committing code changes", lexicalRank: 1 }),
    makeResult({ lessonId: "b", body: "Deploy using the staging pipeline first", lexicalRank: 2 }),
  ];

  const { kept, suppressed } = suppressConflictingLessons({ results });

  expect(kept.map((r) => r.lessonId)).toEqual(["a", "b"]);
  expect(suppressed).toHaveLength(0);
});

test("suppresses the lower-ranked lesson when two conflict", () => {
  const results: LexicalLessonResult[] = [
    makeResult({ lessonId: "a", body: "Always run lint before committing code", lexicalRank: 1 }),
    makeResult({ lessonId: "b", body: "Never run lint before committing code", lexicalRank: 2 }),
  ];

  const { kept, suppressed } = suppressConflictingLessons({ results });

  expect(kept.map((r) => r.lessonId)).toEqual(["a"]);
  expect(suppressed).toHaveLength(1);
  expect(suppressed[0]!.lessonId).toBe("b");
  expect(suppressed[0]!.conflictsWith).toBe("a");
  expect(suppressed[0]!.bodyOverlap).toBeGreaterThanOrEqual(0.15);
});

test("project-scoped lesson wins over conflicting global lesson", () => {
  const results: LexicalLessonResult[] = [
    makeResult({
      lessonId: "project-lint",
      scope: "project",
      projectId: "project-a",
      body: "Always run lint check before committing changes",
      lexicalRank: 1,
    }),
    makeResult({
      lessonId: "global-lint",
      scope: "global",
      body: "Skip lint check before committing changes to save time",
      lexicalRank: 2,
    }),
  ];

  const { kept, suppressed } = suppressConflictingLessons({ results });

  expect(kept.map((r) => r.lessonId)).toEqual(["project-lint"]);
  expect(suppressed[0]!.lessonId).toBe("global-lint");
  expect(suppressed[0]!.conflictsWith).toBe("project-lint");
});

test("does not suppress when overlap is below threshold", () => {
  const results: LexicalLessonResult[] = [
    makeResult({ lessonId: "a", body: "Configure the database connection pool size", lexicalRank: 1 }),
    makeResult({ lessonId: "b", body: "Verify deployment health check endpoint responses", lexicalRank: 2 }),
  ];

  const { kept, suppressed } = suppressConflictingLessons({ results });

  expect(kept.map((r) => r.lessonId)).toEqual(["a", "b"]);
  expect(suppressed).toHaveLength(0);
});

test("supports custom body conflict threshold", () => {
  const results: LexicalLessonResult[] = [
    makeResult({ lessonId: "a", body: "Run test suite before deployment", lexicalRank: 1 }),
    makeResult({ lessonId: "b", body: "Run test suite after deployment", lexicalRank: 2 }),
  ];

  const withLowThreshold = suppressConflictingLessons({ results, bodyConflictThreshold: 0.01 });
  expect(withLowThreshold.suppressed).toHaveLength(1);

  const withHighThreshold = suppressConflictingLessons({ results, bodyConflictThreshold: 0.99 });
  expect(withHighThreshold.suppressed).toHaveLength(0);
  expect(withHighThreshold.kept).toHaveLength(2);
});

test("handles empty input", () => {
  const { kept, suppressed } = suppressConflictingLessons({ results: [] });

  expect(kept).toHaveLength(0);
  expect(suppressed).toHaveLength(0);
});

test("handles single result", () => {
  const results: LexicalLessonResult[] = [
    makeResult({ lessonId: "a", body: "Run tests before committing", lexicalRank: 1 }),
  ];

  const { kept, suppressed } = suppressConflictingLessons({ results });

  expect(kept).toHaveLength(1);
  expect(suppressed).toHaveLength(0);
});

test("suppresses multiple conflicting lessons against the same kept lesson", () => {
  const results: LexicalLessonResult[] = [
    makeResult({ lessonId: "a", body: "always run lint check before committing code changes", lexicalRank: 1 }),
    makeResult({ lessonId: "b", body: "never run lint check before committing code changes", lexicalRank: 2 }),
    makeResult({ lessonId: "c", body: "skip lint check before committing code changes entirely", lexicalRank: 3 }),
  ];

  const { kept, suppressed } = suppressConflictingLessons({ results });

  expect(kept.map((r) => r.lessonId)).toEqual(["a"]);
  expect(suppressed).toHaveLength(2);
  expect(suppressed[0]!.conflictsWith).toBe("a");
  expect(suppressed[1]!.conflictsWith).toBe("a");
});

test("reports body overlap in suppressed entries", () => {
  const results: LexicalLessonResult[] = [
    makeResult({ lessonId: "a", body: "Run the lint check before every commit", lexicalRank: 1 }),
    makeResult({ lessonId: "b", body: "Skip the lint check before every commit", lexicalRank: 2 }),
  ];

  const { suppressed } = suppressConflictingLessons({ results });

  expect(suppressed).toHaveLength(1);
  expect(suppressed[0]!.bodyOverlap).toBeGreaterThan(0);
  expect(suppressed[0]!.bodyOverlap).toBeLessThanOrEqual(1);
});

test("preserves rank order of kept lessons", () => {
  const results: LexicalLessonResult[] = [
    makeResult({ lessonId: "first", body: "Configure the database connection pool", lexicalRank: 1 }),
    makeResult({ lessonId: "conflict-a", body: "Always run lint check before committing code", lexicalRank: 2 }),
    makeResult({ lessonId: "third", body: "Deploy using the staging pipeline endpoint", lexicalRank: 3 }),
    makeResult({ lessonId: "conflict-b", body: "Never run lint check before committing code", lexicalRank: 4 }),
  ];

  const { kept, suppressed } = suppressConflictingLessons({ results });

  expect(kept.map((r) => r.lessonId)).toEqual(["first", "conflict-a", "third"]);
  expect(suppressed.map((s) => s.lessonId)).toEqual(["conflict-b"]);
});
