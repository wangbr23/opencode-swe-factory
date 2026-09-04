import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { ensureOwnerOnlyDirectory, ensureOwnerOnlyFile, resolveManagedPaths } from "./paths.js";

export const CONFIG_SCHEMA_VERSION = 1 as const;

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

const DEFAULT_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

const DEFAULT_ALLOWLIST: ReadonlyArray<ModelAllowlistEntry> = [];

const DEFAULT_CURATED_PATHS = [
  "AGENTS.md",
  "CLEANCODE.md",
  "TODO.md",
  "docs/journal.md",
  "docs/decisions.md",
  "docs/specs",
  "docs/designs",
];

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

/** Every field validator shares this shape so sections can be described as a field map. */
type Reader<T> = (value: unknown, label: string) => T;

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
