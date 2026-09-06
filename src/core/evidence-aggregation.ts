import { TASK_TAXONOMY_VERSION } from "./task-taxonomy.js";
import { EVIDENCE_AGGREGATION_CONSTANTS } from "./evidence-aggregation-constants.js";
import type { SqliteConnection } from "./sqlite.js";
import type {
  AggregateDecayedEvidenceInput,
  DecayedDimensionEstimate,
  DecayedEvidenceSummary,
  EvidenceBackoffLevel,
  EvidenceTargetProfile,
} from "../types/evidence-aggregation-types.js";
import type { OutcomeDimension } from "../types/execution-profile-types.js";

export type {
  AggregateDecayedEvidenceInput,
  DecayedDimensionEstimate,
  DecayedEvidenceSummary,
  EvidenceBackoffLevel,
  EvidenceTargetProfile,
} from "../types/evidence-aggregation-types.js";

export class EvidenceAggregationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceAggregationError";
  }
}

const DIMENSION_ORDER: ReadonlyArray<OutcomeDimension> = [
  "quality",
  "reliability",
  "cost",
  "latency",
];

type PersistedEvidenceItem = Readonly<{
  dimension: string;
  confidence: number;
  value: number;
  observedAtMs: number;
  activity: string | null;
  domain: string | null;
  complexity: string | null;
}>;

type DecayedSample = Readonly<{
  weight: number;
  value: number;
}>;

/**
 * Backoff ladder over task-profile dimensions, from exact
 * activity/domain/complexity matches down to any current-taxonomy profile.
 */
function itemMatchesLevel(
  level: EvidenceBackoffLevel,
  target: EvidenceTargetProfile,
  item: PersistedEvidenceItem,
): boolean {
  switch (level) {
    case 0:
      return (
        item.activity === target.activity &&
        item.domain === target.domain &&
        item.complexity === target.complexity
      );
    case 1:
      return item.activity === target.activity && item.domain === target.domain;
    case 2:
      return item.domain === target.domain;
    case 3:
      return true;
  }
}

function resolveMinimumLevel(
  targetProfile: EvidenceTargetProfile | undefined,
): EvidenceBackoffLevel {
  if (!targetProfile) {
    return 3;
  }
  if (targetProfile.activity !== null && targetProfile.domain !== null) {
    return 0;
  }
  if (targetProfile.domain !== null) {
    return 2;
  }
  return 3;
}

function loadModelEvidenceItems(
  connection: SqliteConnection,
  input: AggregateDecayedEvidenceInput,
): PersistedEvidenceItem[] {
  const variant = input.variant ?? null;

  // Only execution-linked signals aggregate: a task-level signal cannot be
  // attributed to one model/variant without guessing, and the design forbids
  // false outcome attribution. Superseded signals are excluded so recomputed
  // evidence (e.g. a correction retracting an acceptance) cannot double-count.
  const rows = connection.database
    .query<
      {
        dimension: string;
        confidence: number;
        value: number;
        observed_at: string;
        activity: string | null;
        domain: string | null;
        complexity: string | null;
      },
      [string, string, string | null, string | null, number]
    >(
      `SELECT s.dimension, s.confidence, s.value, s.observed_at,
              tp.activity, tp.domain, tp.complexity
       FROM outcome_signals AS s
       JOIN execution_profiles AS e ON e.id = s.execution_id
       JOIN tasks AS t ON t.id = s.task_id
       JOIN task_profiles AS tp
         ON tp.task_id = t.id AND tp.version = t.active_profile_version
       WHERE e.provider = ?
         AND e.model = ?
         AND ((? IS NULL AND e.variant IS NULL) OR e.variant = ?)
         AND tp.taxonomy_version = ?
         AND NOT EXISTS (
           SELECT 1 FROM outcome_signals AS newer
           WHERE newer.supersedes_signal_id = s.id
         )`)
    .all(input.provider, input.model, variant, variant, TASK_TAXONOMY_VERSION);

  return rows.map((row) => ({
    dimension: row.dimension,
    confidence: row.confidence,
    value: row.value,
    observedAtMs: Date.parse(row.observed_at),
    activity: row.activity,
    domain: row.domain,
    complexity: row.complexity,
  }));
}

function decayWeight(observedAtMs: number, nowMs: number, halfLifeDays: number): number {
  const ageDays = Math.max(0, (nowMs - observedAtMs) / EVIDENCE_AGGREGATION_CONSTANTS.msPerDay);
  return 0.5 ** (ageDays / halfLifeDays);
}

