import { createCoreContext, type CoreContext } from "../core/index.js";

export * from "./compatibility.js";
export * from "./context-injection.js";
export * from "./health.js";
export * from "./toggle-tools.js";

export type OpenCodeAdapterScaffold = Readonly<{
  kind: "opencode-adapter";
  core: CoreContext;
}>;

export function createOpenCodeAdapter(
  core: CoreContext = createCoreContext(),
): OpenCodeAdapterScaffold {
  return {
    kind: "opencode-adapter",
    core,
  };
}
