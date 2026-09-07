import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  loadRoutingReplayBenchmarkCorpus,
  RoutingReplayCorpusError,
  runRoutingReplayBenchmark,
} from "../src/core/index.js";

const corpusPath = join(import.meta.dir, "../benchmarks/synthetic-routing-replay.v1.json");

type MutableCorpus = {
  gates: Record<string, unknown>;
  cases: Array<Record<string, unknown>>;
};

function malformedCorpus(mutate: (corpus: MutableCorpus) => void): string {
  const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as MutableCorpus;
  mutate(corpus);
  return JSON.stringify(corpus);
}

test("rejects invalid replay corpora", () => {
  expect(() => loadRoutingReplayBenchmarkCorpus("not json")).toThrow(RoutingReplayCorpusError);
  expect(() => loadRoutingReplayBenchmarkCorpus(JSON.stringify({
    schemaVersion: 1,
    now: "not-a-date",
    gates: { minEvidenceSamples: 5, confidenceFloor: 0.5, utilityMargin: 0.05 },
    cases: [],
  }))).toThrow("now must be an ISO date-time");

  const malformed = [
    malformedCorpus((corpus) => {
      corpus.cases.push(structuredClone(corpus.cases[0] as Record<string, unknown>));
    }),
    malformedCorpus((corpus) => {
      const candidates = corpus.cases[0]?.candidates as Array<Record<string, unknown>>;
      candidates.push(structuredClone(candidates[0] as Record<string, unknown>));
    }),
    malformedCorpus((corpus) => {
      const history = corpus.cases[0]?.history as Array<Record<string, unknown>>;
      history[0] = { ...history[0], count: 1.5 };
    }),
    malformedCorpus((corpus) => {
      const expected = corpus.cases[0]?.expected as Record<string, unknown>;
      expected.qualityBackoffLevel = 4;
    }),
    malformedCorpus((corpus) => {
      corpus.gates.confidenceFloor = 2;
    }),
  ];
  for (const content of malformed) {
    expect(() => loadRoutingReplayBenchmarkCorpus(content)).toThrow(RoutingReplayCorpusError);
  }
});

test("replays synthetic histories through the production routing pipeline", () => {
  const corpus = loadRoutingReplayBenchmarkCorpus(readFileSync(corpusPath, "utf8"));
  const result = runRoutingReplayBenchmark({ corpus });

  expect(result.schemaVersion).toBe(1);
  expect(result.caseResults).toHaveLength(corpus.cases.length);
  expect(result.aggregate.deterministicOutputRate).toBe(1);
  expect(result.aggregate.hardConstraintCorrectness).toBe(1);
  expect(result.aggregate.profileBackoffCorrectness).toBe(1);
  expect(result.aggregate.recommendationAccuracy).toBe(8 / 9);
  expect(result.aggregate.evidenceGateAccuracy).toBe(8 / 9);
  expect(result.aggregate.evidenceBackedCoverage).toBe(7 / 9);
  expect(result.aggregate.evidenceBackedPrecision).toBe(6 / 7);

  const backoff = result.caseResults.find((item) => item.id === "profile-backoff");
  expect(backoff?.qualityBackoffLevel).toBe(2);

  const decay = result.caseResults.find((item) => item.id === "recent-evidence-outweighs-old");
  expect(decay?.recommendedModel?.model).toBe("current");
  expect(decay?.gates.find((gate) => gate.gate === "utility-margin")?.passed).toBe(true);

  const thin = result.caseResults.find((item) => item.id === "thin-evidence-gated");
  expect(thin?.isEvidenceBacked).toBe(false);
  expect(thin?.gates.find((gate) => gate.gate === "min-evidence-samples")?.passed).toBe(false);

  const hardFloor = result.caseResults.find((item) => item.id === "hard-cost-and-latency-floors");
  expect(hardFloor?.recommendedModel?.model).toBe("within-limit");
  expect(hardFloor?.rejectedModels.map((model) => model.model)).toEqual(["over-limit"]);
  expect(hardFloor?.rejections[0]?.reasons).toEqual(["cost-budget", "latency-budget"]);

  const confidenceTrap = result.caseResults.find((item) => item.id === "cost-only-confidence-trap");
  expect(confidenceTrap?.recommendedModel?.model).toBe("cheap-uncertain");
  expect(confidenceTrap?.qualitySampleCount).toBe(0);
  expect(confidenceTrap?.isEvidenceBacked).toBe(true);
  expect(confidenceTrap?.evidenceGateCorrect).toBe(false);
  expect(confidenceTrap?.knownDivergence).toContain("cost-only evidence");
});

test("allows candidate gate thresholds to be replayed without changing the corpus", () => {
  const corpus = loadRoutingReplayBenchmarkCorpus(readFileSync(corpusPath, "utf8"));
  const result = runRoutingReplayBenchmark({
    corpus,
    gates: { minEvidenceSamples: 100, confidenceFloor: 1, utilityMargin: 1 },
  });

  expect(result.gates).toEqual({ minEvidenceSamples: 100, confidenceFloor: 1, utilityMargin: 1 });
  expect(result.aggregate.evidenceBackedCoverage).toBe(0);
  expect(result.aggregate.evidenceBackedPrecision).toBeNull();
});
