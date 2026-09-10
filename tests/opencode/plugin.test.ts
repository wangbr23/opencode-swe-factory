import { expect, test } from "bun:test";

import {
  proposeLessonCandidate,
  reviewLessonCandidate,
  indexConfirmedLessonEmbeddings,
  type SecretScanResult,
} from "../../src/core/index.js";
import { EMBEDDING_VECTOR_DIMENSIONS } from "../../src/types/embedding-types.js";
import type { EmbedLessonTextFn } from "../../src/types/lesson-embedding-index-types.js";
import {
  chatInput,
  createToolContext,
  textOf,
  withPlugin,
  type ChatMessageHook,
  type SystemTransformHook,
} from "./fixtures.js";

// --- Initialization and structure ---

test("composePluginHooks returns hooks with expected shape", () =>
  withPlugin(({ hooks, getTool }) => {
    expect(hooks.dispose).toBeFunction();
    expect(hooks["chat.message"]).toBeFunction();
    expect(hooks["experimental.chat.system.transform"]).toBeFunction();
    expect(hooks.tool).toBeDefined();

    expect(getTool("swe_factory_propose_lesson")).toBeDefined();
    expect(getTool("swe_factory_commit_lesson")).toBeDefined();
    expect(getTool("swe_factory_resolve_overlap")).toBeDefined();
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
    await systemTransform(
      { sessionID: "s1", model: {} as any },
      systemOutput,
    );

    expect(systemOutput.system[0]).toContain("parameterized queries");
  }));

test("semantic setup failure leaves lexical context injection available", () =>
  withPlugin(
    async ({ hooks, connection, projectId }) => {
      const candidate = proposeLessonCandidate(connection, {
        projectId,
        scope: "project",
        draft: {
          title: "Use transactions",
          body: "Use transactions for related writes",
          rationale: "atomicity",
          applicability: {},
          provenance: {},
        },
        secretScan: { disposition: "clear", findings: [], redactedText: "" },
      });
      reviewLessonCandidate(connection, { candidateId: candidate.id, decision: "approve" });
      const message = chatInput("s1", "Use transactions for writes");
      await (hooks["chat.message"] as ChatMessageHook)(message.input, message.output);
      const output = { system: ["original"] };
      await (hooks["experimental.chat.system.transform"] as SystemTransformHook)(
        {
          sessionID: "s1",
          model: {} as any,
        },
        output,
      );
      expect(output.system[0]).toContain("Use transactions");
    },
    {
      createLessonEmbedder: async () => {
        throw new Error("artifacts missing");
      },
    },
  ));

test("semantic-only paraphrase reaches injection after lazy embedder startup", () =>
  withPlugin(
    async ({ hooks, connection, projectId }) => {
      const embed = async (): Promise<Float32Array> => {
        const vector = new Float32Array(EMBEDDING_VECTOR_DIMENSIONS);
        vector[0] = 1;
        return vector;
      };
      const candidate = proposeLessonCandidate(connection, {
        projectId,
        scope: "project",
        draft: {
          title: "Parameterized SQL",
          body: "Bind SQL values through parameters",
          rationale: "security",
          applicability: {},
          provenance: {},
        },
        secretScan: { disposition: "clear", findings: [], redactedText: "" },
      });
      reviewLessonCandidate(connection, { candidateId: candidate.id, decision: "approve" });
      await indexConfirmedLessonEmbeddings(connection, { embed });

      const chatMessage = hooks["chat.message"] as ChatMessageHook;
      const coldMessage = chatInput("s1", "Avoid interpolating database values");
      await chatMessage(coldMessage.input, coldMessage.output);
      await Promise.resolve();
      const semanticMessage = chatInput("s2", "Avoid interpolating database values", "m2");
      await chatMessage(semanticMessage.input, semanticMessage.output);
      const output = { system: ["original"] };
      await (hooks["experimental.chat.system.transform"] as SystemTransformHook)(
        {
          sessionID: "s2",
          model: {} as any,
        },
        output,
      );
      expect(output.system[0]).toContain("Bind SQL values through parameters");
    },
    {
      createLessonEmbedder: async () => async () => {
        const vector = new Float32Array(EMBEDDING_VECTOR_DIMENSIONS);
        vector[0] = 1;
        return vector;
      },
    },
  ));

