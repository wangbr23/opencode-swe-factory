import { expect, test } from "bun:test";

import { EVIDENCE_AGGREGATION_CONSTANTS } from "../../src/core/evidence-aggregation-constants.js";
import type {
  DecayedDimensionEstimate,
  DecayedEvidenceSummary,
  EligibleModelCandidate,
  EvidenceBackoffLevel,
} from "../../src/core/index.js";
import type { ResolvedFeatureToggles } from "../../src/types/feature-toggle-types.js";
import type {
  ComputeRoutingReceiptInput,
  RoutingReceipt,
} from "../../src/types/routing-receipt-types.js";
import {
  computeRoutingReceipt,
  createRoutingReceiptState,
  describeRoutingReceipt,
} from "../../src/opencode/routing-receipt.js";

const NOW = new Date("2026-09-06T12:00:00.000Z");

const OPEN_GATES = { minEvidenceSamples: 1, confidenceFloor: 0.5, utilityMargin: 0 };

const ENTRY_A = {
  provider: "acme",
  model: "model-a",
  variant: "default",
  capabilities: ["toolcall"],
  privacy: "remote" as const,
};

const ENTRY_B = {
  provider: "acme",
  model: "model-b",
  variant: "default",
  capabilities: ["toolcall"],
  privacy: "remote" as const,
};

const ALLOWLIST = [ENTRY_A, ENTRY_B];

function makeToggles(
  overrides?: Partial<ResolvedFeatureToggles>,
): ResolvedFeatureToggles {
  return {
    privateMode: false,
    retrieval: true,
    recording: true,
    modelTelemetry: true,
    routing: true,
    ...overrides,
  };
}

