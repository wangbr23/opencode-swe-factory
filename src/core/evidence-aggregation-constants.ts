import type { EvidenceBackoffLevel } from "../types/evidence-aggregation-types.js";

/**
 * Evidence older than the half-life still counts but contributes less; beyond
 * the max age it is excluded outright so stale models cannot ride on decades-old
 * outcomes. Backoff weights shrink evidence from coarser profile matches.
 */
export const EVIDENCE_AGGREGATION_CONSTANTS = Object.freeze({
  halfLifeDays: 30,
  maxAgeDays: 90,
  backoffLevelWeights: Object.freeze([1, 0.75, 0.5, 0.25]) as Readonly<
    Record<EvidenceBackoffLevel, number>
  >,
  msPerDay: 86_400_000,
});
