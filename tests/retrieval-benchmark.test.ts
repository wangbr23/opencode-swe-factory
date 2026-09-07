import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { EmbedLessonTextFn } from "../src/types/lesson-embedding-index-types.js";
import { EMBEDDING_VECTOR_DIMENSIONS } from "../src/types/embedding-types.js";
import {
  RetrievalBenchmarkCorpusError,
  loadConfirmedLessonRetrievalBenchmarkCorpus,
  runConfirmedLessonRetrievalBenchmark,
} from "../benchmarks/retrieval-benchmark.js";

const corpusPath = join(import.meta.dir, "../benchmarks/confirmed-lesson-retrieval.v1.json");

function deterministicEmbed(text: string): Float32Array {
  const vector = new Float32Array(EMBEDDING_VECTOR_DIMENSIONS);
  const normalized = text.toLowerCase();
  const axis = normalized.includes("placeholder") || normalized.includes("bind sql") ? 1
    : normalized.includes("migration") ? 2
      : normalized.includes("typescript test") || normalized.includes("node test") ? 3
        : normalized.includes("legacy deployment") ? 4
          : normalized.includes("long context") ? 5
            : normalized.includes("bun test") ? 6 : 0;
  vector[axis] = 1;
  return vector;
}

const embed: EmbedLessonTextFn = async (text) => deterministicEmbed(text);

test("rejects invalid active-version data before validating expectations", () => {
  expect(() => loadConfirmedLessonRetrievalBenchmarkCorpus(JSON.stringify({
    schemaVersion: 1,
    lessons: [{
      lessonId: "one",
      scope: "global",
      projectId: null,
      versions: [{
        version: 1,
        title: "title",
        body: "body",
        rationale: "rationale",
        applicability: {},
        createdAt: "2026-01-01T00:00:00.000Z",
        active: false,
      }],
    }],
    cases: [{
      id: "case",
      projectId: "project",
      query: "query",
      tokenBudget: 1,
      relevantLessonIds: ["missing"],
      expectedSuppressedLessonIds: [],
      expectedPackedLessonIds: [],
    }],
  }))).toThrow("exactly one active version");
});

test("rejects dangling expectation IDs after valid version data", () => {
  expect(() => loadConfirmedLessonRetrievalBenchmarkCorpus(JSON.stringify({
    schemaVersion: 1,
    lessons: [{
      lessonId: "one",
      scope: "global",
      projectId: null,
      versions: [{
        version: 1,
        title: "title",
        body: "body",
        rationale: "rationale",
        applicability: {},
        createdAt: "2026-01-01T00:00:00.000Z",
        active: true,
      }],
    }],
    cases: [{
      id: "case",
      projectId: "project",
      query: "query",
      tokenBudget: 1,
      relevantLessonIds: ["missing"],
      expectedSuppressedLessonIds: [],
      expectedPackedLessonIds: [],
    }],
  }))).toThrow("unknown lesson missing");
});

test("reports exact deterministic retrieval, packing, and latency metrics", async () => {
  const corpus = loadConfirmedLessonRetrievalBenchmarkCorpus(readFileSync(corpusPath, "utf8"));
  expect(corpus.lessons.filter((lesson) => lesson.scope === "global")).toHaveLength(19);

  let tick = 0;
  let factoryCalls = 0;
  const result = await runConfirmedLessonRetrievalBenchmark({
    corpus,
    createEmbed: async () => {
      factoryCalls += 1;
      return embed;
    },
    clock: () => {
      tick += 10;
      return tick;
    },
  });

  expect(factoryCalls).toBe(1);
  expect(result.caseResults).toHaveLength(7);
  expect(result.caseResults.map((item) => item.id)).toEqual(corpus.cases.map((item) => item.id));
  expect(result.caseResults.every((item) => item.semanticAvailable)).toBe(true);
  expect(result.caseResults.every((item) => item.semanticCandidateCount > 0)).toBe(true);
  expect(result.caseResults.map((item) => item.contextBudgetCompliant)).toEqual([true, true, true, true, true, true, true]);
  expect(result.caseResults.find((item) => item.id === "project-over-global")?.retrievedLessonIds).not.toContain("project-commit-other");
  expect(result.caseResults.find((item) => item.id === "semantic-paraphrase")?.retrievedLessonIds).toHaveLength(10);
  expect(result.caseResults.find((item) => item.id === "semantic-paraphrase")?.retrievedLessonIds).toContain("global-neighbor-01");
  expect(result.caseResults.find((item) => item.id === "active-version")?.retrievedLessonVersions).toContainEqual({
    lessonId: "global-superseded",
    version: 2,
  });
  expect(result.caseResults.find((item) => item.id === "applicability-mismatch")?.retrievedLessonIds).not.toContain("global-python-test");
  expect(result.caseResults.find((item) => item.id === "unresolved-conflict")?.suppressedLessonIds).toEqual(["global-conflict-b"]);
  expect(result.caseResults.find((item) => item.id === "budget-exclusion")?.packedLessonIds).toEqual([]);
  expect(result.aggregate).toEqual({
    recallAtK: 1,
    meanReciprocalRank: 1,
    incorrectInjectionRate: 41 / 47,
    conflictSuppressionCorrectness: 1 / 7,
    packingCorrectness: 1 / 7,
    contextBudgetCompliance: 1,
    semanticAvailability: 1,
    coldLatencyMs: 30,
    setupLatencyMs: 10,
    warmLatencyMs: 10,
  });
});

test("reports query embedding failures as semantic unavailability", async () => {
  const corpus = loadConfirmedLessonRetrievalBenchmarkCorpus(readFileSync(corpusPath, "utf8"));
  const failedQuery = corpus.cases[0]!.query;
  const result = await runConfirmedLessonRetrievalBenchmark({
    corpus,
    createEmbed: async () => async (text) => {
      if (text === failedQuery) {
        throw new Error("query embedding failed");
      }
      return embed(text);
    },
  });

  expect(result.caseResults[0]?.semanticAvailable).toBe(false);
  expect(result.caseResults[0]?.semanticCandidateCount).toBe(0);
  expect(result.aggregate.semanticAvailability).toBe(6 / 7);
});
