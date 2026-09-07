import type { ModelPriorEntry, RoutingPreset } from "../types/config-types.js";
import type { OutcomeDimension } from "../types/execution-profile-types.js";
import type { EvidenceBackoffLevel, EvidenceTargetProfile } from "../types/evidence-aggregation-types.js";
import type { ModelRoutingCandidate } from "../types/model-eligibility-types.js";
import type {
  RoutingReplayBenchmarkCorpus,
  RoutingReplayCase,
  RoutingReplayHistory,
  RoutingReplayModelIdentity,
  RoutingReplaySignal,
  RoutingReplayTaskProfile,
} from "../types/routing-replay-benchmark-types.js";
import { MODEL_RANKING_CONSTANTS } from "./model-ranking-constants.js";
import { ROUTING_REPLAY_BENCHMARK_SCHEMA_VERSION } from "./routing-replay-benchmark-constants.js";
import {
  TASK_ACTIVITY_VALUES,
  TASK_COMPLEXITY_VALUES,
  TASK_DOMAIN_VALUES,
  TASK_RISK_VALUES,
} from "./task-taxonomy.js";

export type { RoutingReplayBenchmarkCorpus } from "../types/routing-replay-benchmark-types.js";

export class RoutingReplayCorpusError extends Error {
  constructor(message: string) {
    super(`Invalid routing replay corpus: ${message}`);
    this.name = "RoutingReplayCorpusError";
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RoutingReplayCorpusError(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RoutingReplayCorpusError(`${path} must be a non-empty string.`);
  }
  return value;
}

function finiteNumber(value: unknown, path: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw new RoutingReplayCorpusError(`${path} must be a finite number >= ${minimum}.`);
  }
  return value;
}

function unitInterval(value: unknown, path: string): number {
  const number = finiteNumber(value, path);
  if (number > 1) {
    throw new RoutingReplayCorpusError(`${path} must be between 0 and 1.`);
  }
  return number;
}

function positiveNumber(value: unknown, path: string): number {
  const number = finiteNumber(value, path);
  if (number === 0) {
    throw new RoutingReplayCorpusError(`${path} must be positive.`);
  }
  return number;
}

function positiveUnitInterval(value: unknown, path: string): number {
  const number = positiveNumber(value, path);
  if (number > 1) {
    throw new RoutingReplayCorpusError(`${path} must be between 0 and 1.`);
  }
  return number;
}

function stringArray(value: unknown, path: string): ReadonlyArray<string> {
  if (!Array.isArray(value)) {
    throw new RoutingReplayCorpusError(`${path} must be an array.`);
  }
  return value.map((entry, index) => text(entry, `${path}[${index}]`));
}

function identity(value: unknown, path: string): RoutingReplayModelIdentity {
  const item = record(value, path);
  return {
    provider: text(item.provider, `${path}.provider`),
    model: text(item.model, `${path}.model`),
    variant: text(item.variant, `${path}.variant`),
  };
}

function identityKey(value: RoutingReplayModelIdentity): string {
  return `${value.provider}\u0000${value.model}\u0000${value.variant}`;
}

function optionalTaxonomyValue<T extends string>(
  value: unknown,
  allowed: ReadonlyArray<T>,
  path: string,
): T | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new RoutingReplayCorpusError(`${path} is invalid.`);
  }
  return value as T;
}

function requiredTaxonomyValue<T extends string>(
  value: unknown,
  allowed: ReadonlyArray<T>,
  path: string,
): T {
  const resolved = optionalTaxonomyValue(value, allowed, path);
  if (resolved === null) {
    throw new RoutingReplayCorpusError(`${path} must not be null.`);
  }
  return resolved;
}

function targetProfile(value: unknown, path: string): EvidenceTargetProfile {
  const profile = record(value, path);
  return {
    activity: optionalTaxonomyValue(profile.activity, TASK_ACTIVITY_VALUES, `${path}.activity`),
    domain: optionalTaxonomyValue(profile.domain, TASK_DOMAIN_VALUES, `${path}.domain`),
    complexity: requiredTaxonomyValue(profile.complexity, TASK_COMPLEXITY_VALUES, `${path}.complexity`),
  };
}

function taskProfile(value: unknown, path: string): RoutingReplayTaskProfile {
  const profile = record(value, path);
  return {
    ...targetProfile(profile, path),
    risk: requiredTaxonomyValue(profile.risk, TASK_RISK_VALUES, `${path}.risk`),
    stack: stringArray(profile.stack, `${path}.stack`),
  };
}

function signal(value: unknown, path: string): RoutingReplaySignal {
  const item = record(value, path);
  if (!MODEL_RANKING_CONSTANTS.dimensionOrder.includes(item.dimension as OutcomeDimension)) {
    throw new RoutingReplayCorpusError(`${path}.dimension is invalid.`);
  }
  const dimension = item.dimension as OutcomeDimension;
  const signalValue = dimension === "quality" || dimension === "reliability"
    ? unitInterval(item.value, `${path}.value`)
    : finiteNumber(item.value, `${path}.value`);
  return {
    dimension,
    value: signalValue,
    confidence: positiveUnitInterval(item.confidence, `${path}.confidence`),
  };
}

