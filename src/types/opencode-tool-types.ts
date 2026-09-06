import type { FeatureName, ResolvedFeatureToggles } from "./feature-toggle-types.js";

export type OpenCodeSessionToggles = {
  privateMode: boolean;
  overrides: Partial<Record<FeatureName, boolean>>;
};

export type GetFeatureTogglesResult = Readonly<{
  resolved: ResolvedFeatureToggles;
  sessionPrivateMode: boolean;
  sessionOverrides: Readonly<Partial<Record<FeatureName, boolean>>>;
}>;

export type SetPrivateModeInput = Readonly<{
  enabled: boolean;
}>;

export type SetPrivateModeResult = Readonly<{
  previousValue: boolean;
  enabled: boolean;
  resolved: ResolvedFeatureToggles;
}>;

export type SetSessionToggleInput = Readonly<{
  feature: FeatureName;
  enabled: boolean;
}>;

export type SetSessionToggleResult = Readonly<{
  feature: FeatureName;
  previousValue: boolean | null;
  enabled: boolean;
  resolved: ResolvedFeatureToggles;
}>;

export type ClearSessionTogglesResult = Readonly<{
  clearedCount: number;
  resolved: ResolvedFeatureToggles;
}>;
