import { expect, test } from "bun:test";

import { chatInput, withPlugin } from "./fixtures.js";

test("plugin tool.execute.after hook records tool outcome signals for the active task", async () =>
  withPlugin(async ({ hooks, connection }) => {
    const msg = chatInput("session-1", "Fix the login bug");
    await hooks["chat.message"]?.(msg.input, msg.output);

    await hooks["tool.execute.after"]?.(
      { tool: "bash", sessionID: "session-1", callID: "call-1", args: { command: "bun test" } },
      { title: "bun test", output: "3 pass, 0 fail", metadata: { exit: 0 } },
    );

    const signals = connection.database
      .query<Record<string, unknown>, []>(
        "SELECT * FROM outcome_signals WHERE kind = 'tool-outcome'",
      )
      .all();
    expect(signals).toHaveLength(1);
    expect(signals[0]?.dimension).toBe("reliability");
    expect(signals[0]?.value).toBe(1);
    const metadata = JSON.parse(String(signals[0]?.metadata_json));
    expect(metadata.category).toBe("test");
    expect(String(signals[0]?.metadata_json)).not.toContain("3 pass");
  }));

test("plugin tool.execute.after hook deduplicates and skips indeterminate completions", async () =>
  withPlugin(async ({ hooks, connection }) => {
    const msg = chatInput("session-1", "Fix the login bug");
    await hooks["chat.message"]?.(msg.input, msg.output);

    await hooks["tool.execute.after"]?.(
      { tool: "read", sessionID: "session-1", callID: "call-1", args: {} },
      { title: "read", output: "file contents", metadata: {} },
    );
    await hooks["tool.execute.after"]?.(
      {
        tool: "bash",
        sessionID: "session-1",
        callID: "call-2",
        args: { command: "bun run lint" },
      },
      { title: "bun run lint", output: "clean", metadata: { exit: 1 } },
    );
    await hooks["tool.execute.after"]?.(
      {
        tool: "bash",
        sessionID: "session-1",
        callID: "call-2",
        args: { command: "bun run lint" },
      },
      { title: "bun run lint", output: "clean", metadata: { exit: 1 } },
    );

    const signals = connection.database
      .query<Record<string, unknown>, []>(
        "SELECT * FROM outcome_signals WHERE kind = 'tool-outcome'",
      )
      .all();
    expect(signals).toHaveLength(1);
    expect(signals[0]?.value).toBe(0);
    expect(JSON.parse(String(signals[0]?.metadata_json)).failureKind).toBe("command");
  }));

test("plugin tool.execute.after hook records nothing in private mode", async () =>
  withPlugin(async ({ hooks, connection, getTool }) => {
    await getTool("swe_factory_set_private_mode").execute(
      { enabled: true },
      {
        sessionID: "session-1",
        messageID: "msg-1",
        agent: "build",
        directory: "/test/project",
        worktree: "/test/project",
        abort: new AbortController().signal,
        metadata: () => {},
        ask: async () => {},
      },
    );
    const msg = chatInput("session-1", "Fix the login bug");
    await hooks["chat.message"]?.(msg.input, msg.output);

    await hooks["tool.execute.after"]?.(
      { tool: "bash", sessionID: "session-1", callID: "call-1", args: { command: "bun test" } },
      { title: "bun test", output: "3 pass", metadata: { exit: 0 } },
    );

    expect(
      connection.database.query<Record<string, unknown>, []>(
        "SELECT * FROM outcome_signals",
      ).all(),
    ).toHaveLength(0);
  }));