function history(value: unknown, path: string): RoutingReplayHistory {
  const item = record(value, path);
  if (!Array.isArray(item.signals)) {
    throw new RoutingReplayCorpusError(`${path}.signals must be an array.`);
  }
  const count = finiteNumber(item.count, `${path}.count`, 1);
  if (!Number.isInteger(count)) {
    throw new RoutingReplayCorpusError(`${path}.count must be an integer.`);
  }
  return {
    model: identity(item.model, `${path}.model`),
    profile: taskProfile(item.profile, `${path}.profile`),
    ageDays: finiteNumber(item.ageDays, `${path}.ageDays`),
    count,
    signals: item.signals.map((entry, index) => signal(entry, `${path}.signals[${index}]`)),
  };
}

function candidate(value: unknown, path: string): ModelRoutingCandidate {
  const item = record(value, path);
  const privacy = item.privacy;
  if (privacy !== "local" && privacy !== "remote") {
    throw new RoutingReplayCorpusError(`${path}.privacy is invalid.`);
  }
  if (typeof item.available !== "boolean") {
    throw new RoutingReplayCorpusError(`${path}.available must be boolean.`);
  }
  return {
    ...identity(item, path),
    capabilities: stringArray(item.capabilities, `${path}.capabilities`),
    privacy,
    available: item.available,
    ...(item.observedCostUsd === undefined
      ? {}
      : { observedCostUsd: finiteNumber(item.observedCostUsd, `${path}.observedCostUsd`) }),
    ...(item.observedLatencyMs === undefined
      ? {}
      : { observedLatencyMs: finiteNumber(item.observedLatencyMs, `${path}.observedLatencyMs`) }),
  };
}

function prior(value: unknown, path: string): ModelPriorEntry {
  const item = record(value, path);
  const estimates = record(item.estimates, `${path}.estimates`);
  const parsed: Record<string, number> = {};
  for (const [dimension, rawValue] of Object.entries(estimates)) {
    if (!MODEL_RANKING_CONSTANTS.dimensionOrder.includes(dimension as OutcomeDimension)) {
      throw new RoutingReplayCorpusError(`${path}.estimates.${dimension} is invalid.`);
    }
    parsed[dimension] = dimension === "quality" || dimension === "reliability"
      ? unitInterval(rawValue, `${path}.estimates.${dimension}`)
      : finiteNumber(rawValue, `${path}.estimates.${dimension}`);
  }
  return { ...identity(item, path), estimates: parsed };
}

function optionalIdentity(value: unknown, path: string): RoutingReplayModelIdentity | null {
  return value === null ? null : identity(value, path);
}

