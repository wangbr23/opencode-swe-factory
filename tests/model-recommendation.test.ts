import { expect, test } from "bun:test";

import {
  ModelRecommendationInputError,
  recommendModel,
  type DecayedDimensionEstimate,
  type DecayedEvidenceSummary,
  type EligibleModelCandidate,
  type EvidenceBackoffLevel,
  type EvidenceGateEvaluation,
  type ModelRecommendationResult,
  type ModelRoutingCandidate,
} from "../src/core/index.js";

const NOW = new Date("2026-09-06T12:00:00.000Z");

const BASE_GATES = { minEvidenceSamples: 5, confidenceFloor: 0.5, utilityMargin: 0.05 };

function makeCandidate(overrides?: Partial<ModelRoutingCandidate>): ModelRoutingCandidate {
  return {
    provider: "acme",
    model: "model-a",
    variant: "default",
    capabilities: ["agentic", "tools"],
    privacy: "remote",
    available: true,
    ...overrides,
  };
}

function makeEligible(overrides?: Partial<ModelRoutingCandidate>): EligibleModelCandidate {
  const candidate = makeCandidate(overrides);
  return {
    provider: candidate.provider,
    model: candidate.model,
    variant: candidate.variant,
    capabilities: candidate.capabilities,
    privacy: candidate.privacy,
    observedCostUsd: null,
    observedLatencyMs: null,
  };
}

function makeEstimate(
  dimension: DecayedDimensionEstimate["dimension"],
  overrides?: Partial<DecayedDimensionEstimate>,
): DecayedDimensionEstimate {
  return {
    dimension,
    backoffLevel: 0,
    mean: null,
    effectiveSampleSize: 0,
    uncertainty: 0,
    sampleCount: 0,
    decayedWeight: 0,
    ...overrides,
  };
}

function partialSummary(
  candidate: EligibleModelCandidate,
  evidence: Partial<
    Record<DecayedDimensionEstimate["dimension"], { mean: number; backoffLevel?: EvidenceBackoffLevel }>
  >,
): DecayedEvidenceSummary {
  const estimates = (["quality", "reliability", "cost", "latency"] as const).map((dimension) => {
    const found = evidence[dimension];
    return makeEstimate(dimension, {
      mean: found?.mean ?? null,
      ...(found === undefined ? {} : { sampleCount: 2, effectiveSampleSize: 2 }),
      ...(found?.backoffLevel === undefined ? {} : { backoffLevel: found.backoffLevel }),
    });
  });
  return {
    provider: candidate.provider,
    model: candidate.model,
    variant: candidate.variant,
    estimates,
    consideredSignalCount: 2,
  };
}

function recommend(input: {
  candidates?: ReadonlyArray<ModelRoutingCandidate>;
  preset?: "balanced" | "quality" | "economy";
  gates?: typeof BASE_GATES;
  currentModel?: { provider: string; model: string; variant: string } | null;
  priors?: ReadonlyArray<{ provider: string; model: string; variant: string; estimates: Record<string, number> }>;
  summaries?: ReadonlyArray<DecayedEvidenceSummary>;
}): ModelRecommendationResult {
  const candidates = input.candidates ?? [makeCandidate()];
  const eligible = candidates.map(makeEligible);
  return recommendModel(undefined as never, {
    candidates,
    preset: input.preset ?? "balanced",
    gates: input.gates ?? BASE_GATES,
    now: NOW,
    ...(input.currentModel === undefined ? {} : { currentModel: input.currentModel }),
    ...(input.priors === undefined ? {} : { priors: input.priors }),
    requiredCapabilities: [],
    privacyPolicy: "any",
    hardLimits: { maxCostPerTaskUsd: null, maxLatencyMs: null },
    loadEvidence: (candidate) => {
      const summary = (input.summaries ?? []).find(
        (entry) =>
          entry.provider === candidate.provider &&
          entry.model === candidate.model &&
          entry.variant === candidate.variant,
      );
      return summary ?? partialSummary(candidate, {});
    },
  });
}

function gateOf(result: ModelRecommendationResult, gate: string): EvidenceGateEvaluation {
  const found = result.gates.find((entry) => entry.gate === gate);
  if (!found) {
    throw new Error(`missing ${gate} gate evaluation`);
  }
  return found;
}

test("recommends the best eligible model and reports the rejected rest", () => {
  const winner = makeCandidate({ model: "winner" });
  const unavailable = makeCandidate({ model: "unavailable", available: false });
  const result = recommend({
    candidates: [winner, unavailable],
    summaries: [partialSummary(makeEligible({ model: "winner" }), { quality: { mean: 0.9 } })],
  });

  expect(result.preset).toBe("balanced");
  expect(result.recommendation?.model).toBe("winner");
  expect(result.recommendation?.utility).toBeCloseTo(0.9, 10);
  expect(result.rejections).toEqual([
    { provider: "acme", model: "unavailable", variant: "default", reasons: ["unavailable"] },
  ]);
});

