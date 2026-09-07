import { expect, test } from "bun:test";

import {
  filterEligibleModels,
  ModelEligibilityInputError,
  type ModelRoutingCandidate,
} from "../src/core/index.js";

function makeCandidate(overrides?: Partial<ModelRoutingCandidate>): ModelRoutingCandidate {
  return {
    provider: "acme",
    model: "fast-1",
    variant: "default",
    capabilities: ["agentic", "tools"],
    privacy: "remote",
    available: true,
    ...overrides,
  };
}

function makeInput(
  overrides?: Partial<Parameters<typeof filterEligibleModels>[0]>,
): Parameters<typeof filterEligibleModels>[0] {
  return {
    candidates: [makeCandidate()],
    requiredCapabilities: [],
    privacyPolicy: "any",
    hardLimits: { maxCostPerTaskUsd: null, maxLatencyMs: null },
    ...overrides,
  };
}

test("an available candidate with no constraints stays eligible and keeps its identity", () => {
  const result = filterEligibleModels(makeInput());

  expect(result.eligible).toEqual([
    {
      provider: "acme",
      model: "fast-1",
      variant: "default",
      capabilities: ["agentic", "tools"],
      privacy: "remote",
      observedCostUsd: null,
      observedLatencyMs: null,
    },
  ]);
  expect(result.rejections).toEqual([]);
});

test("an unavailable candidate is rejected as unavailable", () => {
  const result = filterEligibleModels(
    makeInput({ candidates: [makeCandidate({ available: false })] }),
  );

  expect(result.eligible).toEqual([]);
  expect(result.rejections).toEqual([
    { provider: "acme", model: "fast-1", variant: "default", reasons: ["unavailable"] },
  ]);
});

test("a candidate missing a required capability is rejected", () => {
  const result = filterEligibleModels(
    makeInput({
      candidates: [
        makeCandidate({ model: "small", capabilities: ["agentic"] }),
        makeCandidate({ model: "full", capabilities: ["agentic", "tools"] }),
      ],
      requiredCapabilities: ["tools"],
    }),
  );

  expect(result.eligible.map((candidate) => candidate.model)).toEqual(["full"]);
  expect(result.rejections).toEqual([
    { provider: "acme", model: "small", variant: "default", reasons: ["missing-capabilities"] },
  ]);
});

test("a local-only privacy policy rejects remote candidates", () => {
  const result = filterEligibleModels(
    makeInput({
      candidates: [
        makeCandidate({ model: "cloud", privacy: "remote" }),
        makeCandidate({ model: "onsite", privacy: "local" }),
      ],
      privacyPolicy: "local-only",
    }),
  );

  expect(result.eligible.map((candidate) => candidate.model)).toEqual(["onsite"]);
  expect(result.rejections).toEqual([
    { provider: "acme", model: "cloud", variant: "default", reasons: ["privacy-policy"] },
  ]);
});

test("the any privacy policy keeps remote candidates eligible", () => {
  const result = filterEligibleModels(makeInput({ privacyPolicy: "any" }));

  expect(result.eligible.map((candidate) => candidate.privacy)).toEqual(["remote"]);
});

test("observed cost above the configured limit is rejected", () => {
  const result = filterEligibleModels(
    makeInput({
      candidates: [
        makeCandidate({ model: "cheap", observedCostUsd: 0.1 }),
        makeCandidate({ model: "pricey", observedCostUsd: 0.5 }),
      ],
      hardLimits: { maxCostPerTaskUsd: 0.25, maxLatencyMs: null },
    }),
  );

  expect(result.eligible.map((candidate) => candidate.model)).toEqual(["cheap"]);
  expect(result.rejections).toEqual([
    { provider: "acme", model: "pricey", variant: "default", reasons: ["cost-budget"] },
  ]);
});

test("observed cost exactly at the limit stays eligible", () => {
  const result = filterEligibleModels(
    makeInput({
      candidates: [makeCandidate({ observedCostUsd: 0.25 })],
      hardLimits: { maxCostPerTaskUsd: 0.25, maxLatencyMs: null },
    }),
  );

  expect(result.eligible).toHaveLength(1);
});

test("observed latency above the configured limit is rejected", () => {
  const result = filterEligibleModels(
    makeInput({
      candidates: [makeCandidate({ observedLatencyMs: 20_000 })],
      hardLimits: { maxCostPerTaskUsd: null, maxLatencyMs: 10_000 },
    }),
  );

  expect(result.eligible).toEqual([]);
  expect(result.rejections).toEqual([
    { provider: "acme", model: "fast-1", variant: "default", reasons: ["latency-budget"] },
  ]);
});