function finalizeEstimate(
  dimension: OutcomeDimension,
  level: EvidenceBackoffLevel,
  samples: ReadonlyArray<DecayedSample>,
): DecayedDimensionEstimate {
  let weightSum = 0;
  let squaredWeightSum = 0;
  let weightedValueSum = 0;
  for (const sample of samples) {
    weightSum += sample.weight;
    squaredWeightSum += sample.weight ** 2;
    weightedValueSum += sample.weight * sample.value;
  }

  const mean = weightedValueSum / weightSum;
  let weightedSquaredDeviation = 0;
  for (const sample of samples) {
    weightedSquaredDeviation += sample.weight * (sample.value - mean) ** 2;
  }
  const weightedVariance = weightedSquaredDeviation / weightSum;
  const effectiveSampleSize = (weightSum * weightSum) / squaredWeightSum;

  return {
    dimension,
    backoffLevel: level,
    mean,
    effectiveSampleSize,
    uncertainty: Math.sqrt(weightedVariance / effectiveSampleSize),
    sampleCount: samples.length,
    decayedWeight: weightSum,
  };
}

function aggregateDimension(
  dimension: OutcomeDimension,
  items: ReadonlyArray<PersistedEvidenceItem>,
  target: EvidenceTargetProfile | undefined,
  minimumLevel: EvidenceBackoffLevel,
  nowMs: number,
  halfLifeDays: number,
  maxAgeDays: number,
): DecayedDimensionEstimate {
  const resolvedTarget = target ?? { activity: null, domain: null, complexity: "low" };

  for (let level = minimumLevel; level <= 3; level += 1) {
    const samples: DecayedSample[] = [];
    for (const item of items) {
      if (item.dimension !== dimension) {
        continue;
      }
      if (!itemMatchesLevel(level as EvidenceBackoffLevel, resolvedTarget, item)) {
        continue;
      }
      const ageDays = (nowMs - item.observedAtMs) / EVIDENCE_AGGREGATION_CONSTANTS.msPerDay;
      if (ageDays > maxAgeDays) {
        continue;
      }
      samples.push({
        weight: item.confidence * decayWeight(item.observedAtMs, nowMs, halfLifeDays),
        value: item.value,
      });
    }

    if (samples.length > 0) {
      return finalizeEstimate(dimension, level as EvidenceBackoffLevel, samples);
    }
  }

  return {
    dimension,
    backoffLevel: 3,
    mean: null,
    effectiveSampleSize: 0,
    uncertainty: 0,
    sampleCount: 0,
    decayedWeight: 0,
  };
}

/**
 * Aggregate exponentially decayed, execution-attributed outcome signals for one
 * exact provider/model/variant into per-dimension estimates. Evidence from the
 * narrowest matching task-profile level wins; coarser levels contribute only
 * when the narrower level has no evidence. Each estimate carries its backoff
 * level so ranking (T61) can discount coarse-profile evidence via
 * EVIDENCE_AGGREGATION_CONSTANTS.backoffLevelWeights; applying the penalty here
 * would cancel out of the weighted mean and effective sample size.
 */
export function aggregateDecayedEvidence(
  connection: SqliteConnection,
  input: AggregateDecayedEvidenceInput,
): DecayedEvidenceSummary {
  if (input.provider.length === 0 || input.model.length === 0) {
    throw new EvidenceAggregationError("provider and model must be non-empty.");
  }
  const halfLifeDays = input.halfLifeDays ?? EVIDENCE_AGGREGATION_CONSTANTS.halfLifeDays;
  const maxAgeDays = input.maxAgeDays ?? EVIDENCE_AGGREGATION_CONSTANTS.maxAgeDays;
  if (halfLifeDays <= 0) {
    throw new EvidenceAggregationError("halfLifeDays must be positive.");
  }
  if (maxAgeDays <= 0) {
    throw new EvidenceAggregationError("maxAgeDays must be positive.");
  }

  const items = loadModelEvidenceItems(connection, input);
  const minimumLevel = resolveMinimumLevel(input.targetProfile);
  const nowMs = input.now.getTime();

  let consideredSignalCount = 0;
  const estimates = DIMENSION_ORDER.map((dimension) => {
    const estimate = aggregateDimension(
      dimension,
      items,
      input.targetProfile,
      minimumLevel,
      nowMs,
      halfLifeDays,
      maxAgeDays,
    );
    consideredSignalCount += estimate.sampleCount;
    return estimate;
  });

  return {
    provider: input.provider,
    model: input.model,
    variant: input.variant ?? null,
    estimates,
    consideredSignalCount,
  };
}
