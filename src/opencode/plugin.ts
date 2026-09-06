import { join } from "node:path";
import type { Hooks, Plugin, PluginModule } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";

import { loadPackageConfig, createDefaultConfig } from "../core/config.js";
import { writeLocalDiagnostic } from "../core/diagnostics.js";
import {
  migrateSqliteSchema,
  openSqliteConnection,
  releaseSchemaMigrations,
} from "../core/index.js";
import { retrieveConfirmedLessonsLexically } from "../core/lesson-retrieval.js";
import { resolveManagedPaths } from "../core/paths.js";
import { resolveProjectIdentity } from "../core/project-identity.js";
import { profileTask } from "../core/task-profile.js";
import { scanTextForSecrets } from "../core/secrets.js";
import { featureTogglesForScope, resolveFeatureToggles } from "../core/feature-toggles.js";
import type { ConfigV1 } from "../types/config-types.js";
import type { OpenCodeCompatibility } from "../types/compatibility-types.js";
import type { ResolvedFeatureToggles } from "../types/feature-toggle-types.js";
import type { OpenCodeSessionToggles } from "../types/opencode-tool-types.js";
import type { PluginDependencies } from "../types/plugin-types.js";
import { checkOpenCodeCompatibility } from "./compatibility.js";
import {
  applyInjection,
  createInjectionState,
  prepareInjection,
} from "./context-injection.js";
import {
  createExecutionCaptureState,
  handleAssistantCompletion,
} from "./execution-capture.js";
import { handleProposeLesson, handleCommitLesson } from "./lesson-tools.js";
import { formatApprovalCard } from "./approval-flow.js";
import {
  createTaskBoundaryState,
  extractMessageText,
  handleTaskBoundary,
} from "./task-boundary.js";
import {
  createSessionToggles,
  getFeatureToggles,
  setPrivateMode,
  setSessionToggle,
  clearSessionToggles,
} from "./toggle-tools.js";

export type { PluginDependencies, PluginInitFailure } from "../types/plugin-types.js";

function getOrCreateSessionToggles(
  map: Map<string, OpenCodeSessionToggles>,
  sessionId: string,
): OpenCodeSessionToggles {
  let toggles = map.get(sessionId);
  if (!toggles) {
    toggles = createSessionToggles();
    map.set(sessionId, toggles);
  }
  return toggles;
}

function resolveToggles(
  config: ConfigV1,
  session: OpenCodeSessionToggles,
): ResolvedFeatureToggles {
  return resolveFeatureToggles({
    privateMode: config.privateMode.enabled || session.privateMode,
    global: featureTogglesForScope(config, "global"),
    project: featureTogglesForScope(config, "project"),
    session: session.overrides,
  });
}

function buildTaskBoundaryInput(
  sessionId: string,
  messageId: string | undefined,
  agent: string | undefined,
  messageText: string,
  projectId: string,
): Parameters<typeof handleTaskBoundary>[3] {
  const base = { sessionId, messageText, projectId };
  if (messageId !== undefined && agent !== undefined) {
    return { ...base, messageId, agent };
  }
  if (messageId !== undefined) {
    return { ...base, messageId };
  }
  if (agent !== undefined) {
    return { ...base, agent };
  }
  return base;
}

function buildInjectionInput(
  sessionId: string,
  messageId: string | undefined,
  query: string,
  projectId: string,
): Parameters<typeof prepareInjection>[2] {
  const base = { sessionId, query, projectId };
  if (messageId !== undefined) {
    return { ...base, messageId };
  }
  return base;
}

