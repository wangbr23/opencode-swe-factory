import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_ALLOWLIST,
  DEFAULT_CURATED_PATHS,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_ROUTING_GATES,
  DEFAULT_ROUTING_PRIORS,
} from "../types/config-types.js";
import type {
  ConfigV1,
  ModelAllowlistEntry,
  ModelPriorEntry,
  ModelPriorEstimates,
  PackageConfigPathInput,
  Reader,
  RoutingGatesConfig,
  RoutingMode,
  RoutingPreset,
  ScopeConfig,
  ScopeToggle,
} from "../types/config-types.js";
import { MODEL_RANKING_CONSTANTS } from "./models/model-ranking-constants.js";
import { ensureOwnerOnlyDirectory, ensureOwnerOnlyFile, resolveManagedPaths } from "./paths.js";

export { CONFIG_SCHEMA_VERSION } from "../types/config-types.js";
export type {
  ConfigV1,
  ModelAllowlistEntry,
  ModelPriorEntry,
  ModelPriorEstimates,
  PackageConfigPathInput,
  RoutingGatesConfig,
  RoutingMode,
  RoutingPreset,
  ScopeConfig,
  ScopeToggle,
} from "../types/config-types.js";

export class PackageConfigLoadError extends Error {
  readonly configFilePath: string;
  readonly phase: "read" | "parse" | "validate";

  constructor(configFilePath: string, phase: "read" | "parse" | "validate", cause: unknown) {
    super(`Could not load package config at ${configFilePath} during ${phase}.`, { cause });
    this.name = "PackageConfigLoadError";
    this.configFilePath = configFilePath;
    this.phase = phase;
  }
}

export class PackageConfigWriteError extends Error {
  readonly configFilePath: string;
  readonly cleanupError: unknown | undefined;

  constructor(configFilePath: string, cause: unknown, cleanupError?: unknown) {
    super(`Could not save package config at ${configFilePath}.`, { cause });
    this.name = "PackageConfigWriteError";
    this.configFilePath = configFilePath;
    this.cleanupError = cleanupError;
  }
}

export function createDefaultConfig(): ConfigV1 {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    routing: {
      mode: "recommendation-only",
      preset: "balanced",
      scope: {
        global: "enabled",
        project: "enabled",
        session: "enabled",
      },
      allowlist: [...DEFAULT_ALLOWLIST],
      hardLimits: {
        maxCostPerTaskUsd: null,
        maxLatencyMs: null,
      },
      priors: [...DEFAULT_ROUTING_PRIORS],
      gates: { ...DEFAULT_ROUTING_GATES },
    },
    retrieval: {
      scope: {
        global: "enabled",
        project: "enabled",
        session: "enabled",
      },
      curatedPaths: [...DEFAULT_CURATED_PATHS],
    },
    recording: {
      scope: {
        global: "enabled",
        project: "enabled",
        session: "enabled",
      },
    },
    modelTelemetry: {
      scope: {
        global: "enabled",
        project: "enabled",
        session: "enabled",
      },
    },
    privateMode: {
      enabled: false,
    },
    embeddings: {
      provider: "local",
      model: DEFAULT_EMBEDDING_MODEL,
      allowRemoteDownloads: false,
      artifactDirectory: null,
    },
    backups: {
      enabled: false,
      schedule: {
        intervalDays: null,
      },
      retention: {
        maxBackups: null,
      },
    },
    maintenance: {
      staleLessonDays: null,
      unusedLessonDays: null,
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requirePlainObject(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error(`${label} must be a plain object.`);
  }
  return value;
}

function assertKnownKeys(value: Record<string, unknown>, allowed: ReadonlyArray<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(`${label} contains unknown key "${key}".`);
    }
  }
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function readNullableString(value: unknown, label: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return readString(value, label);
}

function readBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean.`);
  }
  return value;
}

function readToggle(value: unknown, label: string): ScopeToggle {
  if (value === "enabled" || value === "disabled") {
    return value;
  }
  throw new Error(`${label} must be "enabled" or "disabled".`);
}

function readRoutingMode(value: unknown, label: string): RoutingMode {
  if (value === "recommendation-only" || value === "automatic" || value === "disabled") {
    return value;
  }
  throw new Error(`${label} must be "recommendation-only", "automatic", or "disabled".`);
}

function readRoutingPreset(value: unknown, label: string): RoutingPreset {
  if (value === "balanced" || value === "quality" || value === "economy") {
    return value;
  }
  throw new Error(`${label} must be "balanced", "quality", or "economy".`);
}

function readLocalProvider(value: unknown, label: string): "local" {
  if (value !== "local") {
    throw new Error(`${label} must be "local".`);
  }
  return value;
}

function readNullablePositiveNumber(value: unknown, label: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number or null.`);
  }
  return value;
}

