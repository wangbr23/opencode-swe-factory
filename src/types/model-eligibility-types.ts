/**
 * One routing candidate derived from a configured allowlist entry, annotated
 * with the host and evidence facts the hard filters need. The allowlist itself
 * stays authoritative: a candidate that is not on it never reaches this stage.
 */
export type ModelRoutingCandidate = Readonly<{
  provider: string;
  model: string;
  variant: string;
  capabilities: ReadonlyArray<string>;
  privacy: "local" | "remote";
  /** Whether the host reports this exact provider/model/variant as available. */
  available: boolean;
  /** Observed per-task cost in USD from decayed evidence; unknown at cold start. */
  observedCostUsd?: number;
  /** Observed per-task latency in ms from decayed evidence; unknown at cold start. */
  observedLatencyMs?: number;
}>;

export type ModelPrivacyPolicy = "local-only" | "any";

export type ModelHardLimits = Readonly<{
  maxCostPerTaskUsd: number | null;
  maxLatencyMs: number | null;
}>;

export type FilterEligibleModelsInput = Readonly<{
  candidates: ReadonlyArray<ModelRoutingCandidate>;
  /** Capabilities every candidate must declare; capability names match exactly. */
  requiredCapabilities: ReadonlyArray<string>;
  privacyPolicy: ModelPrivacyPolicy;
  hardLimits: ModelHardLimits;
}>;

export type EligibleModelCandidate = Readonly<{
  provider: string;
  model: string;
  variant: string;
  capabilities: ReadonlyArray<string>;
  privacy: "local" | "remote";
  observedCostUsd: number | null;
  observedLatencyMs: number | null;
}>;

export type ModelEligibilityRejectionReason =
  | "unavailable"
  | "missing-capabilities"
  | "privacy-policy"
  | "cost-budget"
  | "latency-budget";

export type ModelEligibilityRejection = Readonly<{
  provider: string;
  model: string;
  variant: string;
  reasons: ReadonlyArray<ModelEligibilityRejectionReason>;
}>;

export type ModelEligibilityResult = Readonly<{
  eligible: ReadonlyArray<EligibleModelCandidate>;
  rejections: ReadonlyArray<ModelEligibilityRejection>;
}>;