function parseCase(value: unknown, index: number): RoutingReplayCase {
  const path = `cases[${index}]`;
  const item = record(value, path);
  const preset = item.preset;
  if (preset !== "balanced" && preset !== "quality" && preset !== "economy") {
    throw new RoutingReplayCorpusError(`${path}.preset is invalid.`);
  }
  const candidates = Array.isArray(item.candidates)
    ? item.candidates.map((entry, candidateIndex) => candidate(entry, `${path}.candidates[${candidateIndex}]`))
    : null;
  if (candidates === null || candidates.length === 0) {
    throw new RoutingReplayCorpusError(`${path}.candidates must be a non-empty array.`);
  }
  const candidateKeys = new Set(candidates.map(identityKey));
  if (candidateKeys.size !== candidates.length) {
    throw new RoutingReplayCorpusError(`${path}.candidates contains duplicate identities.`);
  }
  const hardLimits = record(item.hardLimits, `${path}.hardLimits`);
  const expectation = record(item.expected, `${path}.expected`);
  const knownDivergence = expectation.knownDivergence === undefined
    ? undefined
    : text(expectation.knownDivergence, `${path}.expected.knownDivergence`);
  const expectedRecommendedModel = optionalIdentity(
    expectation.recommendedModel,
    `${path}.expected.recommendedModel`,
  );
  const expectedRejectedModels = Array.isArray(expectation.rejectedModels)
    ? expectation.rejectedModels.map((entry, rejectedIndex) =>
        identity(entry, `${path}.expected.rejectedModels[${rejectedIndex}]`))
    : null;
  if (expectedRejectedModels === null || typeof expectation.isEvidenceBacked !== "boolean") {
    throw new RoutingReplayCorpusError(`${path}.expected is invalid.`);
  }
  const qualityBackoffLevel = expectation.qualityBackoffLevel;
  if (
    qualityBackoffLevel !== undefined &&
    qualityBackoffLevel !== null &&
    (typeof qualityBackoffLevel !== "number" ||
      !Number.isInteger(qualityBackoffLevel) ||
      qualityBackoffLevel < 0 ||
      qualityBackoffLevel > 3)
  ) {
    throw new RoutingReplayCorpusError(`${path}.expected.qualityBackoffLevel is invalid.`);
  }
  const histories = Array.isArray(item.history)
    ? item.history.map((entry, historyIndex) => history(entry, `${path}.history[${historyIndex}]`))
    : null;
  if (histories === null) {
    throw new RoutingReplayCorpusError(`${path}.history must be an array.`);
  }
  const currentModel = optionalIdentity(item.currentModel, `${path}.currentModel`);
  const priors = Array.isArray(item.priors)
    ? item.priors.map((entry, priorIndex) => prior(entry, `${path}.priors[${priorIndex}]`))
    : null;
  if (priors === null) {
    throw new RoutingReplayCorpusError(`${path}.priors must be an array.`);
  }
  for (const model of [
    currentModel,
    expectedRecommendedModel,
    ...expectedRejectedModels,
    ...histories.map((entry) => entry.model),
    ...priors,
  ]) {
    if (model !== null && !candidateKeys.has(identityKey(model))) {
      throw new RoutingReplayCorpusError(`${path} references a model outside candidates.`);
    }
  }
  if (new Set(priors.map(identityKey)).size !== priors.length) {
    throw new RoutingReplayCorpusError(`${path}.priors contains duplicate identities.`);
  }
  let privacyPolicy: "local-only" | "any";
  if (item.privacyPolicy === "local-only" || item.privacyPolicy === "any") {
    privacyPolicy = item.privacyPolicy;
  } else {
    throw new RoutingReplayCorpusError(`${path}.privacyPolicy is invalid.`);
  }
  return {
    id: text(item.id, `${path}.id`),
    preset: preset as RoutingPreset,
    candidates,
    currentModel,
    requiredCapabilities: stringArray(item.requiredCapabilities, `${path}.requiredCapabilities`),
    privacyPolicy,
    hardLimits: {
      maxCostPerTaskUsd: hardLimits.maxCostPerTaskUsd === null
        ? null
        : positiveNumber(hardLimits.maxCostPerTaskUsd, `${path}.hardLimits.maxCostPerTaskUsd`),
      maxLatencyMs: hardLimits.maxLatencyMs === null
        ? null
        : positiveNumber(hardLimits.maxLatencyMs, `${path}.hardLimits.maxLatencyMs`),
    },
    targetProfile: targetProfile(item.targetProfile, `${path}.targetProfile`),
    priors,
    history: histories,
    expected: {
      recommendedModel: expectedRecommendedModel,
      isEvidenceBacked: expectation.isEvidenceBacked,
      ...(knownDivergence === undefined ? {} : { knownDivergence }),
      rejectedModels: expectedRejectedModels,
      ...(qualityBackoffLevel === undefined
        ? {}
        : { qualityBackoffLevel: qualityBackoffLevel as EvidenceBackoffLevel | null }),
    },
  };
}

export function loadRoutingReplayBenchmarkCorpus(content: string): RoutingReplayBenchmarkCorpus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new RoutingReplayCorpusError(
      `invalid JSON (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  const root = record(parsed, "root");
  if (root.schemaVersion !== ROUTING_REPLAY_BENCHMARK_SCHEMA_VERSION) {
    throw new RoutingReplayCorpusError(
      `schemaVersion must be ${ROUTING_REPLAY_BENCHMARK_SCHEMA_VERSION}.`,
    );
  }
  const now = text(root.now, "now");
  if (Number.isNaN(Date.parse(now))) {
    throw new RoutingReplayCorpusError("now must be an ISO date-time.");
  }
  const gates = record(root.gates, "gates");
  const evidenceDecay = record(root.evidenceDecay, "evidenceDecay");
  const minEvidenceSamples = finiteNumber(gates.minEvidenceSamples, "gates.minEvidenceSamples");
  if (!Number.isInteger(minEvidenceSamples)) {
    throw new RoutingReplayCorpusError("gates.minEvidenceSamples must be an integer.");
  }
  if (!Array.isArray(root.cases) || root.cases.length === 0) {
    throw new RoutingReplayCorpusError("cases must be a non-empty array.");
  }
  const cases = root.cases.map(parseCase);
  if (new Set(cases.map((item) => item.id)).size !== cases.length) {
    throw new RoutingReplayCorpusError("case ids must be unique.");
  }
  return {
    schemaVersion: ROUTING_REPLAY_BENCHMARK_SCHEMA_VERSION,
    now,
    evidenceDecay: {
      halfLifeDays: positiveNumber(evidenceDecay.halfLifeDays, "evidenceDecay.halfLifeDays"),
      maxAgeDays: positiveNumber(evidenceDecay.maxAgeDays, "evidenceDecay.maxAgeDays"),
    },
    gates: {
      minEvidenceSamples,
      confidenceFloor: unitInterval(gates.confidenceFloor, "gates.confidenceFloor"),
      utilityMargin: unitInterval(gates.utilityMargin, "gates.utilityMargin"),
    },
    cases,
  };
}
