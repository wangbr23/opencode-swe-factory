import { PACKAGE_NAME } from "./constants.js";

export { PACKAGE_NAME };

export * from "./backup.js";
export * from "./config.js";
export * from "./diagnostics.js";
export * from "./document-admission.js";
export * from "./feature-toggles.js";
export * from "./lesson-conflict-suppression.js";
export * from "./lesson-context.js";
export * from "./markdown-chunking.js";
export * from "./lesson-duplicate-detection.js";
export * from "./lesson-retrieval.js";
export * from "./lesson-supersession.js";
export * from "./lessons.js";
export * from "./migrations.js";
export * from "./paths.js";
export * from "./project-identity.js";
export * from "./secrets.js";
export * from "./schema.js";
export * from "./sqlite.js";
export * from "./task-persistence.js";
export * from "./task-profile.js";
export * from "./task-taxonomy.js";

export type CoreContext = Readonly<{
  packageName: typeof PACKAGE_NAME;
}>;

export function createCoreContext(): CoreContext {
  return {
    packageName: PACKAGE_NAME,
  };
}
