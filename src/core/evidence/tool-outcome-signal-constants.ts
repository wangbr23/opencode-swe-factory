import type { ToolFailureKind, ToolOutcomeCategory } from "../../types/tool-outcome-signal-types.js";

/**
 * Runtime vocabulary of the host-classified failure kinds. The type of the
 * same name in tool-outcome-signal-types.ts is its compile-time counterpart.
 */
export const TOOL_FAILURE_KINDS: ReadonlyArray<ToolFailureKind> = Object.freeze([
  "command",
  "local-tool",
  "provider",
  "authentication",
  "cancellation",
]);

/**
 * Command-line prefixes that map a transient command to its outcome category.
 * Matching uses the trimmed, lowercased command prefix and never persists the
 * command text itself. Entries are ordered by specificity.
 */
export const TOOL_COMMAND_CATEGORY_PREFIXES: ReadonlyArray<{
  prefix: string;
  category: ToolOutcomeCategory;
}> = Object.freeze([
  { prefix: "npm run build", category: "build" },
  { prefix: "npm run test", category: "test" },
  { prefix: "npm run lint", category: "lint" },
  { prefix: "npm run typecheck", category: "typecheck" },
  { prefix: "bun test", category: "test" },
  { prefix: "bun run build", category: "build" },
  { prefix: "bun run test", category: "test" },
  { prefix: "bun run lint", category: "lint" },
  { prefix: "bun run typecheck", category: "typecheck" },
  { prefix: "yarn build", category: "build" },
  { prefix: "yarn test", category: "test" },
  { prefix: "yarn lint", category: "lint" },
  { prefix: "pnpm build", category: "build" },
  { prefix: "pnpm test", category: "test" },
  { prefix: "pnpm lint", category: "lint" },
  { prefix: "make", category: "build" },
  { prefix: "cargo build", category: "build" },
  { prefix: "cargo test", category: "test" },
  { prefix: "cargo clippy", category: "lint" },
  { prefix: "go build", category: "build" },
  { prefix: "go test", category: "test" },
  { prefix: "go vet", category: "lint" },
  { prefix: "python -m pytest", category: "test" },
  { prefix: "pytest", category: "test" },
  { prefix: "jest", category: "test" },
  { prefix: "vitest", category: "test" },
  { prefix: "eslint", category: "lint" },
  { prefix: "biome check", category: "lint" },
  { prefix: "biome lint", category: "lint" },
  { prefix: "ruff check", category: "lint" },
  { prefix: "pylint", category: "lint" },
  { prefix: "flake8", category: "lint" },
  { prefix: "mypy", category: "typecheck" },
  { prefix: "pyright", category: "typecheck" },
  { prefix: "tsc", category: "typecheck" },
]);

export const TOOL_OUTCOME_SIGNAL_CONSTANTS = Object.freeze({
  signalKind: "tool-outcome",
  signalSource: "tool-completion",
  exactConfidence: 1,
  genericCategory: "generic" as ToolOutcomeCategory,
  commandFailureKind: "command" as const,
});
