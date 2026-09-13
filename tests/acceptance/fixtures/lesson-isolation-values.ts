export const LESSON_ISOLATION_PROJECT_ALPHA_PATH = "/test/lesson-isolation-alpha";

export const LESSON_ISOLATION_PROJECT_BETA_PATH = "/test/lesson-isolation-beta";

export const SUPERSEDED_LESSON = {
  v1Title: "Restart after Prisma client regeneration",
  v1Body: "Always restart the dev server after regenerating the Prisma client.",
  v2Title: "Restart and clear Prisma cache",
  v2Body: "Restart the dev server and clear the Prisma cache after a schema migration.",
  rationale: "A human corrected a stale generated Prisma client.",
} as const;

export const SEMANTIC_OVERRIDE_LESSON = {
  v1Title: "Ship schema changes untested",
  v1Body: "Skip database validation before production rollout.",
  v2Title: "Exercise the upgrade path",
  v2Body: "Exercise the upgrade path in staging prior to shipping.",
  rationale: "A rollout failed because the upgrade path was not exercised first.",
} as const;

export const GLOBAL_LESSON = {
  title: "Record migration rollback steps",
  body: "Record the migration rollback steps before each production deploy.",
  rationale: "A deploy without recorded rollback steps cannot be recovered safely.",
} as const;

export const CONFLICT_LESSONS = [
  {
    title: "Coverage flag before pushing",
    body: "Run bun test with the coverage flag before pushing changes.",
    rationale: "Pushes without coverage hide untested paths.",
  },
  {
    title: "Skip coverage flag before pushing",
    body: "Never run bun test with the coverage flag before pushing changes.",
    rationale: "Coverage runs are too slow for every push.",
  },
] as const;

/** Matches only the superseded v1 body; after supersession this must retrieve nothing. */
export const SUPERSEDED_QUERY = "regenerating client";

/** Matches both the project lesson (v2) and the global lesson to expose precedence. */
export const PRECEDENCE_QUERY = "prisma migration restart";

/** Matches both conflicting project lessons to expose conflict suppression. */
export const CONFLICT_QUERY = "bun test coverage flag";

/** Recalls the semantically detected override after the old version is superseded. */
export const SEMANTIC_OVERRIDE_QUERY = "upgrade path staging shipping";