test("candidates without observed cost or latency evidence cannot breach a hard limit", () => {
  const result = filterEligibleModels(
    makeInput({
      hardLimits: { maxCostPerTaskUsd: 0.01, maxLatencyMs: 1_000 },
    }),
  );

  expect(result.rejections).toEqual([]);
  expect(result.eligible).toHaveLength(1);
});

test("null hard limits never reject candidates with large observed estimates", () => {
  const result = filterEligibleModels(
    makeInput({
      candidates: [makeCandidate({ observedCostUsd: 999, observedLatencyMs: 999_999 })],
      hardLimits: { maxCostPerTaskUsd: null, maxLatencyMs: null },
    }),
  );

  expect(result.eligible).toHaveLength(1);
});

test("a candidate failing several filters reports every reason in fixed order", () => {
  const result = filterEligibleModels(
    makeInput({
      candidates: [
        makeCandidate({
          available: false,
          capabilities: ["chat"],
          privacy: "remote",
          observedCostUsd: 5,
          observedLatencyMs: 60_000,
        }),
      ],
      requiredCapabilities: ["agentic"],
      privacyPolicy: "local-only",
      hardLimits: { maxCostPerTaskUsd: 1, maxLatencyMs: 30_000 },
    }),
  );

  expect(result.rejections).toEqual([
    {
      provider: "acme",
      model: "fast-1",
      variant: "default",
      reasons: ["unavailable", "missing-capabilities", "privacy-policy", "cost-budget", "latency-budget"],
    },
  ]);
});

test("input order is preserved for eligible candidates and rejections", () => {
  const result = filterEligibleModels(
    makeInput({
      candidates: [
        makeCandidate({ model: "b", available: false }),
        makeCandidate({ model: "a" }),
        makeCandidate({ model: "c", privacy: "local" }),
      ],
      privacyPolicy: "local-only",
    }),
  );

  expect(result.eligible.map((candidate) => candidate.model)).toEqual(["c"]);
  expect(result.rejections.map((rejection) => rejection.model)).toEqual(["b", "a"]);
  expect(result.rejections.map((rejection) => rejection.reasons)).toEqual([
    ["unavailable", "privacy-policy"],
    ["privacy-policy"],
  ]);
});

test("an empty candidate list yields an empty result", () => {
  const result = filterEligibleModels(makeInput({ candidates: [] }));

  expect(result.eligible).toEqual([]);
  expect(result.rejections).toEqual([]);
});

test("invalid inputs are rejected with typed errors", () => {
  const invalidInputs: Array<Parameters<typeof filterEligibleModels>[0]> = [
    makeInput({ candidates: [makeCandidate({ provider: "" })] }),
    makeInput({ candidates: [makeCandidate({ model: "" })] }),
    makeInput({ candidates: [makeCandidate({ variant: "" })] }),
    makeInput({ candidates: [makeCandidate({ capabilities: ["tools", ""] })] }),
    makeInput({ candidates: [makeCandidate({ privacy: "unknown" as "local" })] }),
    makeInput({ candidates: [makeCandidate({ available: "yes" as unknown as boolean })] }),
    makeInput({ candidates: [makeCandidate({ observedCostUsd: -1 })] }),
    makeInput({ candidates: [makeCandidate({ observedLatencyMs: Number.NaN })] }),
    makeInput({ requiredCapabilities: [""] }),
    makeInput({ privacyPolicy: "sometimes" as "any" }),
    makeInput({ hardLimits: { maxCostPerTaskUsd: 0, maxLatencyMs: null } }),
    makeInput({ hardLimits: { maxCostPerTaskUsd: -5, maxLatencyMs: null } }),
    makeInput({ hardLimits: { maxCostPerTaskUsd: Number.POSITIVE_INFINITY, maxLatencyMs: null } }),
  ];

  for (const input of invalidInputs) {
    expect(() => filterEligibleModels(input)).toThrow(ModelEligibilityInputError);
  }
});

test("unknown keys on the input, candidates, and hard limits are rejected", () => {
  expect(() =>
    filterEligibleModels({
      ...makeInput(),
      unknown: true,
    } as unknown as Parameters<typeof filterEligibleModels>[0]),
  ).toThrow(ModelEligibilityInputError);

  expect(() =>
    filterEligibleModels(
      makeInput({
        candidates: [{ ...makeCandidate(), cost: 1 } as unknown as ModelRoutingCandidate],
      }),
    ),
  ).toThrow(ModelEligibilityInputError);

  expect(() =>
    filterEligibleModels(
      makeInput({
        hardLimits: {
          maxCostPerTaskUsd: null,
          maxLatencyMs: null,
          extra: 1,
        } as unknown as Parameters<typeof filterEligibleModels>[0]["hardLimits"],
      }),
    ),
  ).toThrow(ModelEligibilityInputError);
});