function makeInput(
  overrides?: Partial<ComputeRoutingReceiptInput>,
): ComputeRoutingReceiptInput {
  return {
    mode: "recommendation-only",
    preset: "balanced",
    allowlist: ALLOWLIST,
    hardLimits: { maxCostPerTaskUsd: null, maxLatencyMs: null },
    gates: OPEN_GATES,
    now: NOW,
    ...overrides,
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

function evidenceSummary(
  candidate: EligibleModelCandidate,
  evidence: Partial<
    Record<DecayedDimensionEstimate["dimension"], { mean: number; backoffLevel?: EvidenceBackoffLevel }>
  >,
): DecayedEvidenceSummary {
  const estimates = (["quality", "reliability", "cost", "latency"] as const).map(
    (dimension) => {
      const found = evidence[dimension];
      return makeEstimate(dimension, {
        mean: found?.mean ?? null,
        ...(found === undefined ? {} : { sampleCount: 2, effectiveSampleSize: 2 }),
        ...(found?.backoffLevel === undefined ? {} : { backoffLevel: found.backoffLevel }),
      });
    },
  );
  return {
    provider: candidate.provider,
    model: candidate.model,
    variant: candidate.variant,
    estimates,
    consideredSignalCount: 2,
  };
}

function injectedEvidence(
  summaries: ReadonlyArray<DecayedEvidenceSummary>,
): NonNullable<ComputeRoutingReceiptInput["loadEvidence"]> {
  return (candidate) => {
    const found = summaries.find(
      (entry) =>
        entry.provider === candidate.provider &&
        entry.model === candidate.model &&
        entry.variant === candidate.variant,
    );
    if (found) return found;
    return {
      provider: candidate.provider,
      model: candidate.model,
      variant: candidate.variant,
      estimates: (["quality", "reliability", "cost", "latency"] as const).map(
        (dimension) => makeEstimate(dimension),
      ),
      consideredSignalCount: 0,
    };
  };
}

function gateOf(receipt: RoutingReceipt, gate: string) {
  const found = receipt.gates.find((entry) => entry.gate === gate);
  if (!found) throw new Error(`missing ${gate} gate evaluation`);
  return found;
}

// --- Skip reasons ---

test("private mode skips receipt computation before anything else", () => {
  const result = computeRoutingReceipt(undefined as never, makeToggles({ privateMode: true }), makeInput());
  expect(result).toEqual({ status: "skipped", reason: "private-mode" });
});

test("routing toggle off skips receipt computation", () => {
  const result = computeRoutingReceipt(
    undefined as never,
    makeToggles({ routing: false }),
    makeInput(),
  );
  expect(result).toEqual({ status: "skipped", reason: "routing-disabled" });
});

test("disabled routing mode skips receipt computation", () => {
  const result = computeRoutingReceipt(
    undefined as never,
    makeToggles(),
    makeInput({ mode: "disabled" }),
  );
  expect(result).toEqual({ status: "skipped", reason: "routing-mode-disabled" });
});

test("empty allowlist skips receipt computation", () => {
  const result = computeRoutingReceipt(
    undefined as never,
    makeToggles(),
    makeInput({ allowlist: [] }),
  );
  expect(result).toEqual({ status: "skipped", reason: "empty-allowlist" });
});

// --- Receipt computation ---

// With injected evidence the connection is never read; the core suite makes
// the same substitution in tests/model-recommendation.test.ts.
const noConnection = undefined as never;

test("computes a receipt with the evidence-backed winner and its dimension why", () => {
  const result = computeRoutingReceipt(noConnection, makeToggles(), makeInput({
    allowlist: [ENTRY_A],
    loadEvidence: injectedEvidence([
      evidenceSummary(
        { provider: "acme", model: "model-a", variant: "default", capabilities: [], privacy: "remote", observedCostUsd: null, observedLatencyMs: null },
        { quality: { mean: 0.9 } },
      ),
    ]),
  }));

  expect(result.status).toBe("computed");
  if (result.status !== "computed") return;
  const receipt = result.receipt;

  expect(receipt.mode).toBe("recommendation-only");
  expect(receipt.preset).toBe("balanced");
  expect(receipt.computedAt).toBe(NOW.toISOString());
  expect(receipt.recommendation).toEqual({
    provider: "acme",
    model: "model-a",
    variant: "default",
    utility: 0.9,
    evidenceSampleCount: 2,
    evidenceWeightShare: 1,
    dimensions: [{ dimension: "quality", score: 0.9, weight: 1, backedBy: "evidence" }],
  });
  expect(receipt.isEvidenceBacked).toBe(true);
  expect(receipt.currentModel).toBeNull();
  expect(gateOf(receipt, "utility-margin")).toEqual({
    gate: "utility-margin",
    required: 0,
    actual: null,
    passed: true,
  });
  expect(receipt.rejections).toEqual([]);
});

test("prior-backed dimensions are labeled as priors in the receipt", () => {
  const result = computeRoutingReceipt(noConnection, makeToggles(), makeInput({
    allowlist: [ENTRY_A],
    priors: [
      {
        provider: "acme",
        model: "model-a",
        variant: "default",
        estimates: { reliability: 1 },
      },
    ],
    loadEvidence: injectedEvidence([
      evidenceSummary(
        { provider: "acme", model: "model-a", variant: "default", capabilities: [], privacy: "remote", observedCostUsd: null, observedLatencyMs: null },
        { quality: { mean: 0.9 } },
      ),
    ]),
  }));

  expect(result.status).toBe("computed");
  if (result.status !== "computed") return;
  const dimensions = result.receipt.recommendation?.dimensions ?? [];
  expect(dimensions).toHaveLength(2);
  expect(dimensions.find((entry) => entry.dimension === "quality")?.backedBy).toBe("evidence");
  // The reliability prior ranks at backoff level 3, so its preset weight is
  // discounted by backoffLevelWeights[3] before renormalization.
  const priorDiscount = EVIDENCE_AGGREGATION_CONSTANTS.backoffLevelWeights[3];
  expect(dimensions.find((entry) => entry.dimension === "reliability")).toEqual({
    dimension: "reliability",
    score: 1,
    weight: (0.2 * priorDiscount) / (0.5 + 0.2 * priorDiscount),
    backedBy: "prior",
  });
});

test("the host model's own standing rides along when it is on the ballot", () => {
  const hostModel = { provider: "acme", model: "model-b", variant: "default" };
  const result = computeRoutingReceipt(noConnection, makeToggles(), makeInput({
    currentModel: hostModel,
    loadEvidence: injectedEvidence([]),
  }));

  expect(result.status).toBe("computed");
  if (result.status !== "computed") return;
  expect(result.receipt.currentModel).toEqual({
    ...hostModel,
    utility: 0,
  });
});

test("injected evidence failures return a structured failure", () => {
  const result = computeRoutingReceipt(noConnection, makeToggles(), makeInput({
    loadEvidence: () => {
      throw new Error("evidence store exploded");
    },
  }));

  expect(result).toEqual({ status: "failed", error: "evidence store exploded" });
});

// --- State and formatting ---

test("receipt state is empty and keyed per session", () => {
  const state = createRoutingReceiptState();
  expect(state.lastBySession.size).toBe(0);
});

test("describeRoutingReceipt summarizes the recommendation", () => {
  const receipt = {
    mode: "recommendation-only" as const,
    preset: "balanced" as const,
    recommendation: {
      provider: "acme",
      model: "model-a",
      variant: "default",
      utility: 0.9123,
      evidenceSampleCount: 2,
      evidenceWeightShare: 1,
      dimensions: [],
    },
    isEvidenceBacked: true,
    currentModel: null,
    gates: [],
    rejections: [],
    computedAt: NOW.toISOString(),
  };
  expect(describeRoutingReceipt(receipt)).toBe(
    "routing receipt: recommend provider=acme model=model-a variant=default utility=0.912 evidence=backed",
  );
});

test("describeRoutingReceipt reports when no model is eligible", () => {
  const receipt: RoutingReceipt = {
    mode: "recommendation-only",
    preset: "balanced",
    recommendation: null,
    isEvidenceBacked: false,
    currentModel: null,
    gates: [],
    rejections: [
      { provider: "acme", model: "model-a", variant: "default", reasons: ["unavailable"] },
    ],
    computedAt: NOW.toISOString(),
  };
  expect(describeRoutingReceipt(receipt)).toBe(
    "routing receipt: no eligible model (1 rejected)",
  );
});
