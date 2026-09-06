import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hooks, ToolDefinition } from "@opencode-ai/plugin";

import {
  createDefaultConfig,
  migrateSqliteSchema,
  openSqliteConnection,
  releaseSchemaMigrations,
  resolveProjectIdentity,
  type SqliteConnection,
} from "../../src/core/index.js";
import type { OpenCodeCompatibility } from "../../src/types/compatibility-types.js";
import type { PluginDependencies } from "../../src/types/plugin-types.js";
import { composePluginHooks } from "../../src/opencode/plugin.js";

export type ChatMessageHook = NonNullable<Hooks["chat.message"]>;
export type ChatMessageHookInput = Parameters<ChatMessageHook>[0];
export type ChatMessageHookOutput = Parameters<ChatMessageHook>[1];
export type SystemTransformHook = NonNullable<Hooks["experimental.chat.system.transform"]>;
export type SystemTransformHookInput = Parameters<SystemTransformHook>[0];
export type SystemTransformHookOutput = Parameters<SystemTransformHook>[1];

export function createChatMessageFixture(): Readonly<{
  input: ChatMessageHookInput;
  output: ChatMessageHookOutput;
}> {
  return {
    input: {
      sessionID: "session-1",
      messageID: "message-1",
      agent: "build",
      model: {
        providerID: "openai",
        modelID: "gpt-4.1",
      },
    },
    output: {
      message: {
        id: "message-1",
        sessionID: "session-1",
        role: "user",
        time: { created: 0 },
        agent: "build",
        model: {
          providerID: "openai",
          modelID: "gpt-4.1",
        },
      },
      parts: [],
    },
  };
}

export function createSystemTransformOutputFixture(): SystemTransformHookOutput {
  return { system: ["existing primary system block"] };
}

export function createSystemTransformInputFixture(
  sessionId: string,
): SystemTransformHookInput {
  return {
    sessionID: sessionId,
    model: createModelFixture(),
  };
}

// The system-transform hook carries the full SDK Model shape, but the adapter
// only reads the session ID. Build the minimal type-complete fixture once here.
function createModelFixture(): SystemTransformHookInput["model"] {
  return {
    id: "gpt-4.1",
    providerID: "openai",
    api: { id: "gpt-4.1", url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
    name: "GPT-4.1",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
    },
    cost: {
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    },
    limit: { context: 128000, output: 16384 },
    status: "active",
    options: {},
    headers: {},
  };
}

// --- Shared plugin harness ---

export type PluginTestContext = {
  hooks: ReturnType<typeof composePluginHooks>;
  connection: SqliteConnection;
  projectId: string;
  getTool: (name: string) => ToolDefinition;
};

export function withPlugin(
  run: (ctx: PluginTestContext) => void | Promise<void>,
  overrides?: {
    compatibility?: OpenCodeCompatibility;
  },
): Promise<void> {
  const directory = mkdtempSync(
    join(tmpdir(), "opencode-swe-factory-plugin-"),
  );
  const connection = openSqliteConnection(join(directory, "memory.sqlite"));
  migrateSqliteSchema(connection, releaseSchemaMigrations);

  const projectResult = resolveProjectIdentity(connection, {
    projectPath: "/test/project",
  });

  const deps: PluginDependencies = {
    connection,
    config: createDefaultConfig(),
    projectId: projectResult.project.id,
    compatibility: overrides?.compatibility ?? {
      status: "supported",
      version: "1.18.27",
    },
    diagnosticsPath: directory,
  };

  const hooks = composePluginHooks(deps);
  const getTool = (name: string): ToolDefinition => {
    const t = hooks.tool?.[name];
    if (!t) throw new Error(`Tool ${name} not found`);
    return t;
  };

  const result = run({
    hooks,
    connection,
    projectId: projectResult.project.id,
    getTool,
  });
  const cleanup = () => {
    try {
      connection.close();
    } catch {
      // may already be closed by dispose
    }
    rmSync(directory, { recursive: true, force: true });
  };
  if (result instanceof Promise) {
    return result.finally(cleanup);
  }
  cleanup();
  return Promise.resolve();
}

export function createToolContext(sessionId: string) {
  return {
    sessionID: sessionId,
    messageID: "msg-1",
    agent: "build",
    directory: "/test/project",
    worktree: "/test/project",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

export function textOf(result: Awaited<ReturnType<ToolDefinition["execute"]>>): string {
  return typeof result === "string" ? result : result.output;
}

export function chatInput(sessionId: string, text: string, messageId = "msg-1", agent = "build") {
  return {
    input: { sessionID: sessionId, messageID: messageId, agent },
    output: {
      message: {
        id: messageId,
        sessionID: sessionId,
        role: "user" as const,
        time: { created: 0 },
        agent,
        model: { providerID: "openai", modelID: "gpt-4.1" },
      },
      parts: [
        {
          id: "p1",
          sessionID: sessionId,
          messageID: messageId,
          type: "text" as const,
          text,
        },
      ],
    },
  };
}