test("injection guards do not start the embedder", () => {
  let factoryCalls = 0;
  return withPlugin(
    async ({ hooks, getTool }) => {
      const chatMessage = hooks["chat.message"] as ChatMessageHook;
      await getTool("swe_factory_set_private_mode").execute(
        { enabled: true },
        createToolContext("private"),
      );
      await chatMessage(
        chatInput("private", "private request").input,
        chatInput("private", "private request").output,
      );
      await getTool("swe_factory_set_toggle").execute(
        { feature: "retrieval", enabled: false },
        createToolContext("disabled"),
      );
      await chatMessage(
        chatInput("disabled", "disabled request").input,
        chatInput("disabled", "disabled request").output,
      );
      expect(factoryCalls).toBe(0);
    },
    {
      createLessonEmbedder: () => {
        factoryCalls += 1;
        throw new Error("must not start");
      },
    },
  );
});

test("system.transform is no-op when version unsupported", () =>
  withPlugin(
    async ({ hooks }) => {
      const systemOutput = { system: ["original prompt"] };
      const systemTransform = hooks[
        "experimental.chat.system.transform"
      ] as SystemTransformHook;
      await systemTransform(
        {
          sessionID: "s1",
          model: {} as any,
        },
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

test("propose lesson tool surfaces related overlaps from the semantic pass", () =>
  withPlugin(
    async ({ getTool, connection }) => {
      const ctx = createToolContext("s1");
      const first = await getTool("swe_factory_propose_lesson").execute(
        {
          title: "Verify schema upgrades",
          body: "database migration testing before production deployment",
          rationale: "Caught a broken migration",
          scope: "global",
        },
        ctx,
      );
      const firstCandidateId = textOf(first).match(/Candidate ID: (.+)/)![1];
      await getTool("swe_factory_commit_lesson").execute(
        { candidateId: firstCandidateId, decision: "approve" },
        ctx,
      );
      // The plugin's own scheduled indexer run (post-commit) stores the vector.
      expect(await waitFor(() => storedVectorCount(connection) === 1)).toBe(true);

      const second = await getTool("swe_factory_propose_lesson").execute(
        {
          title: "Db checks",
          body: "db upgrade verification ahead of live rollout",
          rationale: "Expanded the practice after a rollout incident",
          scope: "global",
        },
        ctx,
      );
      expect(textOf(second)).toContain("[related]");
      expect(textOf(second)).toContain("Verify schema upgrades");
    },
    {
      createLessonEmbedder: async () => embedStub,
    },
  ));

test("committing a lesson schedules a background embedding index run", () =>
  withPlugin(
    async ({ getTool, connection }) => {
      const ctx = createToolContext("s1");
      const proposeResult = await getTool("swe_factory_propose_lesson").execute(
        {
          title: "Index me",
          body: "database migration tests run before every deploy",
          rationale: "Indexing test",
          scope: "global",
        },
        ctx,
      );
      const candidateId = textOf(proposeResult).match(/Candidate ID: (.+)/)![1];
      await getTool("swe_factory_commit_lesson").execute(
        { candidateId, decision: "approve" },
        ctx,
      );

      const indexed = await waitFor(() => storedVectorCount(connection) > 0);
      expect(indexed).toBe(true);
      const vectorRow = connection.database
        .query<{ lesson_id: string; lesson_version: number; model: string; revision: string }, []>(
          "SELECT lesson_id, lesson_version, model, revision FROM lesson_version_embeddings LIMIT 1",
        )
        .get() ?? null;
      expect(vectorRow).not.toBeNull();
      expect(vectorRow!.lesson_version).toBe(1);
    },
    {
      createLessonEmbedder: async () => embedStub,
    },
  ));

test("resolving an overlap schedules a reindex that drops the superseded vector", () =>
  withPlugin(
    async ({ getTool, connection }) => {
      const ctx = createToolContext("s1");
      const original = await getTool("swe_factory_propose_lesson").execute(
        {
          title: "Old convention",
          body: "database migration tests run before every deploy",
          rationale: "Original",
          scope: "global",
        },
        ctx,
      );
      const originalCandidateId = textOf(original).match(/Candidate ID: (.+)/)![1];
      await getTool("swe_factory_commit_lesson").execute(
        { candidateId: originalCandidateId, decision: "approve" },
        ctx,
      );
      expect(await waitFor(() => storedVectorCount(connection) === 1)).toBe(true);
      const lessonId = connection.database
        .query<{ id: string }, []>("SELECT id FROM lessons LIMIT 1")
        .get()!.id;

      const correction = await getTool("swe_factory_propose_lesson").execute(
        {
          title: "New convention",
          body: "database migration tests run before every single deploy",
          rationale: "Corrected",
          scope: "global",
        },
        ctx,
      );
      const card = textOf(correction);
      const candidateId = card.match(/Candidate ID: (.+)/)![1];
      const resolveResult = await getTool("swe_factory_resolve_overlap").execute(
        { candidateId, overlappingLessonId: lessonId },
        ctx,
      );
      expect(textOf(resolveResult)).toContain("Overlap resolved");

      const reindexed = await waitFor(() => {
        const active = connection.database
          .query<{ version: number }, [string]>(
            "SELECT lesson_version AS version FROM lesson_version_embeddings WHERE lesson_id = ?",
          )
          .get(lessonId);
        return active?.version === 2;
      });
      expect(reindexed).toBe(true);
    },
    {
      createLessonEmbedder: async () => embedStub,
    },
  ));

test("a throwing embedder never breaks the commit outcome", () =>
  withPlugin(
    async ({ getTool, connection }) => {
      const ctx = createToolContext("s1");
      const proposeResult = await getTool("swe_factory_propose_lesson").execute(
        {
          title: "Survives failure",
          body: "database migration tests run before every deploy",
          rationale: "Failure test",
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
      expect(await waitFor(() => storedVectorCount(connection) === 0 && true)).toBe(true);
      const lessons = connection.database
        .query<{ count: number }, []>("SELECT count(*) AS count FROM lessons")
        .get();
      expect(lessons!.count).toBe(1);
    },
    {
      createLessonEmbedder: async () => async () => {
        throw new Error("Embedding model unavailable.");
      },
    },
  ));

const embedStub: EmbedLessonTextFn = (text) => {
  const lower = text.toLowerCase();
  const vector = new Float32Array(EMBEDDING_VECTOR_DIMENSIONS);
  if (lower.includes("migration") || lower.includes("database") || lower.includes("upgrade")) {
    vector[0] = 1;
  } else {
    vector[2] = 1;
  }
  return Promise.resolve(vector);
};

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(10);
  }
  return predicate();
}

function storedVectorCount(connection: { database: { query: (sql: string) => { get: () => { count: number } | null } } }): number {
  return connection.database
    .query("SELECT count(*) AS count FROM lesson_version_embeddings")
    .get()?.count ?? 0;
}

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

// --- Tool: resolve overlap ---

test("resolve overlap tool supersedes the lesson and removes the candidate", () =>
  withPlugin(async ({ getTool, connection }) => {
    const ctx = createToolContext("s1");
    const proposeResult = await getTool("swe_factory_propose_lesson").execute(
      {
        title: "Use strict equality",
        body: "Always use === instead of == in JavaScript comparisons",
        rationale: "Prevents type coercion bugs",
        scope: "global",
      },
      ctx,
    );
    const originalCandidateId = textOf(proposeResult).match(/Candidate ID: (.+)/)![1];
    await getTool("swe_factory_commit_lesson").execute(
      { candidateId: originalCandidateId, decision: "approve" },
      ctx,
    );
    const lessonId = connection.database
      .query<{ id: string }, []>("SELECT id FROM lessons LIMIT 1")
      .get()!.id;

    const correction = await getTool("swe_factory_propose_lesson").execute(
      {
        title: "Use strict equality everywhere",
        body: "Always use === instead of == in JavaScript comparisons, including switch cases",
        rationale: "Extended after a coercion bug in a switch statement",
        scope: "global",
      },
      ctx,
    );
    const correctionCard = textOf(correction);
    expect(correctionCard).toContain("Overlapping confirmed lessons:");
    const candidateId = correctionCard.match(/Candidate ID: (.+)/)![1];

    const resolveResult = await getTool("swe_factory_resolve_overlap").execute(
      { candidateId, overlappingLessonId: lessonId },
      ctx,
    );
    expect(textOf(resolveResult)).toContain("Overlap resolved");

    const pending = connection.database
      .query<{ id: string }, []>("SELECT id FROM pending_lesson_candidates")
      .all();
    expect(pending).toHaveLength(0);
    const active = connection.database
      .query<{ active_version: number }, [string]>(
        "SELECT active_version FROM lessons WHERE id = ?",
      )
      .get(lessonId);
    expect(active!.active_version).toBe(2);
  }));

test("resolve overlap tool handles invalid ids", () =>
  withPlugin(async ({ getTool }) => {
    const result = await getTool("swe_factory_resolve_overlap").execute(
      { candidateId: "nonexistent", overlappingLessonId: "also-nonexistent" },
      createToolContext("s1"),
    );
    expect(textOf(result)).toContain("Overlap resolution failed");
    expect(textOf(result)).toContain("not found");
  }));

test("resolve overlap tool works in private mode for a pre-existing candidate", () =>
  withPlugin(async ({ connection, getTool, projectId }) => {
    const clearScan: SecretScanResult = {
      disposition: "clear",
      findings: [],
      redactedText: "",
    };
    const approved = proposeLessonCandidate(connection, {
      projectId: null,
      scope: "global",
      draft: {
        title: "Old convention",
        body: "Use camelCase for variables in shared code",
        rationale: "Team convention",
        applicability: {},
        provenance: {},
      },
      secretScan: clearScan,
    });
    reviewLessonCandidate(connection, {
      candidateId: approved.id,
      decision: "approve",
    });
    const lessonId = connection.database
      .query<{ id: string }, []>("SELECT id FROM lessons LIMIT 1")
      .get()!.id;
    const candidate = proposeLessonCandidate(connection, {
      projectId: null,
      scope: "global",
      draft: {
        title: "New convention",
        body: "Use snake_case for variables in shared code instead",
        rationale: "Team switched convention",
        applicability: {},
        provenance: {},
      },
      secretScan: clearScan,
    });

    const ctx = createToolContext("s1");
    await getTool("swe_factory_set_private_mode").execute({ enabled: true }, ctx);

    const result = await getTool("swe_factory_resolve_overlap").execute(
      { candidateId: candidate.id, overlappingLessonId: lessonId },
      ctx,
    );
    expect(textOf(result)).toContain("Overlap resolved");
    const pending = connection.database
      .query<{ count: number }, [string]>(
        "SELECT count(*) AS count FROM pending_lesson_candidates WHERE id = ?",
      )
      .get(candidate.id);
    expect(pending!.count).toBe(0);
    expect(projectId).toBeDefined();
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
    await systemTransform(
      { sessionID: "s2", model: {} as any },
      systemOutput,
    );

    expect(systemOutput.system[0]).toContain("Validate all inputs");
  }));
