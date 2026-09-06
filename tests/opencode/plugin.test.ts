import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createDefaultConfig,
  migrateSqliteSchema,
  openSqliteConnection,
  proposeLessonCandidate,
  releaseSchemaMigrations,
  resolveProjectIdentity,
  reviewLessonCandidate,
  type SecretScanResult,
  type SqliteConnection,
} from "../../src/core/index.js";
import type { ToolDefinition } from "@opencode-ai/plugin";
import type { OpenCodeCompatibility } from "../../src/types/compatibility-types.js";
import type { PluginDependencies } from "../../src/types/plugin-types.js";
import { composePluginHooks } from "../../src/opencode/plugin.js";
import type {
  ChatMessageHook,
  SystemTransformHook,
} from "../opencode/fixtures.js";

function withPlugin(
  run: (ctx: {
    hooks: ReturnType<typeof composePluginHooks>;
    connection: SqliteConnection;
    projectId: string;
    getTool: (name: string) => ToolDefinition;
  }) => void | Promise<void>,
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

function createToolContext(sessionId: string) {
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

function textOf(result: Awaited<ReturnType<ToolDefinition["execute"]>>): string {
  return typeof result === "string" ? result : result.output;
}

function chatInput(sessionId: string, text: string, messageId = "msg-1", agent = "build") {
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

// --- Initialization and structure ---

test("composePluginHooks returns hooks with expected shape", () =>
  withPlugin(({ hooks, getTool }) => {
    expect(hooks.dispose).toBeFunction();
    expect(hooks["chat.message"]).toBeFunction();
    expect(hooks["experimental.chat.system.transform"]).toBeFunction();
    expect(hooks.tool).toBeDefined();

    expect(getTool("swe_factory_propose_lesson")).toBeDefined();
    expect(getTool("swe_factory_commit_lesson")).toBeDefined();
    expect(getTool("swe_factory_get_toggles")).toBeDefined();
    expect(getTool("swe_factory_set_private_mode")).toBeDefined();
    expect(getTool("swe_factory_set_toggle")).toBeDefined();
    expect(getTool("swe_factory_clear_toggles")).toBeDefined();
  }));

test("dispose closes the database connection", () =>
  withPlugin(async ({ hooks, connection }) => {
    await hooks.dispose!();
    expect(() =>
      connection.database.query("SELECT 1").get(),
    ).toThrow();
  }));

// --- chat.message hook ---

test("chat.message processes message without error", () =>
  withPlugin(async ({ hooks }) => {
    const msg = chatInput("s1", "Add a login feature");
    const chatMessage = hooks["chat.message"] as ChatMessageHook;
    await chatMessage(msg.input, msg.output);
  }));

test("chat.message creates task record in database", () =>
  withPlugin(async ({ hooks, connection }) => {
    const msg = chatInput("s1", "Implement feature for adding users");
    const chatMessage = hooks["chat.message"] as ChatMessageHook;
    await chatMessage(msg.input, msg.output);

    const task = connection.database
      .query<{ id: string; boundary: string }, []>(
        "SELECT id, boundary FROM tasks LIMIT 1",
      )
      .get();
    expect(task).not.toBeNull();
    expect(task!.boundary).toBe("top-level");
  }));

test("chat.message is fail-open on empty parts", () =>
  withPlugin(async ({ hooks }) => {
    const chatMessage = hooks["chat.message"] as ChatMessageHook;
    await chatMessage(
      { sessionID: "s1" },
      {
        message: {
          id: "msg-1",
          sessionID: "s1",
          role: "user",
          time: { created: 0 },
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-4.1" },
        },
        parts: [],
      },
    );
  }));

// --- system.transform hook ---

test("system.transform injects lesson context when supported", () =>
  withPlugin(async ({ hooks, connection, projectId }) => {
    const clearScan: SecretScanResult = {
      disposition: "clear",
      findings: [],
      redactedText: "",
    };
    const candidate = proposeLessonCandidate(connection, {
      projectId,
      scope: "project",
      draft: {
        title: "Always use parameterized queries",
        body: "Never concatenate user input into SQL strings to prevent injection attacks",
        rationale: "Security best practice",
        applicability: {},
        provenance: {},
      },
      secretScan: clearScan,
    });
    reviewLessonCandidate(connection, {
      candidateId: candidate.id,
      decision: "approve",
    });

    const msg = chatInput("s1", "Fix the SQL query in the user module");
    const chatMessage = hooks["chat.message"] as ChatMessageHook;
    await chatMessage(msg.input, msg.output);

    const systemOutput = { system: ["existing system prompt"] };
    const systemTransform = hooks[
      "experimental.chat.system.transform"
    ] as SystemTransformHook;
    await systemTransform({ sessionID: "s1", model: {} as any }, systemOutput);

    expect(systemOutput.system[0]).toContain("parameterized queries");
  }));

test("system.transform is no-op when version unsupported", () =>
  withPlugin(
    async ({ hooks }) => {
      const systemOutput = { system: ["original prompt"] };
      const systemTransform = hooks[
        "experimental.chat.system.transform"
      ] as SystemTransformHook;
      await systemTransform(
        { sessionID: "s1", model: {} as any },
        systemOutput,
      );
      expect(systemOutput.system[0]).toBe("original prompt");
    },
    {
      compatibility: {
        status: "unsupported",
        version: "1.0.0",
        reason: "below-minimum-version",
      },
    },
  ));

// --- Tool: propose lesson ---

test("propose lesson tool returns approval card", () =>
  withPlugin(async ({ getTool }) => {
    const result = await getTool("swe_factory_propose_lesson").execute(
      {
        title: "Use strict equality",
        body: "Always use === instead of == in JavaScript",
        rationale: "Prevents type coercion bugs",
        scope: "global",
      },
      createToolContext("s1"),
    );
    expect(textOf(result)).toContain("Use strict equality");
    expect(textOf(result)).toContain("Candidate ID:");
  }));

test("propose lesson tool respects private mode", () =>
  withPlugin(async ({ getTool }) => {
    const ctx = createToolContext("s1");
    await getTool("swe_factory_set_private_mode").execute(
      { enabled: true },
      ctx,
    );

    const result = await getTool("swe_factory_propose_lesson").execute(
      {
        title: "Test lesson",
        body: "Test body",
        rationale: "Test rationale",
        scope: "global",
      },
      ctx,
    );
    expect(textOf(result)).toContain("private mode");
  }));

// --- Tool: commit lesson ---

test("commit lesson tool approves a candidate", () =>
  withPlugin(async ({ getTool }) => {
    const ctx = createToolContext("s1");
    const proposeResult = await getTool("swe_factory_propose_lesson").execute(
      {
        title: "Test lesson for approval",
        body: "Lesson body content here for testing",
        rationale: "Good practice",
        scope: "global",
      },
      ctx,
    );
    const candidateId = textOf(proposeResult).match(/Candidate ID: (.+)/)![1];

    const commitResult = await getTool("swe_factory_commit_lesson").execute(
      { candidateId, decision: "approve" },
      ctx,
    );
    expect(textOf(commitResult)).toContain("approved successfully");
  }));

test("commit lesson tool handles invalid candidate", () =>
  withPlugin(async ({ getTool }) => {
    const result = await getTool("swe_factory_commit_lesson").execute(
      { candidateId: "nonexistent", decision: "approve" },
      createToolContext("s1"),
    );
    expect(textOf(result)).toContain("failed");
  }));

// --- Tool: toggles ---

test("get toggles returns current state", () =>
  withPlugin(async ({ getTool }) => {
    const result = await getTool("swe_factory_get_toggles").execute(
      {},
      createToolContext("s1"),
    );
    const parsed = JSON.parse(textOf(result));
    expect(parsed.resolved.privateMode).toBe(false);
    expect(parsed.resolved.retrieval).toBe(true);
  }));

test("set private mode persists across tools in same session", () =>
  withPlugin(async ({ getTool }) => {
    const ctx = createToolContext("s1");
    await getTool("swe_factory_set_private_mode").execute(
      { enabled: true },
      ctx,
    );

    const result = await getTool("swe_factory_get_toggles").execute({}, ctx);
    const parsed = JSON.parse(textOf(result));
    expect(parsed.resolved.privateMode).toBe(true);
  }));

test("set toggle changes individual feature", () =>
  withPlugin(async ({ getTool }) => {
    const result = await getTool("swe_factory_set_toggle").execute(
      { feature: "retrieval", enabled: false },
      createToolContext("s1"),
    );
    expect(textOf(result)).toContain("retrieval");
    expect(textOf(result)).toContain("disabled");
  }));

test("clear toggles resets all overrides", () =>
  withPlugin(async ({ getTool }) => {
    const ctx = createToolContext("s1");
    await getTool("swe_factory_set_private_mode").execute(
      { enabled: true },
      ctx,
    );
    await getTool("swe_factory_set_toggle").execute(
      { feature: "retrieval", enabled: false },
      ctx,
    );

    const clearResult = await getTool("swe_factory_clear_toggles").execute(
      {},
      ctx,
    );
    expect(textOf(clearResult)).toContain("Cleared 2");

    const getResult = await getTool("swe_factory_get_toggles").execute(
      {},
      ctx,
    );
    const parsed = JSON.parse(textOf(getResult));
    expect(parsed.resolved.privateMode).toBe(false);
    expect(parsed.resolved.retrieval).toBe(true);
  }));

// --- Session isolation ---

test("toggle state is isolated between sessions", () =>
  withPlugin(async ({ getTool }) => {
    await getTool("swe_factory_set_private_mode").execute(
      { enabled: true },
      createToolContext("s1"),
    );

    const result = await getTool("swe_factory_get_toggles").execute(
      {},
      createToolContext("s2"),
    );
    const parsed = JSON.parse(textOf(result));
    expect(parsed.resolved.privateMode).toBe(false);
  }));

// --- Full round-trip ---

test("propose → approve → inject in later session", () =>
  withPlugin(async ({ hooks, getTool }) => {
    const ctx1 = createToolContext("s1");
    const proposeResult = await getTool("swe_factory_propose_lesson").execute(
      {
        title: "Validate all inputs",
        body: "Always validate external inputs at system boundaries to prevent injection",
        rationale: "Security hardening",
        scope: "global",
      },
      ctx1,
    );
    const candidateId = textOf(proposeResult).match(
      /Candidate ID: (.+)/,
    )![1];

    await getTool("swe_factory_commit_lesson").execute(
      { candidateId, decision: "approve" },
      ctx1,
    );

    const msg = chatInput(
      "s2",
      "Validate external inputs at the API boundary to prevent injection attacks",
      "msg-2",
    );
    const chatMessage = hooks["chat.message"] as ChatMessageHook;
    await chatMessage(msg.input, msg.output);

    const systemOutput = { system: ["base system prompt"] };
    const systemTransform = hooks[
      "experimental.chat.system.transform"
    ] as SystemTransformHook;
    await systemTransform({ sessionID: "s2", model: {} as any }, systemOutput);

    expect(systemOutput.system[0]).toContain("Validate all inputs");
  }));
