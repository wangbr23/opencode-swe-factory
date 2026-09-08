import {
  TASK_TAXONOMY_VERSION,
  type TaskActivity,
  type TaskBoundary,
  type TaskComplexity,
  type TaskDomain,
  type TaskProfileSignal,
  type TaskRisk,
} from "../core/tasks/task-taxonomy.js";

export type TaskProfile = Readonly<{
  taxonomyVersion: typeof TASK_TAXONOMY_VERSION;
  boundary: TaskBoundary;
  activity: TaskActivity | null;
  domain: TaskDomain | null;
  complexity: TaskComplexity;
  risk: TaskRisk;
  stack: ReadonlyArray<string>;
  signals: ReadonlyArray<TaskProfileSignal>;
  summary: string;
}>;

export type ProfileTaskInput = Readonly<{
  taskText: string;
  boundary: TaskBoundary;
  declaredStack?: ReadonlyArray<string>;
}>;

export const MAX_SUMMARY_CHARS = 200;

/** Fixed evaluation order; ties resolve to the earliest keyword group. */
export const ACTIVITY_KEYWORDS: ReadonlyArray<readonly [TaskActivity, ReadonlyArray<string>]> = [
  ["fix", ["fix", "bug", "broken", "regression", "crash", "fails", "failing"]],
  ["test", ["test", "coverage"]],
  ["review", ["review"]],
  ["document", ["docs", "documentation", "readme", "journal"]],
  ["investigate", ["investigate", "debug", "why", "root cause", "analyze", "figure out"]],
  ["configure", ["configure", "setup", "install"]],
  ["refactor", ["refactor", "restructure", "clean up", "cleanup", "simplify"]],
  ["implement", ["add", "implement", "create", "build", "feature", "support"]],
];

export const DOMAIN_KEYWORDS: ReadonlyArray<readonly [TaskDomain, ReadonlyArray<string>]> = [
  ["security", ["auth", "secret", "token", "permission", "credential", "vulnerability"]],
  ["frontend", ["ui", "css", "component", "react", "style", "browser"]],
  ["backend", ["api", "endpoint", "server", "route", "database", "sql", "sqlite"]],
  ["infrastructure", ["docker", "ci", "cd", "deploy", "pipeline", "kubernetes"]],
  ["tooling", ["cli", "script", "command", "shell"]],
  ["documentation", ["docs", "documentation", "readme"]],
  ["data", ["migration", "schema", "dataset", "index"]],
];

export const STACK_KEYWORDS: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ["bun", ["bun"]],
  ["typescript", ["typescript", "tsconfig"]],
  ["node", ["node"]],
  ["react", ["react"]],
  ["vue", ["vue"]],
  ["python", ["python"]],
  ["rust", ["rust", "cargo"]],
  ["go", ["golang"]],
  ["sqlite", ["sqlite"]],
  ["postgres", ["postgres"]],
  ["docker", ["docker"]],
];

export const HIGH_COMPLEXITY_KEYWORDS = [
  "architecture",
  "redesign",
  "migration",
  "rewrite",
  "integrate",
  "across",
];

export const HIGH_RISK_KEYWORDS = ["delete", "drop", "purge", "production", "credential", "secret", "password"];
