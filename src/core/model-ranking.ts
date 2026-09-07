import { aggregateDecayedEvidence } from "./evidence-aggregation.js";
import { EVIDENCE_AGGREGATION_CONSTANTS } from "./evidence-aggregation-constants.js";
import { MODEL_RANKING_CONSTANTS } from "./model-ranking-constants.js";
import type { SqliteConnection } from "./sqlite.js";
import type { RoutingPreset } from "../types/config-types.js";
import type { OutcomeDimension } from "../types/execution-profile-types.js";
import type {
  DecayedDimensionEstimate,
  DecayedEvidenceSummary,
  EvidenceBackoffLevel,
} from "../types/evidence-aggregation-types.js";
import type {
  ModelRankingResult,
  RankEligibleModelsInput,
  RankedDimensionContribution,
  RankedModelCandidate,
  UtilityPresetWeights,
} from "../types/model-ranking-types.js";
import type { EligibleModelCandidate } from "../types/model-eligibility-types.js";

export type {
  ModelRankingResult,
  RankEligibleModelsInput,
  RankedDimensionContribution,
  RankedModelCandidate,
  UtilityPresetWeights,
} from "../types/model-ranking-types.js";

export class ModelRankingInputError extends Error {}

const RELATIVE_DIMENSIONS: ReadonlyArray<OutcomeDimension> = ["cost", "latency"];

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ModelRankingInputError(`${label} must be a non-empty string.`);
  }
  return value;
}

function validateInput(input: RankEligibleModelsInput): {
  eligible: ReadonlyArray<EligibleModelCandidate>;
  preset: RoutingPreset;
  now: Date;
  targetProfile: RankEligibleModelsInput["targetProfile"];
  halfLifeDays: number | undefined;
  maxAgeDays: number | undefined;
  loadEvidence: RankEligibleModelsInput["loadEvidence"];
} {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ModelRankingInputError("input must be a plain object.");
  }
  const preset = input.preset;
  if (preset !== "balanced" && preset !== "quality" && preset !== "economy") {
    throw new ModelRankingInputError(`preset must be "balanced", "quality", or "economy".`);
  }
  if (!(input.now instanceof Date) || Number.isNaN(input.now.getTime())) {
    throw new ModelRankingInputError("now must be a valid Date.");
  }
  if (!Array.isArray(input.eligible)) {
    throw new ModelRankingInputError("eligible must be an array.");
  }
  for (const [index, candidate] of input.eligible.entries()) {
    requireNonEmptyString(candidate?.provider, `eligible[${index}].provider`);
    requireNonEmptyString(candidate?.model, `eligible[${index}].model`);
    requireNonEmptyString(candidate?.variant, `eligible[${index}].variant`);
  }
  if (input.halfLifeDays !== undefined && input.halfLifeDays <= 0) {
    throw new ModelRankingInputError("halfLifeDays must be positive.");
  }
  if (input.maxAgeDays !== undefined && input.maxAgeDays <= 0) {
    throw new ModelRankingInputError("maxAgeDays must be positive.");
  }
  if (input.loadEvidence !== undefined && typeof input.loadEvidence !== "function") {
    throw new ModelRankingInputError("loadEvidence must be a function.");
  }
  return {
    eligible: input.eligible,
    preset,
    now: input.now,
    targetProfile: input.targetProfile,
    halfLifeDays: input.halfLifeDays,
    maxAgeDays: input.maxAgeDays,
    loadEvidence: input.loadEvidence,
  };
}

function estimateForDimension(
  summary: DecayedEvidenceSummary,
  dimension: OutcomeDimension,
): DecayedDimensionEstimate | null {
  return summary.estimates.find((estimate) => estimate.dimension === dimension) ?? null;
}

/**
 * Cost and latency are unbounded native units (USD, ms), so their scores are
 * normalized across the eligible set: the cheapest/fastest candidate scores 1,
 * the most expensive/slowest 0, and equal values all score 1. This keeps the
 * weighted utility on the same 0-1 scale as quality and reliability without
 * inventing normalization anchors.
 */
function relativeScore(mean: number, min: number, max: number): number {
  if (max === min) {
    return 1;
  }
  return 1 - (mean - min) / (max - min);
}

type ContributionDraft = {
  dimension: OutcomeDimension;
  presetWeight: number;
  backoffLevel: EvidenceBackoffLevel;
  effectiveWeight: number;
  score: number | null;
  mean: number | null;
  uncertainty: number;
  effectiveSampleSize: number;
  sampleCount: number;
};

