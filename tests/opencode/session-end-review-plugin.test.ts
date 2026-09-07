import { expect, test } from "bun:test";

import { readLocalDiagnostics } from "../../src/core/index.js";
import {
  createToolContext,
  textOf,
  withPlugin,
  type EventHookEvent,
} from "./fixtures.js";

function sessionIdleEvent(sessionId = "session-1"): EventHookEvent {
  return { type: "session.idle", properties: { sessionID: sessionId } };
}

test("plugin session.idle offers a deferred-candidate reminder once per candidate set", () =>
  withPlugin(async ({ hooks, connection, diagnosticsPath, getTool }) => {
    const propose = getTool("swe_factory_propose_lesson");
    await propose.execute(
      {
        title: "Run tests before commits",
        body: "Always run bun test before committing.",
        rationale: "User corrected a commit without tests.",
        scope: "global",
      },
      createToolContext("session-1"),
    );
    expect(
      connection.database
        .query<Record<string, unknown>, []>("SELECT * FROM pending_lesson_candidates")
        .all(),
    ).toHaveLength(1);

    await hooks.event?.({ event: sessionIdleEvent() });

    const diagnostics = readLocalDiagnostics(`${diagnosticsPath}/diagnostics.jsonl`);
    const reminders = diagnostics.filter((d) => d.code === "deferred-candidate-reminder");
    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.severity).toBe("info");
    expect(reminders[0]?.summary).toContain("Run tests before commits");
    expect(reminders[0]?.summary).toContain("swe_factory_commit_lesson");

    await hooks.event?.({ event: sessionIdleEvent() });
    expect(
      readLocalDiagnostics(`${diagnosticsPath}/diagnostics.jsonl`).filter(
        (d) => d.code === "deferred-candidate-reminder",
      ),
    ).toHaveLength(1);

    await propose.execute(
      {
        title: "Prefer small pull requests",
        body: "Keep pull requests focused on a single change.",
        rationale: "Large PRs are hard to review.",
        scope: "global",
      },
      createToolContext("session-1"),
    );
    await hooks.event?.({ event: sessionIdleEvent() });
    expect(
      readLocalDiagnostics(`${diagnosticsPath}/diagnostics.jsonl`).filter(
        (d) => d.code === "deferred-candidate-reminder",
      ),
    ).toHaveLength(2);
  }));

test("plugin session.idle cleans up expired candidates even when reminders are disabled", () =>
  withPlugin(async ({ hooks, connection, diagnosticsPath, getTool }) => {
    const propose = getTool("swe_factory_propose_lesson");
    await propose.execute(
      {
        title: "Run tests before commits",
        body: "Always run bun test before committing.",
        rationale: "User corrected a commit without tests.",
        scope: "global",
      },
      createToolContext("session-1"),
    );

    const setPrivateMode = getTool("swe_factory_set_private_mode");
    await setPrivateMode.execute({ enabled: true }, createToolContext("session-1"));

    connection.database.run(
      "UPDATE pending_lesson_candidates SET expires_at = ?",
      ["2026-09-01T00:00:00.000Z"],
    );

    await hooks.event?.({ event: sessionIdleEvent() });

    expect(
      connection.database
        .query<Record<string, unknown>, []>("SELECT * FROM pending_lesson_candidates")
        .all(),
    ).toHaveLength(0);
    expect(readLocalDiagnostics(`${diagnosticsPath}/diagnostics.jsonl`)).toHaveLength(0);
  }));

test("plugin session.idle suppresses reminders when recording is disabled", () =>
  withPlugin(async ({ hooks, connection, diagnosticsPath, getTool }) => {
    const propose = getTool("swe_factory_propose_lesson");
    await propose.execute(
      {
        title: "Run tests before commits",
        body: "Always run bun test before committing.",
        rationale: "User corrected a commit without tests.",
        scope: "global",
      },
      createToolContext("session-1"),
    );

    const setToggle = getTool("swe_factory_set_toggle");
    await setToggle.execute(
      { feature: "recording", enabled: false },
      createToolContext("session-1"),
    );

    await hooks.event?.({ event: sessionIdleEvent() });

    expect(readLocalDiagnostics(`${diagnosticsPath}/diagnostics.jsonl`)).toHaveLength(0);
    expect(
      connection.database
        .query<Record<string, unknown>, []>("SELECT * FROM pending_lesson_candidates")
        .all(),
    ).toHaveLength(1);
  }));

test("plugin session.idle with no candidates writes no reminder", () =>
  withPlugin(async ({ hooks, diagnosticsPath }) => {
    await hooks.event?.({ event: sessionIdleEvent() });
    expect(readLocalDiagnostics(`${diagnosticsPath}/diagnostics.jsonl`)).toHaveLength(0);
  }));
