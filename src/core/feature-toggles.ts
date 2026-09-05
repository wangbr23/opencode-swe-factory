import { PRIVATE_MODE_TOGGLES } from "../types/feature-toggle-types.js";
import type { ConfigV1 } from "../types/config-types.js";
import type {
  FeatureToggleScope,
  FeatureToggles,
  ResolveFeatureTogglesInput,
  ResolvedFeatureToggles,
} from "../types/feature-toggle-types.js";

export type {
  FeatureName,
  FeatureToggleOverrides,
  FeatureToggleScope,
  FeatureToggles,
  ResolveFeatureTogglesInput,
  ResolvedFeatureToggles,
} from "../types/feature-toggle-types.js";

export function resolveFeatureToggles(input: ResolveFeatureTogglesInput): ResolvedFeatureToggles {
  if (input.privateMode === true) {
    return PRIVATE_MODE_TOGGLES;
  }

  const { global, project, session } = input;
  return {
    privateMode: false,
    retrieval: session?.retrieval ?? project?.retrieval ?? global.retrieval,
    recording: session?.recording ?? project?.recording ?? global.recording,
    modelTelemetry: session?.modelTelemetry ?? project?.modelTelemetry ?? global.modelTelemetry,
    routing: session?.routing ?? project?.routing ?? global.routing,
  };
}

export function featureTogglesForScope(config: ConfigV1, scope: FeatureToggleScope): FeatureToggles {
  return {
    retrieval: config.retrieval.scope[scope] === "enabled",
    recording: config.recording.scope[scope] === "enabled",
    modelTelemetry: config.modelTelemetry.scope[scope] === "enabled",
    routing: config.routing.mode !== "disabled" && config.routing.scope[scope] === "enabled",
  };
}
