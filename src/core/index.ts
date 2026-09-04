export const PACKAGE_NAME = "opencode-swe-factory" as const;

export * from "./config.js";
export * from "./secrets.js";

export type CoreContext = Readonly<{
  packageName: typeof PACKAGE_NAME;
}>;

export function createCoreContext(): CoreContext {
  return {
    packageName: PACKAGE_NAME,
  };
}
