/**
 * Versioned task taxonomy for deterministic profiling and later evidence
 * aggregation (decay/backoff operate on these dimensions). The version must
 * be bumped whenever values or their meaning change, so stored profiles and
 * benchmarks stay comparable.
 */

export const TASK_TAXONOMY_VERSION = 1 as const;

export const TASK_BOUNDARY_VALUES = ["top-level", "subtask"] as const;
export type TaskBoundary = (typeof TASK_BOUNDARY_VALUES)[number];

export const TASK_ACTIVITY_VALUES = [
  "implement",
  "fix",
  "refactor",
  "test",
  "review",
  "document",
  "investigate",
  "configure",
] as const;
export type TaskActivity = (typeof TASK_ACTIVITY_VALUES)[number];

export const TASK_DOMAIN_VALUES = [
  "frontend",
  "backend",
  "infrastructure",
  "tooling",
  "documentation",
  "data",
  "security",
] as const;
export type TaskDomain = (typeof TASK_DOMAIN_VALUES)[number];

export const TASK_COMPLEXITY_VALUES = ["low", "medium", "high"] as const;
export type TaskComplexity = (typeof TASK_COMPLEXITY_VALUES)[number];

export const TASK_RISK_VALUES = ["low", "medium", "high"] as const;
export type TaskRisk = (typeof TASK_RISK_VALUES)[number];

export const TASK_PROFILE_SIGNAL_VALUES = [
  "activity-lexical",
  "domain-lexical",
  "declared-stack",
  "stack-lexical",
] as const;
export type TaskProfileSignal = (typeof TASK_PROFILE_SIGNAL_VALUES)[number];