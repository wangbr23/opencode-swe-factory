import type { OutcomeDimension } from "./execution-profile-types.js";
import type { TaskActivity, TaskComplexity, TaskDomain } from "../core/tasks/task-taxonomy.js";

export type EvidenceBackoffLevel = 0 | 1 | 2 | 3;

/**
 * The task-profile dimensions evidence is matched against. Evidence from
 * progressively coarser compatible profiles backs off across these levels;
 * only the narrowest level that carries evidence contributes to a dimension.
 */
export type EvidenceTargetProfile = Readonly<{
  activity: TaskActivity | null;
  domain: TaskDomain | null;
  complexity: TaskComplexity;
}>;

export type AggregateDecayedEvidenceInput = Readonly<{
  provider: string;
  model: string;
  /** Exact variant identity; omitting it matches only variant-less executions. */
  variant?: string;
  targetProfile?: EvidenceTargetProfile;
  now: Date;
  halfLifeDays?: number;
  maxAgeDays?: number;
}>;

export type DecayedDimensionEstimate = Readonly<{
  dimension: OutcomeDimension;
  /** Coarsest matching level actually used; 3 when the dimension has no evidence. */
  backoffLevel: EvidenceBackoffLevel;
  mean: number | null;
  effectiveSampleSize: number;
  uncertainty: number;
  sampleCount: number;
  decayedWeight: number;
}>;

export type DecayedEvidenceSummary = Readonly<{
  provider: string;
  model: string;
  variant: string | null;
  estimates: ReadonlyArray<DecayedDimensionEstimate>;
  consideredSignalCount: number;
}>;
