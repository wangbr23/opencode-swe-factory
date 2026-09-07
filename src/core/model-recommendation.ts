import { filterEligibleModels } from "./model-eligibility.js";
import { rankEligibleModels } from "./model-ranking.js";
import type { RoutingPreset } from "../types/config-types.js";
import type { RankedDimensionContribution } from "../types/model-ranking-types.js";
import type {
  EvidenceGateEvaluation,
  ModelRecommendationResult,
  RecommendModelInput,
  RecommendedModel,
} from "../types/model-recommendation-types.js";

export type {
  EvidenceGateEvaluation,
  EvidenceGateName,
  ModelRecommendationResult,
  RecommendModelInput,
  RecommendedModel,
} from "../types/model-recommendation-types.js";

export class ModelRecommendationInputError extends Error {}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ModelRecommendationInputError(`${label} must be a non-empty string.`);
  }
  return value;
}

function validateGates(input: RecommendModelInput): RecommendModelInput["gates"] {
  const gates = input.gates;
  if (typeof gates !== "object" || gates === null || Array.isArray(gates)) {
    throw new ModelRecommendationInputError("gates must be a plain object.");
  }
  const { minEvidenceSamples, confidenceFloor, utilityMargin } = gates;
  if (
    typeof minEvidenceSamples !== "number" ||
    !Number.isInteger(minEvidenceSamples) ||
    minEvidenceSamples < 0
  ) {
    throw new ModelRecommendationInputError("gates.minEvidenceSamples must be a non-negative integer.");
  }
  for (const [name, value] of [
    ["confidenceFloor", confidenceFloor],
    ["utilityMargin", utilityMargin],
  ] as const) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new ModelRecommendationInputError(`gates.${name} must be a number between 0 and 1.`);
    }
  }
  return gates;
}

function validateInput(input: RecommendModelInput): RecommendModelInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ModelRecommendationInputError("input must be a plain object.");
  }
  if (input.preset !== "balanced" && input.preset !== "quality" && input.preset !== "economy") {
    throw new ModelRecommendationInputError(`preset must be "balanced", "quality", or "economy".`);
  }
  if (!(input.now instanceof Date) || Number.isNaN(input.now.getTime())) {
    throw new ModelRecommendationInputError("now must be a valid Date.");
  }
  if (!Array.isArray(input.candidates)) {
    throw new ModelRecommendationInputError("candidates must be an array.");
  }
  if (!Array.isArray(input.requiredCapabilities)) {
    throw new ModelRecommendationInputError("requiredCapabilities must be an array.");
  }
  if (input.privacyPolicy !== "local-only" && input.privacyPolicy !== "any") {
    throw new ModelRecommendationInputError(`privacyPolicy must be "local-only" or "any".`);
  }
  if (
    typeof input.hardLimits !== "object" ||
    input.hardLimits === null ||
    (input.hardLimits.maxCostPerTaskUsd !== null && typeof input.hardLimits.maxCostPerTaskUsd !== "number") ||
    (input.hardLimits.maxLatencyMs !== null && typeof input.hardLimits.maxLatencyMs !== "number")
  ) {
    throw new ModelRecommendationInputError("hardLimits must hold numbers or null limits.");
  }
  if (
    input.currentModel !== undefined &&
    input.currentModel !== null &&
    (typeof input.currentModel !== "object" ||
      typeof input.currentModel.provider !== "string" ||
      input.currentModel.provider.length === 0 ||
      typeof input.currentModel.model !== "string" ||
      input.currentModel.model.length === 0 ||
      typeof input.currentModel.variant !== "string" ||
      input.currentModel.variant.length === 0)
  ) {
    throw new ModelRecommendationInputError(
      "currentModel must be null or hold non-empty provider, model, and variant.",
    );
  }
  if (input.loadEvidence !== undefined && typeof input.loadEvidence !== "function") {
    throw new ModelRecommendationInputError("loadEvidence must be a function.");
  }
  return { ...input, gates: validateGates(input) };
}

/**
 * Evidence standing of one ranked candidate. A dimension is evidence-backed
 * exactly when its contribution carries a positive sampleCount — the marker
 * that distinguishes recorded signals from prior-filled estimates.
 */
