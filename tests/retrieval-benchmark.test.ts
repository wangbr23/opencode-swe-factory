import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  RetrievalBenchmarkCorpusError,
  loadConfirmedLessonRetrievalBenchmarkCorpus,
  runConfirmedLessonRetrievalBenchmark,
  type EmbedLessonTextFn,
} from "../src/core/index.js";
import { EMBEDDING_VECTOR_DIMENSIONS } from "../src/types/embedding-types.js";

const corpusPath = join(import.meta.dir, "../benchmarks/confirmed-lesson-retrieval.v1.json");

function deterministicEmbed(text: string): Float32Array {
  const vector = new Float32Array(EMBEDDING_VECTOR_DIMENSIONS);
  const normalized = text.toLowerCase();
  const axis = normalized.includes("migration") ? 1
    : normalized.includes("verify") || normalized.includes("automated checks") ? 2
      : normalized.includes("typescript test") || normalized.includes("node test") ? 3
        : normalized.includes("python") || normalized.includes("pytest") ? 4
          : normalized.includes("long context") ? 5 : 0;
  vector[axis] = 1;
  return vector;
}

const embed: EmbedLessonTextFn = async (text) => deterministicEmbed(text);

test("rejects corpus fixtures with invalid versions and dangling expectations", () => {
  expect(() => loadConfirmedLessonRetrievalBenchmarkCorpus("not json")).toThrow(RetrievalBenchmarkCorpusError);
  expect(() => loadConfirmedLessonRetrievalBenchmarkCorpus(JSON.stringify({
    schemaVersion: 1,
    lessons: [{ lessonId: "one", scope: "global", projectId: null, versions: [{ version: 1, title: "a", body: "b", rationale: "c", active: false }] }],
    cases: [{ id: "case", projectId: "project", query: "query", tokenBudget: 1, relevantLessonIds: ["missing"], expectedSuppressedLessonIds: [] }],
  }))).toThrow("exactly one active version");
});

test("runs the corpus through migrated SQLite and reports deterministic per-case metrics", async () => {
  const corpus = loadConfirmedLessonRetrievalBenchmarkCorpus(readFileSync(corpusPath, "utf8"));
  let tick = 0;
  const result = await runConfirmedLessonRetrievalBenchmark({
    corpus,
    embed,
    clock: () => {
      tick += 7;
      return tick;
    },
  });

  expect(result.schemaVersion).toBe(1);
  expect(result.caseResults).toHaveLength(corpus.cases.length);
  expect(result.caseResults.find((item) => item.id === "exact-match")?.retrievedLessonIds).toContain("global-superseded");
  expect(result.caseResults.find((item) => item.id === "project-over-global")?.retrievedLessonIds).not.toContain("project-other-commit");
  expect(result.caseResults.find((item) => item.id === "unresolved-conflict")?.suppressedLessonIds).toContain("global-conflict-b");
  expect(result.caseResults.find((item) => item.id === "budget-pressure")?.contextBudgetCompliant).toBe(true);
  expect(result.aggregate.coldLatencyMs).toBe(14);
  expect(result.aggregate.warmLatencyMs).toBe(7);
  expect(result.aggregate.recallAtK).toBeGreaterThan(0);
  expect(result.aggregate.incorrectInjectionRate).toBeGreaterThanOrEqual(0);
});
