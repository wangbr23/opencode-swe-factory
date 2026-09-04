import { PACKAGE_NAME } from "./constants.js";

export { PACKAGE_NAME };

export * from "./backup.js";
export * from "./config.js";
export * from "./diagnostics.js";
export * from "./migrations.js";
export * from "./paths.js";
export * from "./secrets.js";
export * from "./sqlite.js";

export type CoreContext = Readonly<{
  packageName: typeof PACKAGE_NAME;
}>;

export function createCoreContext(): CoreContext {
  return {
    packageName: PACKAGE_NAME,
  };
}
