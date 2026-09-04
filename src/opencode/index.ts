import { createCoreContext, type CoreContext } from "../core/index.js";

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
