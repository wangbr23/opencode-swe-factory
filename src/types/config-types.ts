import type { OutcomeDimension } from "./execution-profile-types.js";

export const CONFIG_SCHEMA_VERSION = 1 as const;

export const DEFAULT_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

export const DEFAULT_ALLOWLIST: ReadonlyArray<ModelAllowlistEntry> = [];

export const DEFAULT_ROUTING_PRIORS: ReadonlyArray<ModelPriorEntry> = [];

/**
 * Pre-benchmark placeholder thresholds pending the manual approval in T22.
 * They only label recommendations in V1 (recommendation mode never mutates
 * the active model), so conservative values that treat thin evidence as
 * not-yet-evidence-backed are the safe starting point.
 */
export const DEFAULT_ROUTING_GATES: RoutingGatesConfig = Object.freeze({
  minEvidenceSamples: 5,
  confidenceFloor: 0.5,
  utilityMargin: 0.05,
});

export const DEFAULT_CURATED_PATHS = [
  "AGENTS.md",
  "CLEANCODE.md",
  "TODO.md",
  "docs/journal.md",
  "docs/decisions.md",
  "docs/specs",
  "docs/designs",
];

export type RoutingMode = "recommendation-only" | "automatic" | "disabled";
export type RoutingPreset = "balanced" | "quality" | "economy";
export type ScopeToggle = "enabled" | "disabled";

export type ScopeConfig = Readonly<{
  global: ScopeToggle;
  project: ScopeToggle;
  session: ScopeToggle;
}>;

export type ModelAllowlistEntry = Readonly<{
  provider: string;
  model: string;
  variant: string;
  capabilities: ReadonlyArray<string>;
  privacy: "local" | "remote";
}>;

/**
 * Cold-start prior estimates for one exact provider/model/variant, sourced
 * only from user judgment of OpenCode model capabilities and published
 * pricing — never from recorded evidence. Any dimension may be omitted.
 * `quality`/`reliability` are 0-1 scores, `cost` is USD per task, and
 * `latency` is milliseconds per task.
 */
export type ModelPriorEstimates = Readonly<Partial<Record<OutcomeDimension, number>>>;

export type ModelPriorEntry = Readonly<{
  provider: string;
  model: string;
  variant: string;
  estimates: ModelPriorEstimates;
}>;

/**
 * Evidence gates a recommendation must clear to count as evidence-backed.
 * `minEvidenceSamples` bounds the real recorded signals behind the winner,
 * `confidenceFloor` the share of its utility weight resting on real evidence
 * rather than priors, and `utilityMargin` the utility lead required over the
 * host-selected model.
 */
export type RoutingGatesConfig = Readonly<{
  minEvidenceSamples: number;
  confidenceFloor: number;
  utilityMargin: number;
}>;

export type ConfigV1 = Readonly<{
  schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  routing: Readonly<{
    mode: RoutingMode;
    preset: RoutingPreset;
    scope: ScopeConfig;
    allowlist: ReadonlyArray<ModelAllowlistEntry>;
    hardLimits: Readonly<{
      maxCostPerTaskUsd: number | null;
      maxLatencyMs: number | null;
    }>;
    priors: ReadonlyArray<ModelPriorEntry>;
    gates: RoutingGatesConfig;
  }>;
  retrieval: Readonly<{
    scope: ScopeConfig;
    curatedPaths: ReadonlyArray<string>;
  }>;
  recording: Readonly<{
    scope: ScopeConfig;
  }>;
  modelTelemetry: Readonly<{
    scope: ScopeConfig;
  }>;
  privateMode: Readonly<{
    enabled: boolean;
  }>;
  embeddings: Readonly<{
    provider: "local";
    model: string;
    allowRemoteDownloads: boolean;
    artifactDirectory: string | null;
  }>;
  backups: Readonly<{
    enabled: boolean;
    schedule: Readonly<{
      intervalDays: number | null;
    }>;
    retention: Readonly<{
      maxBackups: number | null;
    }>;
  }>;
  maintenance: Readonly<{
    staleLessonDays: number | null;
    unusedLessonDays: number | null;
  }>;
}>;

export type PackageConfigPathInput = Readonly<{
  configFilePath?: string;
}>;

/** Every field validator shares this shape so sections can be described as a field map. */
export type Reader<T> = (value: unknown, label: string) => T;
