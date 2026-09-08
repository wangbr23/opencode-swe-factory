import type { Hooks } from "@opencode-ai/plugin";
import {
  admitCuratedDocumentSources,
  createDefaultConfig,
  indexConfirmedLessonEmbeddings,
  indexDocumentSources,
  migrateSqliteSchema,
  openSqliteConnection,
  releaseSchemaMigrations,
  resolveProjectIdentity,
  type SqliteConnection,
} from "../../../src/core/index.js";
import { composePluginHooks } from "../../../src/opencode/plugin.js";
import { EMBEDDING_VECTOR_DIMENSIONS } from "../../../src/types/embedding-types.js";
import type { ConfigV1 } from "../../../src/types/config-types.js";
import {
  chatInput,
  createAssistantCompletionEvent,
  createSystemTransformInputFixture,
  createToolContext,
  textOf,
  type ChatMessageHook,
  type SystemTransformHook,
} from "../../opencode/fixtures.js";
import {
  ACKNOWLEDGED_LESSON,
  ACKNOWLEDGMENT_DOCUMENT,
  BLOCKED_DOCUMENT,
  BLOCKED_LESSON,
  PRIVATE_MODE_PROJECT_PATH,
  RECALL_QUERY,
  SAFE_DOCUMENT,
  SEEDED_LESSON,
} from "./private-mode-values.js";

const mode = process.argv[2];
const databasePath = process.argv[3];
const diagnosticsPath = process.argv[4];
const extraArgument = process.argv[5];

const usage =
  "Usage: private-mode-process.ts seed <db> <diag> | recall <db> <diag> | " +
  "private <db> <diag> | counts <db> | secret-lesson <db> <diag> | secret-docs <db> <diag> <project-root>";

const KNOWN_MODES = ["seed", "recall", "private", "counts", "secret-lesson", "secret-docs"];
if (mode === undefined || !KNOWN_MODES.includes(mode) || databasePath === undefined) {
  throw new Error(usage);
}
if (mode !== "counts" && diagnosticsPath === undefined) {
  throw new Error(usage);
}
if (mode === "secret-docs" && extraArgument === undefined) {
  throw new Error(usage)
}
const resolvedDiagnosticsPath = diagnosticsPath ?? "";

const RECORDING_TABLES = [
  "tasks",
  "task_profiles",
  "execution_profiles",
  "outcome_signals",
  "pending_lesson_candidates",
  "lessons",
  "lesson_versions",
  "lesson_version_embeddings",
  "lesson_retrieval_hits",
  "document_sources",
  "document_chunks",
  "document_chunk_embeddings",
] as const;

