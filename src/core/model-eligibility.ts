import type {
  EligibleModelCandidate,
  FilterEligibleModelsInput,
  ModelEligibilityRejection,
  ModelEligibilityRejectionReason,
  ModelEligibilityResult,
  ModelHardLimits,
  ModelPrivacyPolicy,
  ModelRoutingCandidate,
} from "../types/model-eligibility-types.js";

export type {
  EligibleModelCandidate,
  FilterEligibleModelsInput,
  ModelEligibilityRejection,
  ModelEligibilityRejectionReason,
  ModelEligibilityResult,
  ModelHardLimits,
  ModelPrivacyPolicy,
  ModelRoutingCandidate,
} from "../types/model-eligibility-types.js";

export class ModelEligibilityInputError extends Error {}

/**
 * Hard-filter order matches the design's routing policy: availability,
 * capabilities, privacy, then per-task cost and latency limits. Each filter
 * is independent, so a rejected candidate reports every reason it failed.
 */
const REJECTION_REASON_ORDER: ReadonlyArray<ModelEligibilityRejectionReason> = [
  "unavailable",
  "missing-capabilities",
  "privacy-policy",
  "cost-budget",
  "latency-budget",
];

const CANDIDATE_KEYS = [
  "provider",
  "model",
  "variant",
  "capabilities",
  "privacy",
  "available",
  "observedCostUsd",
  "observedLatencyMs",
] as const;

const INPUT_KEYS = ["candidates", "requiredCapabilities", "privacyPolicy", "hardLimits"] as const;

const HARD_LIMIT_KEYS = ["maxCostPerTaskUsd", "maxLatencyMs"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requirePlainObject(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new ModelEligibilityInputError(`${label} must be a plain object.`);
  }
  return value;
}

function assertKnownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new ModelEligibilityInputError(`${label} contains unknown key "${key}".`);
    }
  }
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ModelEligibilityInputError(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireCapabilityList(value: unknown, label: string): ReadonlyArray<string> {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new ModelEligibilityInputError(`${label} must be an array of non-empty strings.`);
  }
  return [...value];
}

function requirePrivacy(value: unknown, label: string): "local" | "remote" {
  if (value !== "local" && value !== "remote") {
    throw new ModelEligibilityInputError(`${label} must be "local" or "remote".`);
  }
  return value;
}

function requireOptionalNonNegativeNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ModelEligibilityInputError(`${label} must be a non-negative finite number or undefined.`);
  }
  return value;
}

function requireCandidate(value: unknown, index: number): ModelRoutingCandidate {
  const label = `candidates[${index}]`;
  const candidate = requirePlainObject(value, label);
  assertKnownKeys(candidate, CANDIDATE_KEYS, label);
  const observedCostUsd = requireOptionalNonNegativeNumber(
    candidate.observedCostUsd,
    `${label}.observedCostUsd`,
  );
  const observedLatencyMs = requireOptionalNonNegativeNumber(
    candidate.observedLatencyMs,
    `${label}.observedLatencyMs`,
  );
  return {
    provider: requireNonEmptyString(candidate.provider, `${label}.provider`),
    model: requireNonEmptyString(candidate.model, `${label}.model`),
    variant: requireNonEmptyString(candidate.variant, `${label}.variant`),
    capabilities: requireCapabilityList(candidate.capabilities, `${label}.capabilities`),
    privacy: requirePrivacy(candidate.privacy, `${label}.privacy`),
    available: requireAvailable(candidate.available, `${label}.available`),
    ...(observedCostUsd === undefined ? {} : { observedCostUsd }),
    ...(observedLatencyMs === undefined ? {} : { observedLatencyMs }),
  };
}

function requireHardLimit(value: unknown, label: string): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ModelEligibilityInputError(`${label} must be a positive number or null.`);
  }
  return value;
}

function requireAvailable(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new ModelEligibilityInputError(`${label} must be a boolean.`);
  }
  return value;
}

