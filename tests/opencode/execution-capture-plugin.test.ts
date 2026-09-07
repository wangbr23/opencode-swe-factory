import { expect, test } from "bun:test";

import {
  createAssistantCompletionEvent,
  chatInput,
  withPlugin,
} from "./fixtures.js";

const COMPLETED_AT = Date.parse("2026-09-06T12:00:07.000Z");

test("plugin event hook records execution profiles and outcome signals for assistant completions", () =>
  withPlugin(async ({ hooks, connection }) => {
    const msg = chatInput("session-1", "Fix the login bug");
    await hooks["chat.message"]?.(msg.input, msg.output);
    await hooks.event?.({ event: createAssistantCompletionEvent({ completedAtMs: COMPLETED_AT }) });

    const profiles = connection.database
      .query<Record<string, unknown>, []>("SELECT * FROM execution_profiles")
      .all();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.provider).toBe("openai");
    expect(profiles[0]?.model).toBe("gpt-4.1");
    expect(profiles[0]?.finish_state).toBe("stop");
    expect(profiles[0]?.latency_ms).toBe(7000);

    const signals = connection.database
      .query<Record<string, unknown>, []>("SELECT * FROM outcome_signals")
      .all();
    expect(signals).toHaveLength(3);
    expect(signals.map((s) => s.dimension).sort()).toEqual([
      "cost",
      "latency",
      "reliability",
    ]);
  }));

test("plugin event hook ignores streaming updates and duplicate completions", () =>
  withPlugin(async ({ hooks, connection }) => {
    const msg = chatInput("session-1", "Fix the login bug");
    await hooks["chat.message"]?.(msg.input, msg.output);

    await hooks.event?.({
      event: createAssistantCompletionEvent({ completedAtMs: undefined }),
    });
    expect(
      connection.database.query<Record<string, unknown>, []>(
        "SELECT * FROM execution_profiles",
      ).all(),
    ).toHaveLength(0);

    await hooks.event?.({
      event: createAssistantCompletionEvent({ completedAtMs: COMPLETED_AT }),
    });
    await hooks.event?.({
      event: createAssistantCompletionEvent({ completedAtMs: COMPLETED_AT }),
    });
    expect(
      connection.database.query<Record<string, unknown>, []>(
        "SELECT * FROM execution_profiles",
      ).all(),
    ).toHaveLength(1);
  }));

test("plugin event hook records nothing in private mode", () =>
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
    await hooks.event?.({ event: createAssistantCompletionEvent({ completedAtMs: COMPLETED_AT }) });

    expect(
      connection.database.query<Record<string, unknown>, []>(
        "SELECT * FROM execution_profiles",
      ).all(),
    ).toHaveLength(0);
    expect(
      connection.database.query<Record<string, unknown>, []>(
        "SELECT * FROM outcome_signals",
      ).all(),
    ).toHaveLength(0);
  }));

test("plugin event hook ignores non-assistant and unrelated events", () =>
  withPlugin(async ({ hooks, connection }) => {
    const msg = chatInput("session-1", "Fix the login bug");
    await hooks["chat.message"]?.(msg.input, msg.output);
    await hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: "session-1" } },
    });

    expect(
      connection.database.query<Record<string, unknown>, []>(
        "SELECT * FROM execution_profiles",
      ).all(),
    ).toHaveLength(0);
  }));

test("plugin event hook records the session's selected variant on completion profiles", () =>
  withPlugin(async ({ hooks, connection }) => {
    const msg = chatInput("session-1", "Fix the login bug");
    await hooks["chat.message"]?.(
      { ...msg.input, variant: "thinking" },
      msg.output,
    );
    await hooks.event?.({ event: createAssistantCompletionEvent({ completedAtMs: COMPLETED_AT }) });

    const profiles = connection.database
      .query<{ variant: string | null }, []>("SELECT variant FROM execution_profiles")
      .all();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.variant).toBe("thinking");
  }));
