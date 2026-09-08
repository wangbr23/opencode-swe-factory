import { createCoreContext, type CoreContext } from "../core/index.js";

export * from "./approval-flow.js";
export * from "./background-scheduler.js";
export * from "./compatibility.js";
export * from "./context-injection.js";
export * from "./feedback-tool.js";
export * from "./health.js";
export * from "./lesson-tools.js";
export * from "./plugin.js";
export * from "./session-end-review.js";
export * from "./task-boundary.js";
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
