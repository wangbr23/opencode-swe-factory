import { expect, test } from "bun:test";

import { createDefaultConfig } from "../src/core/index.js";
import type { ConfigV1 } from "../src/core/index.js";
import {
  clearSessionToggles,
  createSessionToggles,
  getFeatureToggles,
  setPrivateMode,
  setSessionToggle,
} from "../src/opencode/toggle-tools.js";

function configWithDisabledRouting(): ConfigV1 {
  const base = createDefaultConfig();
  return {
    ...base,
    routing: { ...base.routing, mode: "disabled" as const },
  };
}

function configWithPrivateMode(): ConfigV1 {
  const base = createDefaultConfig();
  return {
    ...base,
    privateMode: { enabled: true },
  };
}

function configWithProjectScopeDisabled(feature: "retrieval" | "recording" | "modelTelemetry" | "routing"): ConfigV1 {
  const base = createDefaultConfig();
  return {
    ...base,
    [feature]: {
      ...base[feature],
      scope: { ...base[feature].scope, project: "disabled" as const },
    },
  };
}

test("getFeatureToggles returns resolved defaults for a new session", () => {
  const config = createDefaultConfig();
  const session = createSessionToggles();
  const result = getFeatureToggles(config, session);

  expect(result.resolved.privateMode).toBe(false);
  expect(result.resolved.retrieval).toBe(true);
  expect(result.resolved.recording).toBe(true);
  expect(result.resolved.modelTelemetry).toBe(true);
  expect(result.resolved.routing).toBe(true);
  expect(result.sessionPrivateMode).toBe(false);
  expect(result.sessionOverrides).toEqual({});
});

test("setPrivateMode enables private mode and disables all features", () => {
  const config = createDefaultConfig();
  const session = createSessionToggles();
  const result = setPrivateMode(config, session, { enabled: true });

  expect(result.previousValue).toBe(false);
  expect(result.enabled).toBe(true);
  expect(result.resolved.privateMode).toBe(true);
  expect(result.resolved.retrieval).toBe(false);
  expect(result.resolved.recording).toBe(false);
  expect(result.resolved.modelTelemetry).toBe(false);
  expect(result.resolved.routing).toBe(false);
  expect(session.privateMode).toBe(true);
});

test("setPrivateMode disables private mode and restores config defaults", () => {
  const config = createDefaultConfig();
  const session = createSessionToggles();
  setPrivateMode(config, session, { enabled: true });
  const result = setPrivateMode(config, session, { enabled: false });

  expect(result.previousValue).toBe(true);
  expect(result.enabled).toBe(false);
  expect(result.resolved.privateMode).toBe(false);
  expect(result.resolved.retrieval).toBe(true);
  expect(result.resolved.recording).toBe(true);
});

test("config-level private mode cannot be disabled by session", () => {
  const config = configWithPrivateMode();
  const session = createSessionToggles();
  const result = setPrivateMode(config, session, { enabled: false });

  expect(result.resolved.privateMode).toBe(true);
  expect(result.resolved.retrieval).toBe(false);
  expect(result.resolved.recording).toBe(false);
});

test("setSessionToggle disables an individual feature", () => {
  const config = createDefaultConfig();
  const session = createSessionToggles();
  const result = setSessionToggle(config, session, { feature: "retrieval", enabled: false });

  expect(result.feature).toBe("retrieval");
  expect(result.previousValue).toBeNull();
  expect(result.enabled).toBe(false);
  expect(result.resolved.retrieval).toBe(false);
  expect(result.resolved.recording).toBe(true);
  expect(result.resolved.modelTelemetry).toBe(true);
});

test("setSessionToggle returns previous value when re-setting", () => {
  const config = createDefaultConfig();
  const session = createSessionToggles();
  setSessionToggle(config, session, { feature: "recording", enabled: false });
  const result = setSessionToggle(config, session, { feature: "recording", enabled: true });

  expect(result.previousValue).toBe(false);
  expect(result.enabled).toBe(true);
  expect(result.resolved.recording).toBe(true);
});

test("session toggle re-enables a project-disabled feature", () => {
  const config = configWithProjectScopeDisabled("retrieval");
  const session = createSessionToggles();

  const before = getFeatureToggles(config, session);
  expect(before.resolved.retrieval).toBe(false);

  const result = setSessionToggle(config, session, { feature: "retrieval", enabled: true });
  expect(result.resolved.retrieval).toBe(true);
});

test("private mode overrides session toggle enables", () => {
  const config = createDefaultConfig();
  const session = createSessionToggles();
  setSessionToggle(config, session, { feature: "retrieval", enabled: true });
  setPrivateMode(config, session, { enabled: true });
  const result = getFeatureToggles(config, session);

  expect(result.resolved.privateMode).toBe(true);
  expect(result.resolved.retrieval).toBe(false);
  expect(result.sessionOverrides).toEqual({ retrieval: true });
});

test("clearSessionToggles resets all overrides and private mode", () => {
  const config = createDefaultConfig();
  const session = createSessionToggles();
  setPrivateMode(config, session, { enabled: true });
  setSessionToggle(config, session, { feature: "retrieval", enabled: false });
  setSessionToggle(config, session, { feature: "recording", enabled: false });

  const result = clearSessionToggles(config, session);
  expect(result.clearedCount).toBe(3);
  expect(result.resolved.privateMode).toBe(false);
  expect(result.resolved.retrieval).toBe(true);
  expect(result.resolved.recording).toBe(true);
  expect(session.privateMode).toBe(false);
  expect(session.overrides).toEqual({});
});

test("clearSessionToggles with no overrides returns zero count", () => {
  const config = createDefaultConfig();
  const session = createSessionToggles();
  const result = clearSessionToggles(config, session);

  expect(result.clearedCount).toBe(0);
  expect(result.resolved.retrieval).toBe(true);
});

test("disabled routing mode is reflected through session toggles", () => {
  const config = configWithDisabledRouting();
  const session = createSessionToggles();
  const result = getFeatureToggles(config, session);

  expect(result.resolved.routing).toBe(false);
  expect(result.resolved.retrieval).toBe(true);
});

test("session toggle does not persist after clear even with config private mode", () => {
  const config = configWithPrivateMode();
  const session = createSessionToggles();
  setSessionToggle(config, session, { feature: "retrieval", enabled: true });
  clearSessionToggles(config, session);
  const result = getFeatureToggles(config, session);

  expect(result.resolved.privateMode).toBe(true);
  expect(result.resolved.retrieval).toBe(false);
  expect(result.sessionOverrides).toEqual({});
  expect(result.sessionPrivateMode).toBe(false);
});
