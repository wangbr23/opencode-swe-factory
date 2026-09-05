export type FeatureName = "retrieval" | "recording" | "modelTelemetry" | "routing";

export type FeatureToggles = Readonly<Record<FeatureName, boolean>>;

export type FeatureToggleOverrides = Readonly<Partial<FeatureToggles>>;

export type FeatureToggleScope = "global" | "project" | "session";

export type ResolveFeatureTogglesInput = Readonly<{
  privateMode?: boolean;
  global: FeatureToggles;
  project?: FeatureToggleOverrides;
  session?: FeatureToggleOverrides;
}>;

export type ResolvedFeatureToggles = FeatureToggles &
  Readonly<{
    privateMode: boolean;
  }>;

export const PRIVATE_MODE_TOGGLES: ResolvedFeatureToggles = Object.freeze({
  privateMode: true,
  retrieval: false,
  recording: false,
  modelTelemetry: false,
  routing: false,
});