function validateInput(input: FilterEligibleModelsInput): {
  candidates: ReadonlyArray<ModelRoutingCandidate>;
  requiredCapabilities: ReadonlyArray<string>;
  privacyPolicy: ModelPrivacyPolicy;
  hardLimits: ModelHardLimits;
} {
  const raw = requirePlainObject(input, "input");
  assertKnownKeys(raw, INPUT_KEYS, "input");
  if (!Array.isArray(raw.candidates)) {
    throw new ModelEligibilityInputError("candidates must be an array.");
  }
  const privacyPolicy = raw.privacyPolicy;
  if (privacyPolicy !== "local-only" && privacyPolicy !== "any") {
    throw new ModelEligibilityInputError(`privacyPolicy must be "local-only" or "any".`);
  }
  const limits = requirePlainObject(raw.hardLimits, "hardLimits");
  assertKnownKeys(limits, HARD_LIMIT_KEYS, "hardLimits");
  return {
    candidates: (raw.candidates as unknown[]).map(requireCandidate),
    requiredCapabilities: requireCapabilityList(raw.requiredCapabilities, "requiredCapabilities"),
    privacyPolicy,
    hardLimits: {
      maxCostPerTaskUsd: requireHardLimit(limits.maxCostPerTaskUsd, "hardLimits.maxCostPerTaskUsd"),
      maxLatencyMs: requireHardLimit(limits.maxLatencyMs, "hardLimits.maxLatencyMs"),
    },
  };
}

function collectRejectionReasons(
  candidate: ModelRoutingCandidate,
  requiredCapabilities: ReadonlyArray<string>,
  privacyPolicy: ModelPrivacyPolicy,
  hardLimits: ModelHardLimits,
): ModelEligibilityRejectionReason[] {
  const reasons: ModelEligibilityRejectionReason[] = [];

  if (!candidate.available) {
    reasons.push("unavailable");
  }

  const declared = new Set(candidate.capabilities);
  if (requiredCapabilities.some((capability) => !declared.has(capability))) {
    reasons.push("missing-capabilities");
  }

  if (privacyPolicy === "local-only" && candidate.privacy !== "local") {
    reasons.push("privacy-policy");
  }

  if (
    hardLimits.maxCostPerTaskUsd !== null &&
    candidate.observedCostUsd !== undefined &&
    candidate.observedCostUsd > hardLimits.maxCostPerTaskUsd
  ) {
    reasons.push("cost-budget");
  }

  if (
    hardLimits.maxLatencyMs !== null &&
    candidate.observedLatencyMs !== undefined &&
    candidate.observedLatencyMs > hardLimits.maxLatencyMs
  ) {
    reasons.push("latency-budget");
  }

  return reasons;
}

/**
 * Applies the design's hard routing constraints to the configured allowlist:
 * host availability, required capabilities, privacy policy, and per-task
 * cost/latency limits. A constraint is only enforced against known values —
 * a candidate with no observed cost/latency evidence yet cannot be proven to
 * exceed a limit, so it stays eligible instead of making cold start impossible.
 * Input order is preserved; ranking among survivors is a later stage's job.
 */
export function filterEligibleModels(input: FilterEligibleModelsInput): ModelEligibilityResult {
  const { candidates, requiredCapabilities, privacyPolicy, hardLimits } = validateInput(input);

  const eligible: EligibleModelCandidate[] = [];
  const rejections: ModelEligibilityRejection[] = [];

  for (const candidate of candidates) {
    const reasons = collectRejectionReasons(
      candidate,
      requiredCapabilities,
      privacyPolicy,
      hardLimits,
    );
    const orderedReasons = REJECTION_REASON_ORDER.filter((reason) => reasons.includes(reason));

    if (orderedReasons.length > 0) {
      rejections.push({
        provider: candidate.provider,
        model: candidate.model,
        variant: candidate.variant,
        reasons: orderedReasons,
      });
      continue;
    }

    eligible.push({
      provider: candidate.provider,
      model: candidate.model,
      variant: candidate.variant,
      capabilities: [...candidate.capabilities],
      privacy: candidate.privacy,
      observedCostUsd: candidate.observedCostUsd ?? null,
      observedLatencyMs: candidate.observedLatencyMs ?? null,
    });
  }

  return { eligible, rejections };
}
