import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EXACT_TASK_DIMENSION_BOOST,
  LessonHybridRetrievalInputError,
  RECIPROCAL_RANK_FUSION_K,
  fuseLessonRetrieval,
  migrateSqliteSchema,
  openSqliteConnection,
  releaseSchemaMigrations,
  retrieveConfirmedLessonsHybrid,
  type LexicalLessonResult,
  type SemanticLessonResult,
  type SqliteConnection,
} from "../src/core/index.js";

function lexical(lessonId: string, rank: number, overrides: Partial<LexicalLessonResult> = {}): LexicalLessonResult {
  return {
    lessonId,
    version: 1,
    projectId: null,
    scope: "global",
    title: lessonId,
    body: lessonId,
    rationale: "why",
    applicability: {},
    provenance: {},
    createdAt: "2026-09-06T00:00:00.000Z",
    lexicalRank: rank,
    ...overrides,
  };
}

function semantic(lessonId: string, rank: number, overrides: Partial<SemanticLessonResult> = {}): SemanticLessonResult {
  return {
    lessonId,
    version: 1,
    projectId: null,
    scope: "global",
    title: lessonId,
    body: lessonId,
    rationale: "why",
    applicability: {},
    provenance: {},
    createdAt: "2026-09-06T00:00:00.000Z",
    similarity: 1,
    semanticRank: rank,
    ...overrides,
  };
}

test("fuses overlap and single-channel candidates with exact reciprocal-rank math", () => {
  const results = fuseLessonRetrieval({
    lexical: [lexical("both", 1), lexical("lexical-only", 2)],
    semantic: [semantic("semantic-only", 1), semantic("both", 2)],
  });

  const both = results.find((lesson) => lesson.lessonId === "both")!;
  expect(both.lexicalRank).toBe(1);
  expect(both.semanticRank).toBe(2);
  expect(both.contributions.reciprocalRankFusion).toBe(
    1 / (RECIPROCAL_RANK_FUSION_K + 1) + 1 / (RECIPROCAL_RANK_FUSION_K + 2),
  );
  expect(results.find((lesson) => lesson.lessonId === "lexical-only")!.semanticRank).toBeNull();
  expect(results.find((lesson) => lesson.lessonId === "lexical-only")!.similarity).toBeNull();
  expect(results.find((lesson) => lesson.lessonId === "semantic-only")!.lexicalRank).toBeNull();
  expect(results.find((lesson) => lesson.lessonId === "semantic-only")!.similarity).toBe(1);
  expect(results[0]!.lessonId).toBe("both");
});

test("preserves project precedence and deterministic lesson-id ties", () => {
  const results = fuseLessonRetrieval({
    lexical: [lexical("z-global", 1), lexical("project", 2, { scope: "project", projectId: "p" }), lexical("a-global", 3)],
    semantic: [],
  });
  expect(results.map((lesson) => lesson.lessonId)).toEqual(["project", "z-global", "a-global"]);

  const ties = fuseLessonRetrieval({ lexical: [lexical("z", 1), lexical("a", 1)], semantic: [] });
  expect(ties.map((lesson) => lesson.lessonId)).toEqual(["a", "z"]);
});

test("applies only explicit exact applicability dimensions", () => {
  const [result] = fuseLessonRetrieval({
    lexical: [lexical("matched", 1, { applicability: { activity: "test", taskTypes: ["test"], languages: ["typescript"], ignored: "test" } })],
    semantic: [],
    taskProfile: { activity: "test", stack: ["typescript"] },
  });
  expect(result!.contributions.exactTaskDimensions).toBe(2 * EXACT_TASK_DIMENSION_BOOST);
});

test("filters mismatched known applicability constraints before ranking", () => {
  const results = fuseLessonRetrieval({
    lexical: [
      lexical("matching", 2, { applicability: { activity: " Test ", languages: ["TypeScript"] } }),
      lexical("mismatched", 1, { applicability: { activity: "build", domain: "security" } }),
    ],
    semantic: [],
    taskProfile: { activity: "test", domain: "security", stack: ["typescript"] },
  });
  expect(results.map((lesson) => lesson.lessonId)).toEqual(["matching"]);
});

test("treats activity aliases as one dimension and unknown profile dimensions as universal", () => {
  const results = fuseLessonRetrieval({
    lexical: [
      lexical("aliases", 1, { applicability: { activity: "test", taskTypes: ["test"] } }),
      lexical("unknown", 2, { applicability: { domain: "security", complexity: "high", languages: ["rust"] } }),
    ],
    semantic: [],
    taskProfile: { activity: "test" },
  });
  expect(results.map((lesson) => lesson.lessonId)).toEqual(["aliases", "unknown"]);
  expect(results[0]!.contributions.exactTaskDimensions).toBe(EXACT_TASK_DIMENSION_BOOST);
});

test("validates fusion limits", () => {
  expect(() => fuseLessonRetrieval({ lexical: [], semantic: [], limit: 0 })).toThrow(LessonHybridRetrievalInputError);
  expect(() => fuseLessonRetrieval({ lexical: [], semantic: [], limit: 101 })).toThrow(LessonHybridRetrievalInputError);
  expect(() => fuseLessonRetrieval({ lexical: [lexical("bad", 0)], semantic: [] })).toThrow(LessonHybridRetrievalInputError);
  expect(() => fuseLessonRetrieval({ lexical: [], semantic: [semantic("bad", 1.5)] })).toThrow(LessonHybridRetrievalInputError);
});

test("falls back to lexical results and reports semantic failure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-hybrid-"));
  const connection: SqliteConnection = openSqliteConnection(join(directory, "memory.sqlite"));
  migrateSqliteSchema(connection, releaseSchemaMigrations);
  try {
    const now = "2026-09-06T00:00:00.000Z";
    connection.database.run("INSERT INTO lessons (id, project_id, scope, active_version, created_at, updated_at) VALUES ('lesson', NULL, 'global', 1, ?, ?)", [now, now]);
    connection.database.run("INSERT INTO lesson_versions (lesson_id, version, title, body, rationale, applicability_json, provenance_json, created_at) VALUES ('lesson', 1, 'Run tests', 'Run tests before commit', 'why', '{}', '{}', ?)", [now]);

    const result = await retrieveConfirmedLessonsHybrid(connection, {
      projectId: "project",
      query: "tests",
      embed: async () => { throw new Error("runtime unavailable"); },
    });

    expect(result.lessons.map((lesson) => lesson.lessonId)).toEqual(["lesson"]);
    expect(result.semantic).toEqual({ status: "unavailable", candidateCount: 0, error: "runtime unavailable" });
  } finally {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
