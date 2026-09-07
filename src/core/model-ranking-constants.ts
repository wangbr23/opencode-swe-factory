import type { RoutingPreset } from "../types/config-types.js";
import type { OutcomeDimension } from "../types/execution-profile-types.js";
import type { UtilityPresetWeights } from "../types/model-ranking-types.js";

/**
 * Quality-dominant by design: the balanced preset weights quality above
 * everything else combined. The quality and economy presets only move weight
 * between dimensions — none of them drops a dimension to zero, because presets
 * alter weights, not safety floors.
 */
export const MODEL_RANKING_CONSTANTS = Object.freeze({
  presets: Object.freeze({
    balanced: Object.freeze({ quality: 0.5, reliability: 0.2, cost: 0.15, latency: 0.15 }),
    quality: Object.freeze({ quality: 0.7, reliability: 0.2, cost: 0.05, latency: 0.05 }),
    economy: Object.freeze({ quality: 0.35, reliability: 0.2, cost: 0.35, latency: 0.1 }),
  }) as Readonly<Record<RoutingPreset, UtilityPresetWeights>>,
  dimensionOrder: Object.freeze([
    "quality",
    "reliability",
    "cost",
    "latency",
  ]) as ReadonlyArray<OutcomeDimension>,
});
