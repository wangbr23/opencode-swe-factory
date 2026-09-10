import { PACKAGE_NAME } from "./constants.js";

export { PACKAGE_NAME };

export * from "./backup/backup.js";
export * from "./config.js";
export * from "./diagnostics.js";
export * from "./documents/document-admission.js";
export * from "./documents/document-index.js";
export * from "./documents/embedding-artifact-manifest.js";
export * from "./documents/embedding-artifacts.js";
export * from "./evidence/execution-profiles.js";
export * from "./evidence/evidence-aggregation.js";
export * from "./evidence/evidence-inspection.js";
export * from "./backup/export.js";
export * from "./feature-toggles.js";
export * from "./evidence/feedback-signals.js";
export * from "./backup/hard-deletion.js";
export * from "./lessons/lesson-embedding-index.js";
export * from "./lessons/lesson-conflict-suppression.js";
export * from "./lessons/lesson-context.js";
export * from "./lessons/lesson-embedder.js";
export * from "./lessons/lesson-hybrid-retrieval.js";
export * from "./lessons/lesson-semantic-retrieval.js";
export * from "./documents/markdown-chunking.js";
export * from "./models/model-eligibility.js";
export * from "./models/model-ranking.js";
export * from "./models/model-recommendation.js";
export * from "./lessons/lesson-duplicate-detection.js";
export * from "./lessons/lesson-maintenance-digest.js";
export * from "./lessons/lesson-proposal-triggers.js";
export * from "./lessons/lesson-retrieval.js";
export * from "./lessons/lesson-supersession.js";
export * from "./lessons/lesson-usage-tracking.js";
export * from "./lessons/lessons.js";
export * from "./lessons/session-end-review.js";
export * from "./db/migrations.js";
export * from "./paths.js";
export * from "./project-identity.js";
export * from "./backup/restore.js";
export * from "./routing-replay/routing-replay-benchmark.js";
export * from "./routing-replay/routing-replay-corpus.js";
export * from "./secrets.js";
export * from "./db/schema.js";
export * from "./db/sqlite.js";
export * from "./tasks/task-persistence.js";
export * from "./tasks/task-profile.js";
export * from "./tasks/task-taxonomy.js";
export * from "./evidence/outcome-reclassification.js";
export * from "./evidence/tool-outcome-signals.js";

export type CoreContext = Readonly<{
  packageName: typeof PACKAGE_NAME;
}>;

export function createCoreContext(): CoreContext {
  return {
    packageName: PACKAGE_NAME,
  };
}
