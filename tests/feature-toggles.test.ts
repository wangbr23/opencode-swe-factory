import { expect, test } from "bun:test";

import { resolveConfig } from "../src/core/config.js";
import { featureTogglesForScope, resolveFeatureToggles } from "../src/core/feature-toggles.js";
import type { ResolveFeatureTogglesInput } from "../src/types/feature-toggle-types.js";

test("feature toggles fall back from session to project to global independently", () => {
  const resolved = resolveFeatureToggles({
    global: {
      retrieval: true,
      recording: false,
      modelTelemetry: true,
      routing: false,
    },
    project: {
      retrieval: false,
      recording: true,
    },
    session: {
      recording: false,
      routing: true,
    },
  });

  expect(resolved).toEqual({
    privateMode: false,
    retrieval: false,
    recording: false,
    modelTelemetry: true,
    routing: true,
  });
});

test("private mode disables every feature without reading toggle layers", () => {
  const input = {
    privateMode: true,
    get global(): never {
      throw new Error("global toggles must not be read in private mode");
    },
    get project(): never {
      throw new Error("project toggles must not be read in private mode");
    },
    get session(): never {
      throw new Error("session toggles must not be read in private mode");
    },
  } satisfies ResolveFeatureTogglesInput;

  expect(resolveFeatureToggles(input)).toEqual({
    privateMode: true,
    retrieval: false,
    recording: false,
    modelTelemetry: false,
    routing: false,
  });
});

test("config scope toggles map to core feature toggles", () => {
  const config = resolveConfig({
    routing: {
      scope: { global: "enabled", project: "disabled", session: "enabled" },
    },
    retrieval: {
      scope: { global: "disabled", project: "enabled", session: "disabled" },
    },
    recording: {
      scope: { global: "enabled", project: "disabled", session: "enabled" },
    },
    modelTelemetry: {
      scope: { global: "disabled", project: "enabled", session: "disabled" },
    },
  });

  expect(featureTogglesForScope(config, "global")).toEqual({
    retrieval: false,
    recording: true,
    modelTelemetry: false,
    routing: true,
  });
  expect(featureTogglesForScope(config, "project")).toEqual({
    retrieval: true,
    recording: false,
    modelTelemetry: true,
    routing: false,
  });
});

test("disabled routing mode overrides an enabled scope toggle", () => {
  const config = resolveConfig({ routing: { mode: "disabled" } });

  expect(featureTogglesForScope(config, "session").routing).toBe(false);
});