function scoreCandidate(
  candidate: EligibleModelCandidate,
  weights: UtilityPresetWeights,
  summary: DecayedEvidenceSummary,
  bounds: ReadonlyMap<OutcomeDimension, { min: number; max: number }>,
): RankedModelCandidate {
  const drafts: ContributionDraft[] = [];

  for (const dimension of MODEL_RANKING_CONSTANTS.dimensionOrder) {
    const estimate = estimateForDimension(summary, dimension);
    const presetWeight = weights[dimension];
    const backoffLevel = estimate?.backoffLevel ?? 3;
    const mean = estimate?.mean ?? null;
    const effectiveWeight =
      presetWeight * EVIDENCE_AGGREGATION_CONSTANTS.backoffLevelWeights[backoffLevel];

    let score: number | null = null;
    if (mean !== null) {
      if (dimension === "cost" || dimension === "latency") {
        const bound = bounds.get(dimension);
        score = bound ? relativeScore(mean, bound.min, bound.max) : null;
      } else {
        score = mean;
      }
    }

    drafts.push({
      dimension,
      presetWeight,
      backoffLevel,
      effectiveWeight,
      score,
      mean,
      uncertainty: estimate?.uncertainty ?? 0,
      effectiveSampleSize: estimate?.effectiveSampleSize ?? 0,
      sampleCount: estimate?.sampleCount ?? 0,
    });
  }

  const known = drafts.filter((draft) => draft.score !== null);
  const weightSum = known.reduce((sum, draft) => sum + draft.effectiveWeight, 0);
  let utility = 0;
  if (weightSum > 0) {
    const weightedScoreSum = known.reduce(
      (sum, draft) => sum + draft.effectiveWeight * (draft.score as number),
      0,
    );
    utility = weightedScoreSum / weightSum;
  }

  const contributions: RankedDimensionContribution[] = drafts.map((draft) => ({
    ...draft,
    normalizedWeight:
      draft.score !== null && weightSum > 0 ? draft.effectiveWeight / weightSum : null,
  }));

  return {
    provider: candidate.provider,
    model: candidate.model,
    variant: candidate.variant,
    utility,
    contributions,
  };
}

/**
 * Ranks eligible candidates by the preset's weighted utility, applying the
 * design's quality-dominant presets after the hard filters. Each dimension's
 * evidence is discounted by its profile-backoff level; evidence-free dimensions
 * are dropped and the remaining weights renormalized, so utility reflects only
 * what is actually known — cold-start priors (T62) fill that gap later.
 * Utility ties preserve input order, which the eligibility stage stabilized.
 */
export function rankEligibleModels(
  connection: SqliteConnection,
  input: RankEligibleModelsInput,
): ModelRankingResult {
  const { eligible, preset, now, targetProfile, halfLifeDays, maxAgeDays, loadEvidence } =
    validateInput(input);
  const weights = MODEL_RANKING_CONSTANTS.presets[preset];

  const loadSummary =
    loadEvidence ??
    ((candidate: EligibleModelCandidate) =>
      aggregateDecayedEvidence(connection, {
        provider: candidate.provider,
        model: candidate.model,
        variant: candidate.variant,
        ...(targetProfile === undefined ? {} : { targetProfile }),
        now,
        ...(halfLifeDays === undefined ? {} : { halfLifeDays }),
        ...(maxAgeDays === undefined ? {} : { maxAgeDays }),
      }));

  const candidatesWithSummaries = eligible.map((candidate) => ({
    candidate,
    summary: loadSummary(candidate),
  }));

  const bounds = new Map<OutcomeDimension, { min: number; max: number }>();
  for (const dimension of RELATIVE_DIMENSIONS) {
    const means = candidatesWithSummaries
      .map(({ summary }) => estimateForDimension(summary, dimension)?.mean)
      .filter((mean): mean is number => mean !== null && mean !== undefined);
    if (means.length > 0) {
      bounds.set(dimension, { min: Math.min(...means), max: Math.max(...means) });
    }
  }

  const ranked = candidatesWithSummaries
    .map(({ candidate, summary }) => scoreCandidate(candidate, weights, summary, bounds))
    .sort((first, second) => second.utility - first.utility);

  return { preset, ranked };
}
