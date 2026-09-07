import type { RoutingMode, RoutingPreset } from "./config-types.js";
import type { DecayedEvidenceSummary, EvidenceTargetProfile } from "./evidence-aggregation-types.js";
import type { OutcomeDimension } from "./execution-profile-types.js";
import type { ModelAllowlistEntry, RoutingGatesConfig } from "./config-types.js";
import type { EligibleModelCandidate, ModelEligibilityRejection, ModelHardLimits } from "./model-eligibility-types.js";
import type { EvidenceGateEvaluation } from "./model-recommendation-types.js";
import type { ModelPriorEntry } from "./config-types.js";

/**
 * Compact per-dimension "why" for the recommended model. Only dimensions that
 * actually contributed to the utility appear; `backedBy` distinguishes recorded
 * evidence from configured cold-start priors.
 */
export type RoutingReceiptDimension = Readonly<{
  dimension: OutcomeDimension;
  /** Dimension score oriented so higher is better. */
  score: number;
  /** Share of the final utility weight after renormalization. */
  weight: number;
  backedBy: "evidence" | "prior";
}>;

export type RoutingReceiptModel = Readonly<{
  provider: string;
  model: string;
  variant: string;
  utility: number;
}>;

export type RoutingReceiptRecommendation = RoutingReceiptModel &
  Readonly<{
    /** Real recorded signals behind this recommendation, across all dimensions. */
    evidenceSampleCount: number;
    /** Share of the contributing utility weight resting on real evidence, in [0, 1]. */
    evidenceWeightShare: number;
    dimensions: ReadonlyArray<RoutingReceiptDimension>;
  }>;

/**
 * Compact routing receipt emitted per incoming message: the best eligible
 * option, why it wins, the host model it is compared against, and the
 * evidence-gate verdict. Recommendation mode never mutates the message model;
 * the receipt is the disclosure surface.
 */
export type RoutingReceipt = Readonly<{
  mode: RoutingMode;
  preset: RoutingPreset;
  /** null when no allowlist candidate passed the hard filters. */
  recommendation: RoutingReceiptRecommendation | null;
  isEvidenceBacked: boolean;
  /** The host-selected model's own standing, null when it is not eligible. */
  currentModel: RoutingReceiptModel | null;
  gates: ReadonlyArray<EvidenceGateEvaluation>;
  rejections: ReadonlyArray<ModelEligibilityRejection>;
  computedAt: string;
}>;

export type RoutingReceiptSkipReason =
  | "private-mode"
  | "routing-disabled"
  | "routing-mode-disabled"
  | "empty-allowlist";

export type ComputeRoutingReceiptInput = Readonly<{
  mode: RoutingMode;
  preset: RoutingPreset;
  allowlist: ReadonlyArray<ModelAllowlistEntry>;
  hardLimits: ModelHardLimits;
  gates: RoutingGatesConfig;
  priors?: ReadonlyArray<ModelPriorEntry>;
  currentModel?: Readonly<{ provider: string; model: string; variant: string }> | null;
  targetProfile?: EvidenceTargetProfile;
  now?: Date;
  loadEvidence?: (candidate: EligibleModelCandidate) => DecayedEvidenceSummary;
}>;

export type ComputeRoutingReceiptResult =
  | Readonly<{ status: "computed"; receipt: RoutingReceipt }>
  | Readonly<{ status: "skipped"; reason: RoutingReceiptSkipReason }>
  | Readonly<{ status: "failed"; error: string }>;

/** Last routing receipt per session; the plugin owns keying and clearing. */
export type RoutingReceiptState = {
  readonly lastBySession: Map<string, RoutingReceipt>;
};
