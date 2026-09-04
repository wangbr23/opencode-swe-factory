import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  type ConfigV1,
  CONFIG_SCHEMA_VERSION,
  createDefaultConfig,
  loadPackageConfig,
  PackageConfigLoadError,
  PackageConfigWriteError,
  savePackageConfig,
  resolveConfig,
} from "../src/core/config.js";

function withTempDirectory(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "opencode-swe-factory-config-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function fileMode(path: string): number | null {
  if (process.platform === "win32") {
    return null;
  }
  return statSync(path).mode & 0o777;
}

test("createDefaultConfig returns conservative, isolated defaults", () => {
  const first = createDefaultConfig();
  const second = createDefaultConfig();

  expect(first).toEqual({
    schemaVersion: CONFIG_SCHEMA_VERSION,
    routing: {
      mode: "recommendation-only",
      preset: "balanced",
      scope: {
        global: "enabled",
        project: "enabled",
        session: "enabled",
      },
      allowlist: [],
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
      curatedPaths: [
        "AGENTS.md",
        "CLEANCODE.md",
        "TODO.md",
        "docs/journal.md",
        "docs/decisions.md",
        "docs/specs",
        "docs/designs",
      ],
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
      model: "Xenova/all-MiniLM-L6-v2",
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
  });
  expect(first.routing.allowlist).not.toBe(second.routing.allowlist);
  expect(first.retrieval.curatedPaths).not.toBe(second.retrieval.curatedPaths);
});

test("resolveConfig passes a fully specified config through unchanged", () => {
  const overrides = {
    routing: {
      mode: "automatic",
      preset: "quality",
      scope: {
        global: "disabled",
        project: "enabled",
        session: "disabled",
      },
      allowlist: [
        {
          provider: "openai",
          model: "gpt-4.1",
          variant: "default",
          capabilities: ["chat", "tools"],
          privacy: "remote",
        },
      ],
      hardLimits: {
        maxCostPerTaskUsd: 1.25,
        maxLatencyMs: 3000,
      },
    },
    retrieval: {
      scope: {
        global: "disabled",
        project: "enabled",
        session: "disabled",
      },
      curatedPaths: ["docs/notes"],
    },
    recording: {
      scope: {
        global: "disabled",
        project: "enabled",
        session: "disabled",
      },
    },
    modelTelemetry: {
      scope: {
        global: "disabled",
        project: "disabled",
        session: "disabled",
      },
    },
    privateMode: {
      enabled: true,
    },
    embeddings: {
      provider: "local",
      model: "custom-local-embedder",
      allowRemoteDownloads: true,
      artifactDirectory: "/tmp/artifacts",
    },
    backups: {
      enabled: false,
      schedule: {
        intervalDays: 7,
      },
      retention: {
        maxBackups: 12,
      },
    },
    maintenance: {
      staleLessonDays: 30,
      unusedLessonDays: 90,
    },
  } satisfies Omit<ConfigV1, "schemaVersion">;

  expect(resolveConfig(overrides)).toEqual({
    schemaVersion: CONFIG_SCHEMA_VERSION,
    ...overrides,
  });
});

test("resolveConfig defaults every section and field left unspecified", () => {
  const defaults = createDefaultConfig();
  const config = resolveConfig({
    routing: { mode: "automatic" },
    backups: { schedule: { intervalDays: 7 } },
  });

  expect(config.routing.mode).toBe("automatic");
  expect(config.routing.preset).toBe(defaults.routing.preset);
  expect(config.routing.scope).toEqual(defaults.routing.scope);
  expect(config.routing.allowlist).toEqual(defaults.routing.allowlist);
  expect(config.backups.schedule.intervalDays).toBe(7);
  expect(config.backups.enabled).toBe(defaults.backups.enabled);
  expect(config.backups.retention).toEqual(defaults.backups.retention);
  expect(config.retrieval).toEqual(defaults.retrieval);
  expect(config.maintenance).toEqual(defaults.maintenance);
});

test("resolveConfig rejects malformed, unknown, and unsupported input", () => {
  expect(() => resolveConfig(null)).toThrow(/must be a plain object/);
  expect(() => resolveConfig({ schemaVersion: 2 })).toThrow(/Unsupported config schema version: 2/);
  expect(() => resolveConfig({ unexpected: true })).toThrow(/unknown key "unexpected"/);
  expect(() => resolveConfig({ routing: { preset: "speed" } })).toThrow(/routing\.preset/);
  expect(() => resolveConfig({ routing: { scope: { global: "maybe" } } })).toThrow(/routing\.scope\.global/);
  expect(() => resolveConfig({ embeddings: { provider: "remote" } })).toThrow(/embeddings\.provider/);
  expect(() => resolveConfig({ backups: { schedule: { intervalDays: 0 } } })).toThrow(/backups\.schedule\.intervalDays/);
  expect(() => resolveConfig({ maintenance: { staleLessonDays: -1 } })).toThrow(/maintenance\.staleLessonDays/);
  expect(() => resolveConfig({ routing: { allowlist: [{ provider: "x" }] } })).toThrow(/routing\.allowlist\[0\]\.capabilities/);
});

test("loadPackageConfig defaults missing files without creating them", () => {
  withTempDirectory((root) => {
    const configFilePath = join(root, "config.json");

    expect(loadPackageConfig({ configFilePath })).toEqual(createDefaultConfig());
    expect(existsSync(configFilePath)).toBe(false);
  });
});

test("loadPackageConfig tightens an existing POSIX config file before reading it", () => {
  withTempDirectory((root) => {
    const configFilePath = join(root, "config.json");
    writeFileSync(configFilePath, JSON.stringify(createDefaultConfig(), null, 2), { mode: 0o644 });

    const loaded = loadPackageConfig({ configFilePath });

    expect(loaded).toEqual(createDefaultConfig());
    expect(fileMode(configFilePath)).toBe(process.platform === "win32" ? null : 0o600);
  });
});

test("savePackageConfig persists a deterministic JSON config and round-trips it", () => {
  withTempDirectory((root) => {
    const configFilePath = join(root, "config.json");
    const input = {
      routing: {
        mode: "automatic",
      },
      backups: {
        schedule: {
          intervalDays: 7,
        },
      },
    };

    const saved = savePackageConfig(input, { configFilePath });

    expect(loadPackageConfig({ configFilePath })).toEqual(saved);
    expect(readFileSync(configFilePath, "utf8")).toBe(`${JSON.stringify(saved, null, 2)}\n`);
    expect(fileMode(configFilePath)).toBe(process.platform === "win32" ? null : 0o600);
  });
});

test("loadPackageConfig rejects malformed and unknown config with contextual errors", () => {
  withTempDirectory((root) => {
    const configFilePath = join(root, "config.json");

    writeFileSync(configFilePath, "{");
    try {
      loadPackageConfig({ configFilePath });
      throw new Error("expected loadPackageConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PackageConfigLoadError);
      expect((error as PackageConfigLoadError).phase).toBe("parse");
    }

    writeFileSync(configFilePath, JSON.stringify({ unexpected: true }, null, 2));
    try {
      loadPackageConfig({ configFilePath });
      throw new Error("expected loadPackageConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PackageConfigLoadError);
      expect((error as PackageConfigLoadError).configFilePath).toBe(configFilePath);
      expect((error as PackageConfigLoadError).phase).toBe("validate");
      expect(readFileSync(configFilePath, "utf8")).toContain("unexpected");
    }
  });
});

test("loadPackageConfig rejects config symlinks where symlinks are supported", () => {
  if (process.platform === "win32") {
    return;
  }

  withTempDirectory((root) => {
    const targetPath = join(root, "target.json");
    const configFilePath = join(root, "config.json");

    writeFileSync(targetPath, JSON.stringify(createDefaultConfig(), null, 2));
    symlinkSync(targetPath, configFilePath);

    try {
      loadPackageConfig({ configFilePath });
      throw new Error("expected loadPackageConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PackageConfigLoadError);
      expect((error as PackageConfigLoadError).phase).toBe("read");
      expect((error as PackageConfigLoadError).configFilePath).toBe(configFilePath);
    }
  });
});

test("savePackageConfig atomically replaces existing config and cleans temporary files on failure", () => {
  withTempDirectory((root) => {
    const configFilePath = join(root, "config.json");
    writeFileSync(configFilePath, JSON.stringify(createDefaultConfig(), null, 2));

    const saved = savePackageConfig({ routing: { mode: "disabled" } }, { configFilePath });
    expect(loadPackageConfig({ configFilePath })).toEqual(saved);
    expect(readFileSync(configFilePath, "utf8")).toBe(`${JSON.stringify(saved, null, 2)}\n`);

    const blockedConfigPath = join(root, "blocked-config.json");
    mkdirSync(blockedConfigPath);

    try {
      savePackageConfig(createDefaultConfig(), { configFilePath: blockedConfigPath });
      throw new Error("expected savePackageConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PackageConfigWriteError);
      expect((error as PackageConfigWriteError).configFilePath).toBe(blockedConfigPath);
      expect(readdirSync(root).sort()).toEqual(["blocked-config.json", "config.json"]);
      expect(statSync(blockedConfigPath).isDirectory()).toBe(true);
    }
  });
});