function readNullablePositiveInteger(value: unknown, label: string): number | null {
  const result = readNullablePositiveNumber(value, label);
  if (result !== null && !Number.isInteger(result)) {
    throw new Error(`${label} must be a positive integer or null.`);
  }
  return result;
}

function readStringArray(value: unknown, label: string): ReadonlyArray<string> {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${label} must be an array of non-empty strings.`);
  }
  // Copy so a caller-supplied array cannot mutate the resolved config afterwards.
  return [...value];
}

function readScopeConfig(value: unknown, label: string): ScopeConfig {
  const scope = requirePlainObject(value, label);
  assertKnownKeys(scope, ["global", "project", "session"], label);
  return {
    global: readToggle(scope.global, `${label}.global`),
    project: readToggle(scope.project, `${label}.project`),
    session: readToggle(scope.session, `${label}.session`),
  };
}

function readAllowlistEntry(value: unknown, label: string): ModelAllowlistEntry {
  const entry = requirePlainObject(value, label);
  assertKnownKeys(entry, ["provider", "model", "variant", "capabilities", "privacy"], label);
  const capabilities = readStringArray(entry.capabilities, `${label}.capabilities`);
  const privacy = entry.privacy;
  if (privacy !== "local" && privacy !== "remote") {
    throw new Error(`${label}.privacy must be "local" or "remote".`);
  }
  return {
    provider: readString(entry.provider, `${label}.provider`),
    model: readString(entry.model, `${label}.model`),
    variant: readString(entry.variant, `${label}.variant`),
    capabilities,
    privacy,
  };
}

function readAllowlist(value: unknown, label: string): ReadonlyArray<ModelAllowlistEntry> {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  return value.map((entry, index) => readAllowlistEntry(entry, `${label}[${index}]`));
}

function readPriorEstimate(dimension: string, value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
  if (dimension === "quality" || dimension === "reliability") {
    if (value < 0 || value > 1) {
      throw new Error(`${label} must be between 0 and 1.`);
    }
  } else if (value < 0) {
    throw new Error(`${label} must be non-negative.`);
  }
  return value;
}

function readPriorEstimates(value: unknown, label: string): ModelPriorEstimates {
  const estimates = requirePlainObject(value, label);
  const resolved: Record<string, number> = {};
  for (const key of Object.keys(estimates)) {
    if (!MODEL_RANKING_CONSTANTS.dimensionOrder.includes(key as never)) {
      throw new Error(`${label} contains unknown dimension "${key}".`);
    }
    resolved[key] = readPriorEstimate(key, estimates[key], `${label}.${key}`);
  }
  return resolved;
}

function readPriorEntry(value: unknown, label: string): ModelPriorEntry {
  const entry = requirePlainObject(value, label);
  assertKnownKeys(entry, ["provider", "model", "variant", "estimates"], label);
  return {
    provider: readString(entry.provider, `${label}.provider`),
    model: readString(entry.model, `${label}.model`),
    variant: readString(entry.variant, `${label}.variant`),
    estimates: readPriorEstimates(entry.estimates, `${label}.estimates`),
  };
}

function readPriors(value: unknown, label: string): ReadonlyArray<ModelPriorEntry> {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  return value.map((entry, index) => readPriorEntry(entry, `${label}[${index}]`));
}

function readNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
}

function readUnitInterval(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a number between 0 and 1.`);
  }
  return value;
}

function readRoutingGates(value: unknown, label: string): RoutingGatesConfig {
  return readSection(value, label, DEFAULT_ROUTING_GATES, {
    minEvidenceSamples: readNonNegativeInteger,
    confidenceFloor: readUnitInterval,
    utilityMargin: readUnitInterval,
  });
}

function resolvePackageConfigFilePath(input: PackageConfigPathInput): string {
  return readString(input.configFilePath ?? resolveManagedPaths().configFilePath, "configFilePath");
}

function ensureReadablePackageConfigFile(configFilePath: string): void {
  const existing = lstatSync(configFilePath, { throwIfNoEntry: false });
  if (existing === undefined) {
    return;
  }
  ensureOwnerOnlyFile(configFilePath);
}

function readPackageConfigFile(configFilePath: string): ConfigV1 {
  let rawContent: string;

  try {
    ensureReadablePackageConfigFile(configFilePath);
    rawContent = readFileSync(configFilePath, "utf8");
  } catch (error) {
    if (error instanceof Error && (error as Error & { code?: string }).code === "ENOENT") {
      return createDefaultConfig();
    }
    throw new PackageConfigLoadError(configFilePath, "read", error);
  }

  let content: unknown;
  try {
    content = JSON.parse(rawContent) as unknown;
  } catch (error) {
    throw new PackageConfigLoadError(configFilePath, "parse", error);
  }

  try {
    return resolveConfig(content);
  } catch (error) {
    throw new PackageConfigLoadError(configFilePath, "validate", error);
  }
}

