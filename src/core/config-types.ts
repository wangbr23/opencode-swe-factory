export const CONFIG_SCHEMA_VERSION = 1 as const;

export const DEFAULT_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

export const DEFAULT_ALLOWLIST: ReadonlyArray<ModelAllowlistEntry> = [];

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