test("a cold-start prior-backed recommendation is displayed but not evidence-backed", () => {
  const result = recommend({
    candidates: [makeCandidate({ model: "prior-backed" })],
    priors: [{ provider: "acme", model: "prior-backed", variant: "default", estimates: { quality: 0.9 } }],
    currentModel: { provider: "acme", model: "prior-backed", variant: "default" },
  });

  expect(result.recommendation?.model).toBe("prior-backed");
  expect(result.isEvidenceBacked).toBe(false);
  expect(gateOf(result, "min-evidence-samples")).toEqual({
    gate: "min-evidence-samples",
    required: 5,
    actual: 0,
    passed: false,
  });
  expect(gateOf(result, "confidence-floor").passed).toBe(false);
  expect(gateOf(result, "utility-margin")).toEqual({
    gate: "utility-margin",
    required: 0.05,
    actual: 0,
    passed: false,
  });
});

test("a measured winner over the host model clears every gate", () => {
  const winner = makeEligible({ model: "winner" });
  const current = makeEligible({ model: "current" });
  const result = recommend({
    candidates: [makeCandidate({ model: "winner" }), makeCandidate({ model: "current" })],
    gates: { minEvidenceSamples: 2, confidenceFloor: 0.5, utilityMargin: 0.05 },
    currentModel: { provider: "acme", model: "current", variant: "default" },
    summaries: [
      partialSummary(winner, { quality: { mean: 0.9 } }),
      partialSummary(current, { quality: { mean: 0.5 } }),
    ],
  });

  expect(result.recommendation?.model).toBe("winner");
  expect(result.isEvidenceBacked).toBe(true);
  expect(gateOf(result, "min-evidence-samples").actual).toBe(2);
  expect(gateOf(result, "confidence-floor").actual).toBe(1);
  expect(gateOf(result, "utility-margin").actual).toBeCloseTo(0.4, 10);
  expect(result.currentModel?.model).toBe("current");
  expect(result.currentModel?.utility).toBeCloseTo(0.5, 10);
});

test("the utility margin passes vacuously when the host model is not eligible", () => {
  const winner = makeEligible({ model: "winner" });
  const result = recommend({
    candidates: [makeCandidate({ model: "winner" })],
    summaries: [partialSummary(winner, { quality: { mean: 0.9 } })],
    currentModel: { provider: "acme", model: "host-only", variant: "default" },
  });

  expect(gateOf(result, "utility-margin")).toEqual({
    gate: "utility-margin",
    required: 0.05,
    actual: null,
    passed: true,
  });
  expect(result.currentModel).toBeNull();
});

test("an eligible set with no candidates yields no recommendation", () => {
  const result = recommend({
    candidates: [makeCandidate({ model: "down", available: false })],
  });

  expect(result.recommendation).toBeNull();
  expect(result.isEvidenceBacked).toBe(false);
  expect(result.gates).toEqual([]);
  expect(result.currentModel).toBeNull();
});

test("recommendModel validates its input", () => {
  const base = {
    candidates: [makeCandidate()],
    preset: "balanced" as const,
    gates: BASE_GATES,
    now: NOW,
    requiredCapabilities: [],
    privacyPolicy: "any" as const,
    hardLimits: { maxCostPerTaskUsd: null, maxLatencyMs: null },
  };
  expect(() => recommendModel(undefined as never, { ...base, preset: "fastest" as never })).toThrow(
    ModelRecommendationInputError,
  );
  expect(() => recommendModel(undefined as never, { ...base, now: new Date("nope") })).toThrow(
    ModelRecommendationInputError,
  );
  expect(() =>
    recommendModel(undefined as never, { ...base, gates: { ...BASE_GATES, minEvidenceSamples: -1 } }),
  ).toThrow(ModelRecommendationInputError);
  expect(() =>
    recommendModel(undefined as never, { ...base, gates: { ...BASE_GATES, confidenceFloor: 1.5 } }),
  ).toThrow(ModelRecommendationInputError);
  expect(() =>
    recommendModel(undefined as never, { ...base, gates: { ...BASE_GATES, utilityMargin: "big" as never } }),
  ).toThrow(ModelRecommendationInputError);
  expect(() => recommendModel(undefined as never, { ...base, privacyPolicy: "permissive" as never })).toThrow(
    ModelRecommendationInputError,
  );
  expect(() =>
    recommendModel(undefined as never, {
      ...base,
      currentModel: { provider: "acme", model: "", variant: "default" },
    }),
  ).toThrow(ModelRecommendationInputError);
  expect(() =>
    recommendModel(undefined as never, { ...base, hardLimits: { maxCostPerTaskUsd: "1", maxLatencyMs: null } as never }),
  ).toThrow(ModelRecommendationInputError);
  expect(() => recommendModel(undefined as never, { ...base, candidates: "nope" as never })).toThrow(
    ModelRecommendationInputError,
  );
});
