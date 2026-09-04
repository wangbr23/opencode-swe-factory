import { expect, test } from "bun:test";

import {
  type ConfigV1,
  CONFIG_SCHEMA_VERSION,
  createDefaultConfig,
  resolveConfig,
} from "../src/core/config.js";

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