export function composePluginHooks(deps: PluginDependencies): Hooks {
  const { connection, config, projectId, compatibility } = deps;
  const injectionEnabled = compatibility.status === "supported";

  const injectionState = createInjectionState();
  const taskBoundaryState = createTaskBoundaryState();
  const executionCaptureState = createExecutionCaptureState();
  const sessionTogglesMap = new Map<string, OpenCodeSessionToggles>();

  const hooks: Hooks = {
    async dispose() {
      connection.close();
    },

    "chat.message": async (input, output) => {
      try {
        const sessionId = input.sessionID;
        const session = getOrCreateSessionToggles(sessionTogglesMap, sessionId);
        const toggles = resolveToggles(config, session);
        const messageText = extractMessageText(
          output.parts as ReadonlyArray<{ type: string; text?: string }>,
        );

        await handleTaskBoundary(
          taskBoundaryState,
          connection,
          toggles,
          buildTaskBoundaryInput(
            sessionId,
            input.messageID,
            input.agent,
            messageText,
            projectId,
          ),
          profileTask,
        );

        if (injectionEnabled) {
          prepareInjection(
            injectionState,
            toggles,
            buildInjectionInput(sessionId, input.messageID, messageText, projectId),
            (query, pid) =>
              retrieveConfirmedLessonsLexically(connection, {
                query,
                projectId: pid,
              }),
          );
        }
      } catch {
        // fail-open: hook errors must not break OpenCode
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      if (!injectionEnabled) return;
      try {
        applyInjection(injectionState, input.sessionID, output.system);
      } catch {
        // fail-open
      }
    },

    event: async ({ event }) => {
      try {
        if (event.type !== "message.updated") return;
        const info = event.properties.info;
        if (info.role !== "assistant") return;
        if (info.time.completed === undefined) return;

        const session = getOrCreateSessionToggles(sessionTogglesMap, info.sessionID);
        const toggles = resolveToggles(config, session);

        handleAssistantCompletion(
          executionCaptureState,
          taskBoundaryState,
          connection,
          toggles,
          {
            sessionId: info.sessionID,
            messageId: info.id,
            agent: info.mode,
            provider: info.providerID,
            model: info.modelID,
            costUsd: info.cost,
            tokens: {
              input: info.tokens.input,
              output: info.tokens.output,
              reasoning: info.tokens.reasoning,
              cacheRead: info.tokens.cache.read,
              cacheWrite: info.tokens.cache.write,
            },
            startedAtMs: info.time.created,
            completedAtMs: info.time.completed,
            ...(info.finish !== undefined ? { finish: info.finish } : {}),
            ...(info.error
              ? {
                  error: {
                    name: info.error.name,
                    ...(typeof (info.error.data as { statusCode?: unknown }).statusCode ===
                    "number"
                      ? {
                          code: String(
                            (info.error.data as { statusCode: number }).statusCode,
                          ),
                        }
                      : {}),
                  },
                }
              : {}),
            softwareVersions: { opencode: compatibility.version },
          },
        );
      } catch {
        // fail-open: hook errors must not break OpenCode
      }
    },

    tool: {
      swe_factory_propose_lesson: tool({
        description:
          "Propose a new coding lesson for human approval. The lesson captures a correction, successful method, or coding insight.",
        args: {
          title: tool.schema.string().describe("Short title for the lesson"),
          body: tool.schema
            .string()
            .describe("The lesson content — what to do or avoid"),
          rationale: tool.schema
            .string()
            .describe("Why this lesson matters — the evidence or reasoning"),
          scope: tool.schema
            .enum(["global", "project"])
            .describe(
              "Whether this lesson applies globally or only to the current project",
            ),
          applicability: tool.schema
            .record(tool.schema.string(), tool.schema.string())
            .optional()
            .describe(
              "Optional applicability metadata (e.g. language, framework)",
            ),
          provenance: tool.schema
            .record(tool.schema.string(), tool.schema.string())
            .optional()
            .describe(
              "Optional provenance metadata (e.g. source, context)",
            ),
        },
        async execute(args, context) {
          const session = getOrCreateSessionToggles(
            sessionTogglesMap,
            context.sessionID,
          );
          const toggles = resolveToggles(config, session);
          if (toggles.privateMode) {
            return "Lesson proposal skipped: private mode is active.";
          }

          const result = await handleProposeLesson(
            connection,
            projectId,
            scanTextForSecrets,
            {
              title: args.title,
              body: args.body,
              rationale: args.rationale,
              scope: args.scope,
              ...(args.applicability !== undefined
                ? { applicability: args.applicability }
                : {}),
              ...(args.provenance !== undefined
                ? { provenance: args.provenance }
                : {}),
            },
          );

          return formatApprovalCard(result);
        },
      }),

      swe_factory_commit_lesson: tool({
        description:
          "Commit a pending lesson candidate — approve, reject, or defer it.",
        args: {
          candidateId: tool.schema
            .string()
            .describe("The candidate ID from the proposal"),
          decision: tool.schema
            .enum(["approve", "reject", "defer"])
            .describe("The review decision"),
          acknowledgedSecretRisk: tool.schema
            .boolean()
            .optional()
            .describe(
              "Required when the candidate has low-confidence secret findings",
            ),
        },
        async execute(args) {
          const result = handleCommitLesson(connection, {
            candidateId: args.candidateId,
            decision: args.decision,
            ...(args.acknowledgedSecretRisk !== undefined
              ? { acknowledgedSecretRisk: args.acknowledgedSecretRisk }
              : {}),
          });
          if (result.status === "committed") {
            return `Lesson ${args.decision}d successfully.`;
          }
          return `Lesson commit failed: ${result.error}`;
        },
      }),

      swe_factory_get_toggles: tool({
        description:
          "Show the current feature toggle state for this session.",
        args: {},
        async execute(_args, context) {
          const session = getOrCreateSessionToggles(
            sessionTogglesMap,
            context.sessionID,
          );
          const result = getFeatureToggles(config, session);
          return JSON.stringify(result, null, 2);
        },
      }),

      swe_factory_set_private_mode: tool({
        description:
          "Enable or disable private mode for this session. When active, all recording, retrieval, and routing are disabled.",
        args: {
          enabled: tool.schema
            .boolean()
            .describe("Whether to enable private mode"),
        },
        async execute(args, context) {
          const session = getOrCreateSessionToggles(
            sessionTogglesMap,
            context.sessionID,
          );
          const result = setPrivateMode(config, session, {
            enabled: args.enabled,
          });
          return `Private mode ${result.enabled ? "enabled" : "disabled"}.`;
        },
      }),

      swe_factory_set_toggle: tool({
        description:
          "Set a feature toggle for this session (retrieval, recording, modelTelemetry, routing).",
        args: {
          feature: tool.schema
            .enum(["retrieval", "recording", "modelTelemetry", "routing"])
            .describe("The feature to toggle"),
          enabled: tool.schema
            .boolean()
            .describe("Whether to enable the feature"),
        },
        async execute(args, context) {
          const session = getOrCreateSessionToggles(
            sessionTogglesMap,
            context.sessionID,
          );
          const result = setSessionToggle(config, session, {
            feature: args.feature,
            enabled: args.enabled,
          });
          return `${result.feature} ${result.enabled ? "enabled" : "disabled"} for this session.`;
        },
      }),

      swe_factory_clear_toggles: tool({
        description:
          "Clear all session-level toggle overrides and private mode.",
        args: {},
        async execute(_args, context) {
          const session = getOrCreateSessionToggles(
            sessionTogglesMap,
            context.sessionID,
          );
          const result = clearSessionToggles(config, session);
          return `Cleared ${result.clearedCount} override(s).`;
        },
      }),
    },
  };

  return hooks;
}

export const server: Plugin = async (input, options) => {
  try {
    let config: ConfigV1;
    try {
      config = loadPackageConfig();
    } catch {
      config = createDefaultConfig();
    }

    const paths = resolveManagedPaths();
    const dbPath = join(paths.dataDirectory, "memory.sqlite");
    const connection = openSqliteConnection(dbPath);
    migrateSqliteSchema(connection, releaseSchemaMigrations);

    const version =
      typeof options?.openCodeVersion === "string"
        ? options.openCodeVersion
        : undefined;

    const compatibility: OpenCodeCompatibility = version
      ? checkOpenCodeCompatibility(version)
      : {
          status: "unsupported" as const,
          version: "unknown",
          reason: "untested-version" as const,
        };

    const projectResult = resolveProjectIdentity(connection, {
      projectPath: input.directory,
    });

    return composePluginHooks({
      connection,
      config,
      projectId: projectResult.project.id,
      compatibility,
      diagnosticsPath: paths.dataDirectory,
    });
  } catch (error) {
    try {
      const paths = resolveManagedPaths();
      await writeLocalDiagnostic(
        {
          component: "plugin-init",
          code: "init-failure",
          severity: "error",
          summary: `Plugin initialization failed: ${error instanceof Error ? error.message : String(error)}`,
        },
        {
          filePath: join(paths.dataDirectory, "diagnostics.jsonl"),
        },
      );
    } catch {
      // cannot even write diagnostics
    }
    return {};
  }
};

export default { server } satisfies PluginModule;
