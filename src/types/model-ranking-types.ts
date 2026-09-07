import type { ModelPriorEntry, RoutingPreset } from "./config-types.js";
import type { OutcomeDimension } from "./execution-profile-types.js";
import type {
  DecayedEvidenceSummary,
  EvidenceBackoffLevel,
  EvidenceTargetProfile,
} from "./evidence-aggregation-types.js";
import type { EligibleModelCandidate } from "./model-eligibility-types.js";

/**
 * One preset's utility weights. Every dimension score is oriented so higher is
 * better, so a plain weighted average of the known dimensions is the utility.
 */
export type UtilityPresetWeights = Readonly<{
  quality: number;
  reliability: number;
  cost: number;
  latency: number;
}>;

export type RankEligibleModelsInput = Readonly<{
  eligible: ReadonlyArray<EligibleModelCandidate>;
  preset: RoutingPreset;
  now: Date;
  targetProfile?: EvidenceTargetProfile;
  halfLifeDays?: number;
  maxAgeDays?: number;
  /**
   * Injectable evidence loader, applied to every candidate. Defaults to decayed
   * aggregation over the live database; tests substitute their own.
   */
  loadEvidence?: (candidate: EligibleModelCandidate) => DecayedEvidenceSummary;
  /**
   * Cold-start priors from user configuration, matched by exact
   * provider/model/variant. A prior only fills a dimension that recorded
   * evidence left empty; it never overrides evidence.
   */
  priors?: ReadonlyArray<ModelPriorEntry>;
}>;

export type RankedDimensionContribution = Readonly<{
  dimension: OutcomeDimension;
  /** Preset weight before the backoff discount. */
  presetWeight: number;
  /** Coarsest matching profile level the evidence was aggregated at. */
  backoffLevel: EvidenceBackoffLevel;
  /** Preset weight after the backoff discount, before renormalization. */
  effectiveWeight: number;
  /**
   * Share of the final utility after evidence-free dimensions were dropped and
   * the remaining weights renormalized; null when the dimension has no evidence.
   */
  normalizedWeight: number | null;
  /** Dimension score oriented so higher is better; null when there is no evidence. */
  score: number | null;
  mean: number | null;
  uncertainty: number;
  effectiveSampleSize: number;
  sampleCount: number;
}>;

export type RankedModelCandidate = Readonly<{
  provider: string;
  model: string;
  variant: string;
  /**
   * Weighted average of the known dimension scores in [0, 1]. Evidence-free
   * dimensions are dropped and the remaining weights renormalized; configured
   * cold-start priors fill those gaps at the coarsest backoff weight (their
   * contributions carry sampleCount 0). A candidate with neither evidence nor
   * priors scores 0 and keeps its input order among such candidates.
   */
  utility: number;
  contributions: ReadonlyArray<RankedDimensionContribution>;
}>;

export type ModelRankingResult = Readonly<{
  preset: RoutingPreset;
  /** Utility descending; input order is preserved on exact ties. */
  ranked: ReadonlyArray<RankedModelCandidate>;
}>;
