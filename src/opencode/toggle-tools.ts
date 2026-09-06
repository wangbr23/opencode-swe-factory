import { featureTogglesForScope, resolveFeatureToggles } from "../core/feature-toggles.js";
import type { ConfigV1 } from "../types/config-types.js";
import type { ResolvedFeatureToggles } from "../types/feature-toggle-types.js";
import type {
  ClearSessionTogglesResult,
  GetFeatureTogglesResult,
  OpenCodeSessionToggles,
  SetPrivateModeInput,
  SetPrivateModeResult,
  SetSessionToggleInput,
  SetSessionToggleResult,
} from "../types/opencode-tool-types.js";

export type {
  ClearSessionTogglesResult,
  GetFeatureTogglesResult,
  OpenCodeSessionToggles,
  SetPrivateModeInput,
  SetPrivateModeResult,
  SetSessionToggleInput,
  SetSessionToggleResult,
} from "../types/opencode-tool-types.js";

export function createSessionToggles(): OpenCodeSessionToggles {
  return { privateMode: false, overrides: {} };
}

function resolveFromSession(config: ConfigV1, session: OpenCodeSessionToggles): ResolvedFeatureToggles {
  return resolveFeatureToggles({
    privateMode: config.privateMode.enabled || session.privateMode,
    global: featureTogglesForScope(config, "global"),
    project: featureTogglesForScope(config, "project"),
    session: session.overrides,
  });
}

export function getFeatureToggles(config: ConfigV1, session: OpenCodeSessionToggles): GetFeatureTogglesResult {
  return {
    resolved: resolveFromSession(config, session),
    sessionPrivateMode: session.privateMode,
    sessionOverrides: { ...session.overrides },
  };
}

export function setPrivateMode(
  config: ConfigV1,
  session: OpenCodeSessionToggles,
  input: SetPrivateModeInput,
): SetPrivateModeResult {
  const previousValue = session.privateMode;
  session.privateMode = input.enabled;
  return {
    previousValue,
    enabled: input.enabled,
    resolved: resolveFromSession(config, session),
  };
}

export function setSessionToggle(
  config: ConfigV1,
  session: OpenCodeSessionToggles,
  input: SetSessionToggleInput,
): SetSessionToggleResult {
  const previousValue = session.overrides[input.feature] ?? null;
  session.overrides = { ...session.overrides, [input.feature]: input.enabled };
  return {
    feature: input.feature,
    previousValue,
    enabled: input.enabled,
    resolved: resolveFromSession(config, session),
  };
}

export function clearSessionToggles(
  config: ConfigV1,
  session: OpenCodeSessionToggles,
): ClearSessionTogglesResult {
  const clearedCount = Object.keys(session.overrides).length + (session.privateMode ? 1 : 0);
  session.privateMode = false;
  session.overrides = {};
  return {
    clearedCount,
    resolved: resolveFromSession(config, session),
  };
}
