import {
  createDefaultConfig,
  migrateSqliteSchema,
  openSqliteConnection,
  releaseSchemaMigrations,
  resolveProjectIdentity,
  retrieveConfirmedLessonsHybrid,
} from "../../../src/core/index.js";
import { composePluginHooks } from "../../../src/opencode/plugin.js";
import { EMBEDDING_VECTOR_DIMENSIONS } from "../../../src/types/embedding-types.js";
import {
  chatInput,
  createSystemTransformInputFixture,
  createToolContext,
  textOf,
  type ChatMessageHook,
  type SystemTransformHook,
} from "../../opencode/fixtures.js";
import {
  CORRECTION_RECALL_LESSON,
  CORRECTION_RECALL_PARAPHRASE,
  CORRECTION_RECALL_PROJECT_PATH,
} from "./correction-recall-values.js";

const mode = process.argv[2];
const databasePath = process.argv[3];
const diagnosticsPath = process.argv[4];

if ((mode !== "approve" && mode !== "recall") || databasePath === undefined || diagnosticsPath === undefined) {
  throw new Error("Usage: correction-recall-process.ts <approve|recall> <database-path> <diagnostics-path>");
}

const embed = async (): Promise<Float32Array> => {
  // Keep this plumbing acceptance network-free; T50 measures real embedding quality.
  const vector = new Float32Array(EMBEDDING_VECTOR_DIMENSIONS);
  vector[0] = 1;
  return vector;
};

const connection = openSqliteConnection(databasePath);

try {
  migrateSqliteSchema(connection, releaseSchemaMigrations);
  const { project } = resolveProjectIdentity(connection, {
    projectPath: CORRECTION_RECALL_PROJECT_PATH,
  });
  const hooks = composePluginHooks({
    connection,
    config: createDefaultConfig(),
    projectId: project.id,
    compatibility: { status: "supported", version: "1.18.27" },
    diagnosticsPath,
    createLessonEmbedder: async () => embed,
  });

  if (mode === "approve") {
    const propose = hooks.tool?.swe_factory_propose_lesson;
    const commit = hooks.tool?.swe_factory_commit_lesson;
    if (propose === undefined || commit === undefined) {
      throw new Error("Lesson approval tools are not registered.");
    }

    const approvalCard = textOf(await propose.execute(
      {
        ...CORRECTION_RECALL_LESSON,
        scope: "project",
      },
      createToolContext("correction-session"),
    ));
    const candidateId = approvalCard.match(/^Candidate ID: (.+)$/m)?.[1];
    if (candidateId === undefined) {
      throw new Error(`Proposal did not return a candidate ID:\n${approvalCard}`);
    }

    const commitResult = textOf(await commit.execute(
      { candidateId, decision: "approve" },
      createToolContext("correction-session"),
    ));
    if (commitResult !== "Lesson approved successfully.") {
      throw new Error(commitResult);
    }

    // The plugin schedules its own background index run after the commit;
    // wait for it instead of racing it with a manual indexing call.
    const vectorCount = (): number =>
      connection.database.query<{ count: number }, []>(
        "SELECT count(*) AS count FROM lesson_version_embeddings",
      ).get()?.count ?? 0;
    const indexingDeadline = Date.now() + 5000;
    while (vectorCount() < 1 && Date.now() < indexingDeadline) {
      await Bun.sleep(10);
    }
    if (vectorCount() !== 1) {
      throw new Error(
        `Approved lesson was not indexed by the plugin: ${vectorCount()} vector row(s).`,
      );
    }

    console.log(JSON.stringify({ status: "approved" }));
  } else {
    const hybrid = await retrieveConfirmedLessonsHybrid(connection, {
      projectId: project.id,
      query: CORRECTION_RECALL_PARAPHRASE,
      embed,
    });
    const recalledLesson = hybrid.lessons.find(
      (lesson) => lesson.body === CORRECTION_RECALL_LESSON.body,
    );
    if (recalledLesson === undefined) {
      throw new Error("Hybrid retrieval did not return the approved lesson.");
    }

    const chatMessage = hooks["chat.message"] as ChatMessageHook;
    // The first guarded message starts the plugin's lazy local embedder.
    const warmup = chatInput("warmup-session", "Initialize local meaning search.", "warmup-message");
    await chatMessage(warmup.input, warmup.output);
    await Promise.resolve();

    const recall = chatInput("recall-session", CORRECTION_RECALL_PARAPHRASE, "recall-message");
    await chatMessage(recall.input, recall.output);
    const system = ["You are a coding agent."];
    const transform = hooks["experimental.chat.system.transform"] as SystemTransformHook;
    await transform(createSystemTransformInputFixture("recall-session"), { system });

    console.log(JSON.stringify({
      status: "recalled",
      semanticStatus: hybrid.semantic.status,
      lexicalRank: recalledLesson.lexicalRank,
      semanticRank: recalledLesson.semanticRank,
      system: system[0],
    }));
  }

  await hooks.dispose?.();
} finally {
  if (!connection.isClosed) {
    connection.close();
  }
}
