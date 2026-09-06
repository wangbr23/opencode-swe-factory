import { expect, test } from "bun:test";

import {
  OPENCODE_COMPATIBILITY_MANIFEST,
} from "../../src/opencode/compatibility.js";
import {
  proposeLessonCandidate,
  reviewLessonCandidate,
  type SecretScanResult,
  type SqliteConnection,
} from "../../src/core/index.js";
import {
  chatInput,
  createSystemTransformInputFixture,
  createToolContext,
  textOf,
  withPlugin,
  type ChatMessageHook,
  type PluginTestContext,
  type SystemTransformHook,
} from "./fixtures.js";

const clearScan: SecretScanResult = {
  disposition: "clear",
  findings: [],
  redactedText: "",
};

const SQL_LESSON = {
  title: "Use parameterized queries",
  body: "Never concatenate user input into SQL strings to prevent injection attacks",
};

const SQL_QUERY = "Fix the SQL injection bug with parameterized queries";

async function confirmLesson(
  connection: SqliteConnection,
  projectId: string,
  draft: { title: string; body: string },
  scope: "project" | "global" = "project",
): Promise<void> {
  const candidate = proposeLessonCandidate(connection, {
    projectId: scope === "project" ? projectId : null,
    scope,
    draft: {
      ...draft,
      rationale: "Contract suite fixture",
      applicability: {},
      provenance: {},
    },
    secretScan: clearScan,
  });
  reviewLessonCandidate(connection, {
    candidateId: candidate.id,
    decision: "approve",
  });
}

async function sendMessage(
  hooks: PluginTestContext["hooks"],
  sessionId: string,
  text: string,
  messageId = "msg-1",
): Promise<void> {
  const chatMessage = hooks["chat.message"] as ChatMessageHook;
  const msg = chatInput(sessionId, text, messageId);
  await chatMessage(msg.input, msg.output);
}

