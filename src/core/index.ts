export const PACKAGE_NAME = "opencode-swe-factory" as const;

export type CoreContext = Readonly<{
  packageName: typeof PACKAGE_NAME;
}>;

export function createCoreContext(): CoreContext {
  return {
    packageName: PACKAGE_NAME,
  };
}