function evidenceStanding(contributions: ReadonlyArray<RankedDimensionContribution>): {
  evidenceSampleCount: number;
  evidenceWeightShare: number;
} {
  let evidenceWeight = 0;
  let totalWeight = 0;
  let evidenceSampleCount = 0;
  for (const contribution of contributions) {
    if (contribution.score === null) {
      continue;
    }
    totalWeight += contribution.effectiveWeight;
    if (contribution.sampleCount > 0) {
      evidenceWeight += contribution.effectiveWeight;
      evidenceSampleCount += contribution.sampleCount;
    }
  }
  return {
    evidenceSampleCount,
    evidenceWeightShare: totalWeight > 0 ? evidenceWeight / totalWeight : 0,
  };
}

function toRecommended(
  ranked: { provider: string; model: string; variant: string; utility: number },
  contributions: ReadonlyArray<RankedDimensionContribution>,
): RecommendedModel {
  return {
    provider: ranked.provider,
    model: ranked.model,
    variant: ranked.variant,
    utility: ranked.utility,
    contributions,
    ...evidenceStanding(contributions),
  };
}

/**
 * Composes the V1 recommendation-only routing outcome: hard eligibility filters,
 * preset-weighted ranking with cold-start priors, then evidence gates that say
 * whether the winner is evidence-backed or still resting on priors. The
 * recommendation is always the best eligible model when one exists — the gates
 * label it, they do not suppress it.
 */
export function recommendModel(
  connection: Parameters<typeof rankEligibleModels>[0],
  input: RecommendModelInput,
): ModelRecommendationResult {
  const validated = validateInput(input);
  const {
    candidates,
    preset,
    now,
    currentModel,
    requiredCapabilities,
    privacyPolicy,
    hardLimits,
    priors,
    targetProfile,
    halfLifeDays,
    maxAgeDays,
    loadEvidence,
    gates,
  } = validated;

  const { eligible, rejections } = filterEligibleModels({
    candidates,
    requiredCapabilities,
    privacyPolicy,
    hardLimits,
  });

  if (eligible.length === 0) {
    return { preset, recommendation: null, isEvidenceBacked: false, gates: [], currentModel: null, rejections };
  }

  const { ranked } = rankEligibleModels(connection, {
    eligible,
    preset,
    now,
    ...(targetProfile === undefined ? {} : { targetProfile }),
    ...(halfLifeDays === undefined ? {} : { halfLifeDays }),
    ...(maxAgeDays === undefined ? {} : { maxAgeDays }),
    ...(priors === undefined ? {} : { priors }),
    ...(loadEvidence === undefined ? {} : { loadEvidence }),
  });

  const winner = ranked[0];
  if (winner === undefined) {
    return { preset, recommendation: null, isEvidenceBacked: false, gates: [], currentModel: null, rejections };
  }

  const recommendation = toRecommended(winner, winner.contributions);

  const currentRanked = currentModel
    ? ranked.find(
        (candidate) =>
          candidate.provider === currentModel.provider &&
          candidate.model === currentModel.model &&
          candidate.variant === currentModel.variant,
      )
    : undefined;
  const currentRecommended = currentRanked ? toRecommended(currentRanked, currentRanked.contributions) : null;

  const utilityMarginActual = currentRecommended === null ? null : recommendation.utility - currentRecommended.utility;
  const gateEvaluations: EvidenceGateEvaluation[] = [
    {
      gate: "min-evidence-samples",
      required: gates.minEvidenceSamples,
      actual: recommendation.evidenceSampleCount,
      passed: recommendation.evidenceSampleCount >= gates.minEvidenceSamples,
    },
    {
      gate: "confidence-floor",
      required: gates.confidenceFloor,
      actual: recommendation.evidenceWeightShare,
      passed: recommendation.evidenceWeightShare >= gates.confidenceFloor,
    },
    {
      gate: "utility-margin",
      required: gates.utilityMargin,
      actual: utilityMarginActual,
      passed: utilityMarginActual === null ? true : utilityMarginActual >= gates.utilityMargin,
    },
  ];

  return {
    preset,
    recommendation,
    isEvidenceBacked: gateEvaluations.every((gate) => gate.passed),
    gates: gateEvaluations,
    currentModel: currentRecommended,
    rejections,
  };
}
