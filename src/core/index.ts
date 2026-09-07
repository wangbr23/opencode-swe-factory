import { PACKAGE_NAME } from "./constants.js";

export { PACKAGE_NAME };

export * from "./backup.js";
export * from "./config.js";
export * from "./diagnostics.js";
export * from "./document-admission.js";
export * from "./document-index.js";
export * from "./embedding-artifact-manifest.js";
export * from "./embedding-artifacts.js";
export * from "./execution-profiles.js";
export * from "./evidence-aggregation.js";
export * from "./export.js";
export * from "./feature-toggles.js";
export * from "./feedback-signals.js";
export * from "./hard-deletion.js";
export * from "./lesson-embedding-index.js";
export * from "./lesson-conflict-suppression.js";
export * from "./lesson-context.js";
export * from "./lesson-embedder.js";
export * from "./lesson-semantic-retrieval.js";
export * from "./markdown-chunking.js";
export * from "./model-eligibility.js";
export * from "./model-ranking.js";
export * from "./lesson-duplicate-detection.js";
export * from "./lesson-retrieval.js";
export * from "./lesson-supersession.js";
export * from "./lessons.js";
export * from "./migrations.js";
export * from "./paths.js";
export * from "./project-identity.js";
export * from "./restore.js";
export * from "./secrets.js";
export * from "./schema.js";
export * from "./sqlite.js";
export * from "./task-persistence.js";
export * from "./task-profile.js";
export * from "./task-taxonomy.js";
export * from "./tool-outcome-signals.js";

export type CoreContext = Readonly<{
  packageName: typeof PACKAGE_NAME;
}>;

export function createCoreContext(): CoreContext {
  return {
    packageName: PACKAGE_NAME,
  };
}
