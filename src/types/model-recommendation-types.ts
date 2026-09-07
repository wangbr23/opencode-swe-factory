import type { ModelPriorEntry, RoutingGatesConfig, RoutingPreset } from "./config-types.js";
import type {
  DecayedEvidenceSummary,
  EvidenceTargetProfile,
} from "./evidence-aggregation-types.js";
import type {
  EligibleModelCandidate,
  ModelEligibilityRejection,
  ModelHardLimits,
  ModelPrivacyPolicy,
  ModelRoutingCandidate,
} from "./model-eligibility-types.js";
import type { RankedDimensionContribution } from "./model-ranking-types.js";

export type RecommendModelInput = Readonly<{
  /** Host-known routing candidates; the configured allowlist stays authoritative upstream. */
  candidates: ReadonlyArray<ModelRoutingCandidate>;
  preset: RoutingPreset;
  gates: RoutingGatesConfig;
  now: Date;
  /**
   * The model OpenCode selected for this request. The utility margin is only
   * defined against a comparable current model; when it is unknown or outside
   * the eligible set, that gate passes vacuously because the hard filters
   * already bind every candidate.
   */
  currentModel?: Readonly<{ provider: string; model: string; variant: string }> | null;
  requiredCapabilities: ReadonlyArray<string>;
  privacyPolicy: ModelPrivacyPolicy;
  hardLimits: ModelHardLimits;
  priors?: ReadonlyArray<ModelPriorEntry>;
  targetProfile?: EvidenceTargetProfile;
  halfLifeDays?: number;
  maxAgeDays?: number;
  loadEvidence?: (candidate: EligibleModelCandidate) => DecayedEvidenceSummary;
}>;

export type EvidenceGateName = "min-evidence-samples" | "confidence-floor" | "utility-margin";

export type EvidenceGateEvaluation = Readonly<{
  gate: EvidenceGateName;
  required: number;
  /** null when the gate has no fair basis, e.g. no comparable current model. */
  actual: number | null;
  passed: boolean;
}>;

/**
 * The best eligible model under the preset's utility, with the evidence facts
 * its recommendation rests on. Dimensions backed by recorded evidence have
 * sampleCount > 0; prior-backed ones carry sampleCount 0.
 */
export type RecommendedModel = Readonly<{
  provider: string;
  model: string;
  variant: string;
  utility: number;
  /** Real recorded signals behind this recommendation, across all dimensions. */
  evidenceSampleCount: number;
  /** Share of the contributing utility weight resting on real evidence, in [0, 1]. */
  evidenceWeightShare: number;
  contributions: ReadonlyArray<RankedDimensionContribution>;
}>;

/**
 * Recommendation-only core output (V1 never mutates the active model): the best
 * eligible option, why it wins, the host model it is compared against, and the
 * evidence-gate verdict that later automatic routing (T23) will reuse.
 */
export type ModelRecommendationResult = Readonly<{
  preset: RoutingPreset;
  /** null when no candidate passed the hard filters. */
  recommendation: RecommendedModel | null;
  isEvidenceBacked: boolean;
  gates: ReadonlyArray<EvidenceGateEvaluation>;
  /** The host-selected model's own standing, null when it is not eligible. */
  currentModel: RecommendedModel | null;
  rejections: ReadonlyArray<ModelEligibilityRejection>;
}>;