function countRows(connection: SqliteConnection): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of RECORDING_TABLES) {
    const row = connection.database
      .query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`)
      .get();
    counts[table] = row?.count ?? -1;
  }
  return counts;
}

const constantEmbed = async (): Promise<Float32Array> => {
  const vector = new Float32Array(EMBEDDING_VECTOR_DIMENSIONS);
  vector[0] = 1;
  return vector;
};

function privateModeConfig(): ConfigV1 {
  const defaults = createDefaultConfig();
  return { ...defaults, privateMode: { ...defaults.privateMode, enabled: true } };
}

async function approveLessonViaTools(
  hooks: Hooks,
  lesson: { title: string; body: string; rationale: string },
  acknowledgedSecretRisk?: boolean,
): Promise<string> {
  const propose = hooks.tool?.swe_factory_propose_lesson;
  const commit = hooks.tool?.swe_factory_commit_lesson;
  if (propose === undefined || commit === undefined) {
    throw new Error("Lesson tools are not registered.");
  }
  const approvalCard = textOf(
    await propose.execute({ ...lesson, scope: "project" }, createToolContext("secret-approval")),
  );
  const candidateId = approvalCard.match(/^Candidate ID: (.+)$/m)?.[1];
  if (candidateId === undefined) {
    return approvalCard;
  }
  return textOf(
    await commit.execute(
      { candidateId, decision: "approve", ...(acknowledgedSecretRisk !== undefined ? { acknowledgedSecretRisk } : {}) },
      createToolContext("secret-approval"),
    ),
  );
}

const connection = openSqliteConnection(databasePath);
let hooks: Hooks | undefined;

try {
  migrateSqliteSchema(connection, releaseSchemaMigrations);

  if (mode === "seed") {
    const { project } = resolveProjectIdentity(connection, {
      projectPath: PRIVATE_MODE_PROJECT_PATH,
    });
    hooks = composePluginHooks({
      connection,
      config: createDefaultConfig(),
      projectId: project.id,
      compatibility: { status: "supported", version: "1.18.27" },
      diagnosticsPath: resolvedDiagnosticsPath,
    });
    const committed = await approveLessonViaTools(hooks, SEEDED_LESSON);
    if (committed !== "Lesson approved successfully.") {
      throw new Error(`Seeding the lesson failed: ${committed}`);
    }
    const indexing = await indexConfirmedLessonEmbeddings(connection, { embed: constantEmbed });
    if (indexing.embeddedCount !== 1 || indexing.failures.length !== 0) {
      throw new Error(`Seeded lesson was not indexed: ${JSON.stringify(indexing)}`);
    }
    console.log(JSON.stringify({ status: "seeded", counts: countRows(connection) }));
  } else if (mode === "recall") {
    const { project } = resolveProjectIdentity(connection, {
      projectPath: PRIVATE_MODE_PROJECT_PATH,
    });
    hooks = composePluginHooks({
      connection,
      config: createDefaultConfig(),
      projectId: project.id,
      compatibility: { status: "supported", version: "1.18.27" },
      diagnosticsPath: resolvedDiagnosticsPath,
    });
    const recallInput = chatInput("recall-session", RECALL_QUERY, "recall-message");
    const chatMessage = hooks["chat.message"] as ChatMessageHook;
    await chatMessage(recallInput.input, recallInput.output);
    const system = ["You are a coding agent."];
    const transform = hooks["experimental.chat.system.transform"] as SystemTransformHook;
    await transform(createSystemTransformInputFixture("recall-session"), { system });
    console.log(JSON.stringify({ status: "recalled", system: system.join("\n") }));
  } else if (mode === "private") {
    const { project } = resolveProjectIdentity(connection, {
      projectPath: PRIVATE_MODE_PROJECT_PATH,
    });
    let embedderCreated = false;
    hooks = composePluginHooks({
      connection,
      config: privateModeConfig(),
      projectId: project.id,
      compatibility: { status: "supported", version: "1.18.27" },
      diagnosticsPath: resolvedDiagnosticsPath,
      createLessonEmbedder: async () => {
        embedderCreated = true;
        return constantEmbed;
      },
    });

    const setPrivateMode = hooks.tool?.swe_factory_set_private_mode;
    if (setPrivateMode === undefined) {
      throw new Error("Private-mode toggle tool is not registered.");
    }
    const toggleText = textOf(
      await setPrivateMode.execute({ enabled: true }, createToolContext("private-session")),
    );

    const privateInput = chatInput(
      "private-session",
      "Fix the flaky test in the retrieval module.",
      "private-message",
    );
    const chatMessage = hooks["chat.message"] as ChatMessageHook;
    await chatMessage(privateInput.input, privateInput.output);

    const system = ["You are a coding agent."];
    const transform = hooks["experimental.chat.system.transform"] as SystemTransformHook;
    await transform(createSystemTransformInputFixture("private-session"), { system });

    const propose = hooks.tool?.swe_factory_propose_lesson;
    if (propose === undefined) {
      throw new Error("Lesson proposal tool is not registered.");
    }
    const proposalText = textOf(
      await propose.execute(
        { ...SEEDED_LESSON, scope: "project" },
        createToolContext("private-session"),
      ),
    );

    const feedback = hooks.tool?.swe_factory_record_feedback;
    if (feedback === undefined) {
      throw new Error("Feedback tool is not registered.");
    }
    const feedbackText = textOf(
      await feedback.execute({ feedbackKind: "acceptance" }, createToolContext("private-session")),
    );

    const eventHook = hooks.event;
    if (eventHook === undefined) {
      throw new Error("Event hook is not registered.");
    }
    await eventHook({ event: createAssistantCompletionEvent({ sessionId: "private-session" }) });
    const toolAfter = hooks["tool.execute.after"];
    if (toolAfter === undefined) {
      throw new Error("tool.execute.after hook is not registered.");
    }
    await toolAfter(
      { sessionID: "private-session", callID: "call-1", tool: "bash", args: { command: "bun test" } },
      { title: "bun test", output: "42 pass", metadata: { exit: 0 } },
    );

    const recommendation = hooks.tool?.swe_factory_get_recommendation;
    if (recommendation === undefined) {
      throw new Error("Recommendation tool is not registered.");
    }
    const recommendationText = textOf(await recommendation.execute({}, createToolContext("private-session")));

    console.log(JSON.stringify({
      status: "private-activity",
      embedderCreated,
      toggleText,
      proposalText,
      feedbackText,
      recommendationText,
      system: system.join("\n"),
      counts: countRows(connection),
    }));
  } else if (mode === "counts") {
    console.log(JSON.stringify({ status: "counts", counts: countRows(connection) }));
  } else if (mode === "secret-lesson") {
    const { project } = resolveProjectIdentity(connection, {
      projectPath: PRIVATE_MODE_PROJECT_PATH,
    });
    hooks = composePluginHooks({
      connection,
      config: createDefaultConfig(),
      projectId: project.id,
      compatibility: { status: "supported", version: "1.18.27" },
      diagnosticsPath: resolvedDiagnosticsPath,
    });

    const blockedProposal = await approveLessonViaTools(hooks, BLOCKED_LESSON);
    const withoutAcknowledgment = await approveLessonViaTools(hooks, ACKNOWLEDGED_LESSON);
    const withAcknowledgment = await approveLessonViaTools(
      hooks,
      ACKNOWLEDGED_LESSON,
      true,
    );

    console.log(JSON.stringify({
      status: "secret-lesson",
      blockedProposal,
      withoutAcknowledgment,
      withAcknowledgment,
      counts: countRows(connection),
    }));
  } else {
    const projectRoot = extraArgument as string;
    const { project } = resolveProjectIdentity(connection, {
      projectPath: PRIVATE_MODE_PROJECT_PATH,
    });
    const admission = await admitCuratedDocumentSources({
      projectId: project.id,
      projectRoot,
      curatedPaths: ["."],
      limits: { maxFileBytes: 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024 },
    });
    const indexing = indexDocumentSources(connection, { sources: admission.admitted });
    const chunks = connection.database
      .query<{ source_path: string; text: string }, []>(
        "SELECT source_path, text FROM document_chunks ORDER BY source_path",
      )
      .all();
    console.log(JSON.stringify({
      status: "secret-docs",
      admitted: admission.admitted.map((source) => source.relativePath),
      skipped: admission.skipped.map((source) => ({ path: source.path, reason: source.reason })),
      chunks,
      indexedChunkCount: indexing.indexedChunkCount,
      counts: countRows(connection),
    }));
  }

  await hooks?.dispose?.();
} finally {
  if (!connection.isClosed) {
    connection.close();
  }
}
