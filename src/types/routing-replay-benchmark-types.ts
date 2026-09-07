import type { ModelPriorEntry, RoutingGatesConfig, RoutingPreset } from "./config-types.js";
import type { OutcomeDimension } from "./execution-profile-types.js";
import type { EvidenceBackoffLevel, EvidenceTargetProfile } from "./evidence-aggregation-types.js";
import type {
  ModelEligibilityRejection,
  ModelHardLimits,
  ModelPrivacyPolicy,
  ModelRoutingCandidate,
} from "./model-eligibility-types.js";
import type { EvidenceGateEvaluation } from "./model-recommendation-types.js";
import type { TaskRisk } from "../core/task-taxonomy.js";

export type RoutingReplayModelIdentity = Readonly<{
  provider: string;
  model: string;
  variant: string;
}>;

export type RoutingReplayTaskProfile = EvidenceTargetProfile &
  Readonly<{
    risk: TaskRisk;
    stack: ReadonlyArray<string>;
  }>;

export type RoutingReplaySignal = Readonly<{
  dimension: OutcomeDimension;
  value: number;
  confidence: number;
}>;

export type RoutingReplayHistory = Readonly<{
  model: RoutingReplayModelIdentity;
  profile: RoutingReplayTaskProfile;
  ageDays: number;
  count: number;
  signals: ReadonlyArray<RoutingReplaySignal>;
}>;

export type RoutingReplayExpectation = Readonly<{
  recommendedModel: RoutingReplayModelIdentity | null;
  isEvidenceBacked: boolean;
  /** Documents an intentional mismatch between known preference and current routing policy. */
  knownDivergence?: string;
  rejectedModels: ReadonlyArray<RoutingReplayModelIdentity>;
  /** null means the winning recommendation has no quality score; omit to skip this assertion. */
  qualityBackoffLevel?: EvidenceBackoffLevel | null;
}>;

export type RoutingReplayCase = Readonly<{
  id: string;
  preset: RoutingPreset;
  candidates: ReadonlyArray<ModelRoutingCandidate>;
  currentModel: RoutingReplayModelIdentity | null;
  requiredCapabilities: ReadonlyArray<string>;
  privacyPolicy: ModelPrivacyPolicy;
  hardLimits: ModelHardLimits;
  targetProfile: EvidenceTargetProfile;
  priors: ReadonlyArray<ModelPriorEntry>;
  history: ReadonlyArray<RoutingReplayHistory>;
  expected: RoutingReplayExpectation;
}>;

export type RoutingReplayBenchmarkCorpus = Readonly<{
  schemaVersion: 1;
  now: string;
  evidenceDecay: Readonly<{ halfLifeDays: number; maxAgeDays: number }>;
  gates: RoutingGatesConfig;
  cases: ReadonlyArray<RoutingReplayCase>;
}>;

export type RoutingReplayBenchmarkInput = Readonly<{
  corpus: RoutingReplayBenchmarkCorpus;
  gates?: RoutingGatesConfig;
}>;

export type RoutingReplayCaseResult = Readonly<{
  id: string;
  recommendedModel: RoutingReplayModelIdentity | null;
  expectedRecommendedModel: RoutingReplayModelIdentity | null;
  knownDivergence: string | null;
  recommendationUtility: number | null;
  currentModelUtility: number | null;
  recommendationCorrect: boolean;
  isEvidenceBacked: boolean;
  expectedEvidenceBacked: boolean;
  evidenceGateCorrect: boolean;
  gates: ReadonlyArray<EvidenceGateEvaluation>;
  qualitySampleCount: number;
  /** null means the winning recommendation has no quality score. */
  qualityBackoffLevel: EvidenceBackoffLevel | null;
  qualityBackoffCorrect: boolean;
  rejectedModels: ReadonlyArray<RoutingReplayModelIdentity>;
  rejections: ReadonlyArray<ModelEligibilityRejection>;
  hardConstraintsCorrect: boolean;
  deterministic: boolean;
}>;

export type RoutingReplayBenchmarkResult = Readonly<{
  schemaVersion: 1;
  gates: RoutingGatesConfig;
  caseResults: ReadonlyArray<RoutingReplayCaseResult>;
  aggregate: Readonly<{
    recommendationAccuracy: number;
    evidenceGateAccuracy: number;
    evidenceBackedCoverage: number;
    evidenceBackedPrecision: number | null;
    hardConstraintCorrectness: number;
    profileBackoffCorrectness: number;
    deterministicOutputRate: number;
  }>;
}>;