async function runSystemTransform(
  hooks: PluginTestContext["hooks"],
  sessionId: string,
  system: string[],
): Promise<void> {
  const systemTransform = hooks[
    "experimental.chat.system.transform"
  ] as SystemTransformHook;
  await systemTransform(createSystemTransformInputFixture(sessionId), {
    system,
  });
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function primaryOf(system: string[]): string {
  const primary = system[0];
  if (primary === undefined) {
    throw new Error("system array is empty");
  }
  return primary;
}

// --- Contract: injection covers every tested OpenCode version ---

test.each([...OPENCODE_COMPATIBILITY_MANIFEST.testedVersions])(
  "injects confirmed lessons for tested OpenCode version %s",
  (version) =>
    withPlugin(
      async ({ hooks, connection, projectId }) => {
        await confirmLesson(connection, projectId, SQL_LESSON);

        await sendMessage(hooks, "s1", SQL_QUERY);

        const system = ["existing system prompt"];
        await runSystemTransform(hooks, "s1", system);

        expect(primaryOf(system)).toContain("Use parameterized queries");
      },
      { compatibility: { status: "supported", version } },
    ),
);

// --- Contract: in-place primary-block mutation (single-system-message backend) ---

test("injection mutates the primary system block in place, never appending a system element", () =>
  withPlugin(async ({ hooks, connection, projectId }) => {
    await confirmLesson(connection, projectId, SQL_LESSON);

    // Backend that accepts exactly one leading system message.
    await sendMessage(hooks, "s1", SQL_QUERY);
    const singleSystem = ["You are a coding agent."];
    await runSystemTransform(hooks, "s1", singleSystem);
    expect(singleSystem).toHaveLength(1);
    expect(primaryOf(singleSystem).startsWith("You are a coding agent.")).toBe(true);
    expect(primaryOf(singleSystem)).toContain("Use parameterized queries");

    // Backend that starts with no system message at all.
    await sendMessage(hooks, "s2", SQL_QUERY, "msg-2");
    const emptySystem: string[] = [];
    await runSystemTransform(hooks, "s2", emptySystem);
    expect(emptySystem).toHaveLength(1);
    expect(primaryOf(emptySystem)).toContain("Use parameterized queries");
  }));

test("injection preserves the original primary content and leaves other system elements untouched", () =>
  withPlugin(async ({ hooks, connection, projectId }) => {
    await confirmLesson(connection, projectId, SQL_LESSON);

    await sendMessage(hooks, "s1", SQL_QUERY);

    const system = ["primary block", "secondary block", "tertiary block"];
    await runSystemTransform(hooks, "s1", system);

    expect(system).toHaveLength(3);
    expect(primaryOf(system).startsWith("primary block")).toBe(true);
    expect(primaryOf(system)).toContain("Use parameterized queries");
    expect(system[1]).toBe("secondary block");
    expect(system[2]).toBe("tertiary block");
  }));

// --- Contract: exactly-once consumption ---

test("pending injection is consumed exactly once across repeated transforms", () =>
  withPlugin(async ({ hooks, connection, projectId }) => {
    await confirmLesson(connection, projectId, SQL_LESSON);

    await sendMessage(hooks, "s1", SQL_QUERY);

    const system = ["existing system prompt"];
    await runSystemTransform(hooks, "s1", system);
    await runSystemTransform(hooks, "s1", system);

    expect(countOccurrences(primaryOf(system), "Use parameterized queries")).toBe(1);
  }));

// --- Contract: queued same-session correlation ---

test("second queued message in the same session suppresses both injections, and the next message recovers", () =>
  withPlugin(async ({ hooks, connection, projectId }) => {
    await confirmLesson(connection, projectId, SQL_LESSON);

    await sendMessage(hooks, "s1", SQL_QUERY, "msg-1");
    await sendMessage(hooks, "s1", SQL_QUERY, "msg-2");

    const system = ["existing system prompt"];
    await runSystemTransform(hooks, "s1", system);
    expect(system).toEqual(["existing system prompt"]);

    await sendMessage(hooks, "s1", SQL_QUERY, "msg-3");
    const recovered = ["existing system prompt"];
    await runSystemTransform(hooks, "s1", recovered);
    expect(recovered[0]).toContain("Use parameterized queries");
  }));

// --- Contract: concurrent-session isolation ---

test("pending injection for one session never reaches or is consumed by another session", () =>
  withPlugin(async ({ hooks, connection, projectId }) => {
    await confirmLesson(connection, projectId, SQL_LESSON);
    // Global scope: a project scope holds a single active lesson, so the
    // second fixture lesson is confirmed globally to keep both active.
    await confirmLesson(connection, projectId, {
      title: "Run the test suite",
      body: "Run the full test suite before every commit to catch regressions",
    }, "global");

    await sendMessage(hooks, "sql-session", SQL_QUERY, "msg-1");
    await sendMessage(
      hooks,
      "test-session",
      "Run the full test suite before every commit",
      "msg-2",
    );

    const systemB = ["session B prompt"];
    await runSystemTransform(hooks, "test-session", systemB);
    // Session B may see its own lesson, but never session A's pending injection.
    expect(systemB).toHaveLength(1);
    expect(primaryOf(systemB)).not.toContain("Use parameterized queries");
    expect(primaryOf(systemB)).toContain("Run the test suite");

    const systemA = ["session A prompt"];
    await runSystemTransform(hooks, "sql-session", systemA);
    expect(primaryOf(systemA)).toContain("Use parameterized queries");
  }));

// --- Contract: human-approval and privacy boundaries ---

test("unapproved lesson candidates are never injected", () =>
  withPlugin(async ({ hooks, getTool }) => {
    const proposeResult = await getTool("swe_factory_propose_lesson").execute(
      {
        title: "Pending zebra lesson",
        body: "Always dry the zebra wetland before painting the enclosure",
        rationale: "Not yet reviewed",
        scope: "project",
      },
      createToolContext("s1"),
    );
    expect(textOf(proposeResult)).toContain("Candidate ID:");

    await sendMessage(
      hooks,
      "s1",
      "Dry the zebra wetland before painting the enclosure",
    );

    const system = ["existing system prompt"];
    await runSystemTransform(hooks, "s1", system);
    expect(system).toEqual(["existing system prompt"]);
  }));

test("session private mode suppresses injection of matching confirmed lessons", () =>
  withPlugin(async ({ hooks, getTool, connection, projectId }) => {
    await confirmLesson(connection, projectId, SQL_LESSON);

    await getTool("swe_factory_set_private_mode").execute(
      { enabled: true },
      createToolContext("s1"),
    );

    await sendMessage(hooks, "s1", SQL_QUERY);

    const system = ["existing system prompt"];
    await runSystemTransform(hooks, "s1", system);
    expect(system).toEqual(["existing system prompt"]);
  }));

test("session retrieval toggle suppresses injection", () =>
  withPlugin(async ({ hooks, getTool, connection, projectId }) => {
    await confirmLesson(connection, projectId, SQL_LESSON);

    await getTool("swe_factory_set_toggle").execute(
      { feature: "retrieval", enabled: false },
      createToolContext("s1"),
    );

    await sendMessage(hooks, "s1", SQL_QUERY);

    const system = ["existing system prompt"];
    await runSystemTransform(hooks, "s1", system);
    expect(system).toEqual(["existing system prompt"]);
  }));

test("injected block contains lesson content but not the raw user message text", () =>
  withPlugin(async ({ hooks, connection, projectId }) => {
    await confirmLesson(connection, projectId, {
      title: "Verify deployment health checks",
      body: "Always verify deployment health checks before announcing completion",
    });

    await sendMessage(
      hooks,
      "s1",
      "check the zebra-falcon-marker deployment health before finishing",
    );

    const system = ["existing system prompt"];
    await runSystemTransform(hooks, "s1", system);

    expect(primaryOf(system)).toContain("Verify deployment health checks");
    expect(primaryOf(system)).not.toContain("zebra-falcon-marker");
  }));

// --- Contract: fail-open behavior ---

test("hooks resolve without throwing when the database is unusable", () =>
  withPlugin(async ({ hooks, connection }) => {
    connection.close();

    await expect(
      sendMessage(hooks, "s1", "any message at all"),
    ).resolves.toBeUndefined();

    const system = ["existing system prompt"];
    await expect(runSystemTransform(hooks, "s1", system)).resolves.toBeUndefined();
    expect(system).toEqual(["existing system prompt"]);
  }));

test("unsupported OpenCode version keeps tools functional and never injects", () =>
  withPlugin(
    async ({ hooks, getTool }) => {
      const toggles = await getTool("swe_factory_get_toggles").execute(
        {},
        createToolContext("s1"),
      );
      expect(JSON.parse(textOf(toggles)).resolved.retrieval).toBe(true);

      const proposeResult = await getTool("swe_factory_propose_lesson").execute(
        {
          title: "Use parameterized queries",
          body: "Never concatenate user input into SQL strings to prevent injection attacks",
          rationale: "Security best practice",
          scope: "project",
        },
        createToolContext("s1"),
      );
      const candidateId = textOf(proposeResult).match(/Candidate ID: (.+)/)![1];
      const commitResult = await getTool("swe_factory_commit_lesson").execute(
        { candidateId, decision: "approve" },
        createToolContext("s1"),
      );
      expect(textOf(commitResult)).toContain("approved successfully");

      await sendMessage(hooks, "s1", SQL_QUERY);

      const system = ["existing system prompt"];
      await runSystemTransform(hooks, "s1", system);
      expect(system).toEqual(["existing system prompt"]);
    },
    {
      compatibility: {
        status: "unsupported",
        version: "1.0.0",
        reason: "below-minimum-version",
      },
    },
  ));