function serializeConfig(config: ConfigV1): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function writeConfigFileAtomically(configFilePath: string, contents: string): void {
  const directoryPath = dirname(configFilePath);
  const temporaryFilePath = join(directoryPath, `${basename(configFilePath)}.${process.pid}.${randomUUID()}.tmp`);

  try {
    ensureOwnerOnlyDirectory(directoryPath);
    writeFileSync(temporaryFilePath, contents, { mode: 0o600 });
    ensureOwnerOnlyFile(temporaryFilePath);
    renameSync(temporaryFilePath, configFilePath);
  } catch (error) {
    let cleanupError: unknown | undefined;
    try {
      rmSync(temporaryFilePath, { force: true });
    } catch (cleanup) {
      cleanupError = cleanup;
    }
    throw new PackageConfigWriteError(configFilePath, error, cleanupError);
  }
}

export function loadPackageConfig(input: PackageConfigPathInput = {}): ConfigV1 {
  return readPackageConfigFile(resolvePackageConfigFilePath(input));
}

export function savePackageConfig(input: unknown, configInput: PackageConfigPathInput = {}): ConfigV1 {
  const config = resolveConfig(input);
  writeConfigFileAtomically(resolvePackageConfigFilePath(configInput), serializeConfig(config));
  return config;
}

/**
 * Resolves one config section: absent sections fall back wholesale, present ones
 * reject unknown keys and read each field, defaulting the fields left out.
 * Deriving the allowed keys from the field map keeps the two from drifting apart.
 */
function readSection<T extends object>(
  value: unknown,
  label: string,
  fallback: T,
  fields: { readonly [K in keyof T]: Reader<T[K]> },
): T {
  if (value === undefined) {
    return fallback;
  }
  const section = requirePlainObject(value, label);
  const keys = Object.keys(fields) as unknown as ReadonlyArray<keyof T & string>;
  assertKnownKeys(section, keys, label);
  // Built key-by-key from the field map, so the cast restores what the loop cannot express.
  const resolved: Record<string, unknown> = {};
  for (const key of keys) {
    const field = section[key];
    resolved[key] = field === undefined ? fallback[key] : fields[key](field, `${label}.${key}`);
  }
  return resolved as T;
}

export function resolveConfig(input: unknown): ConfigV1 {
  if (input === undefined) {
    return createDefaultConfig();
  }

  const root = requirePlainObject(input, "config");
  assertKnownKeys(root, [
    "schemaVersion",
    "routing",
    "retrieval",
    "recording",
    "modelTelemetry",
    "privateMode",
    "embeddings",
    "backups",
    "maintenance",
  ], "config");

  const schemaVersion = root.schemaVersion ?? CONFIG_SCHEMA_VERSION;
  if (schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new Error(`Unsupported config schema version: ${String(schemaVersion)}.`);
  }

  const defaults = createDefaultConfig();
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    routing: readSection(root.routing, "routing", defaults.routing, {
      mode: readRoutingMode,
      preset: readRoutingPreset,
      scope: readScopeConfig,
      allowlist: readAllowlist,
      hardLimits: (value, label) => readSection(value, label, defaults.routing.hardLimits, {
        maxCostPerTaskUsd: readNullablePositiveNumber,
        maxLatencyMs: readNullablePositiveInteger,
      }),
      priors: readPriors,
      gates: readRoutingGates,
    }),
    retrieval: readSection(root.retrieval, "retrieval", defaults.retrieval, {
      scope: readScopeConfig,
      curatedPaths: readStringArray,
    }),
    recording: readSection(root.recording, "recording", defaults.recording, {
      scope: readScopeConfig,
    }),
    modelTelemetry: readSection(root.modelTelemetry, "modelTelemetry", defaults.modelTelemetry, {
      scope: readScopeConfig,
    }),
    privateMode: readSection(root.privateMode, "privateMode", defaults.privateMode, {
      enabled: readBoolean,
    }),
    embeddings: readSection(root.embeddings, "embeddings", defaults.embeddings, {
      provider: readLocalProvider,
      model: readString,
      allowRemoteDownloads: readBoolean,
      artifactDirectory: readNullableString,
    }),
    backups: readSection(root.backups, "backups", defaults.backups, {
      enabled: readBoolean,
      schedule: (value, label) => readSection(value, label, defaults.backups.schedule, {
        intervalDays: readNullablePositiveInteger,
      }),
      retention: (value, label) => readSection(value, label, defaults.backups.retention, {
        maxBackups: readNullablePositiveInteger,
      }),
    }),
    maintenance: readSection(root.maintenance, "maintenance", defaults.maintenance, {
      staleLessonDays: readNullablePositiveInteger,
      unusedLessonDays: readNullablePositiveInteger,
    }),
  };
}
