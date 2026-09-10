import type { Hooks } from "@opencode-ai/plugin";
import {
  createDefaultConfig,
  indexConfirmedLessonEmbeddings,
  migrateSqliteSchema,
  openSqliteConnection,
  releaseSchemaMigrations,
  resolveProjectIdentity,
  retrieveConfirmedLessonsHybrid,
  supersedeLesson,
  suppressConflictingLessons,
  type SqliteConnection,
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
  CONFLICT_LESSONS,
  GLOBAL_LESSON,
  LESSON_ISOLATION_PROJECT_ALPHA_PATH,
  SUPERSEDED_LESSON,
} from "./lesson-isolation-values.js";

const mode = process.argv[2];
const databasePath = process.argv[3];
const diagnosticsPath = process.argv[4];
const projectPathOrLessonId = process.argv[5];
const query = process.argv[6];

const usage =
  "Usage: lesson-isolation-process.ts seed <db> <diag> | supersede <db> <diag> <lesson-id> | recall <db> <diag> <project-path> <query>";

if (
  (mode !== "seed" && mode !== "supersede" && mode !== "recall") ||
  databasePath === undefined ||
  diagnosticsPath === undefined
) {
  throw new Error(usage);
}
if (mode === "supersede" && projectPathOrLessonId === undefined) {
  throw new Error(usage);
}
if (mode === "recall" && (projectPathOrLessonId === undefined || query === undefined)) {
  throw new Error(usage);
}

const embed = async (text: string): Promise<Float32Array> => {
  // Deterministic term hashing keeps this acceptance network-free while letting
  // semantic similarity discriminate between lessons; T50 measures real quality.
  const vector = new Float32Array(EMBEDDING_VECTOR_DIMENSIONS);
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  for (const token of tokens) {
    let hash = 5381;
    for (let index = 0; index < token.length; index++) {
      hash = ((hash << 5) + hash + token.charCodeAt(index)) | 0;
    }
    const dimension = Math.abs(hash) % EMBEDDING_VECTOR_DIMENSIONS;
    vector[dimension] = (vector[dimension] ?? 0) + 1;
  }
  return vector;
};

function findLessonIdByBody(connection: SqliteConnection, body: string): string {
  const row = connection.database
    .query<{ lesson_id: string }, [string]>("SELECT lesson_id FROM lesson_versions WHERE body = ?")
    .get(body);
  if (row === undefined || row === null) {
    throw new Error(`No approved lesson found for body: ${body}`);
  }
  return row.lesson_id;
}

const connection = openSqliteConnection(databasePath);
let hooks: Hooks | undefined;

try {
  migrateSqliteSchema(connection, releaseSchemaMigrations);

  if (mode === "seed") {
    const { project } = resolveProjectIdentity(connection, {
      projectPath: LESSON_ISOLATION_PROJECT_ALPHA_PATH,
    });
    hooks = composePluginHooks({
      connection,
      config: createDefaultConfig(),
      projectId: project.id,
      compatibility: { status: "supported", version: "1.18.27" },
      diagnosticsPath,
      createLessonEmbedder: async () => embed,
    });
    const propose = hooks.tool?.swe_factory_propose_lesson;
    const commit = hooks.tool?.swe_factory_commit_lesson;
    if (propose === undefined || commit === undefined) {
      throw new Error("Lesson approval tools are not registered.");
    }

    const approve = async (
      scope: "project" | "global",
      lesson: { title: string; body: string; rationale: string },
    ): Promise<void> => {
      const approvalCard = textOf(
        await propose.execute({ ...lesson, scope }, createToolContext("isolation-seed")),
      );
      const candidateId = approvalCard.match(/^Candidate ID: (.+)$/m)?.[1];
      if (candidateId === undefined) {
        throw new Error(`Proposal did not return a candidate ID:\n${approvalCard}`);
      }
      const commitResult = textOf(
        await commit.execute({ candidateId, decision: "approve" }, createToolContext("isolation-seed")),
      );
      if (commitResult !== "Lesson approved successfully.") {
        throw new Error(commitResult);
      }
    };

    await approve("project", {
      title: SUPERSEDED_LESSON.v1Title,
      body: SUPERSEDED_LESSON.v1Body,
      rationale: SUPERSEDED_LESSON.rationale,
    });
    await approve("project", CONFLICT_LESSONS[0]);
    await approve("project", CONFLICT_LESSONS[1]);
    await approve("global", GLOBAL_LESSON);

    // The plugin schedules its own background index run after each commit;
    // wait for it instead of racing it with a manual indexing call.
    const vectorCount = (): number =>
      connection.database.query<{ count: number }, []>(
        "SELECT count(*) AS count FROM lesson_version_embeddings",
      ).get()?.count ?? 0;
    const indexingDeadline = Date.now() + 5000;
    while (vectorCount() < 4 && Date.now() < indexingDeadline) {
      await Bun.sleep(10);
    }
    if (vectorCount() !== 4) {
      throw new Error(
        `Approved lessons were not indexed by the plugin: ${vectorCount()} vector row(s).`,
      );
    }

    console.log(JSON.stringify({
      status: "seeded",
      supersededLessonId: findLessonIdByBody(connection, SUPERSEDED_LESSON.v1Body),
      globalLessonId: findLessonIdByBody(connection, GLOBAL_LESSON.body),
      conflictLessonIds: CONFLICT_LESSONS.map((lesson) => findLessonIdByBody(connection, lesson.body)),
    }));
  } else if (mode === "supersede") {
    const result = supersedeLesson(connection, {
      lessonId: projectPathOrLessonId as string,
      draft: {
        title: SUPERSEDED_LESSON.v2Title,
        body: SUPERSEDED_LESSON.v2Body,
        rationale: SUPERSEDED_LESSON.rationale,
        applicability: {},
        provenance: {},
      },
    });
    if (result.supersededVersion !== 1 || result.version !== 2 || result.activeVersion !== 2) {
      throw new Error(`Unexpected supersession result: ${JSON.stringify(result)}`);
    }
    const indexing = await indexConfirmedLessonEmbeddings(connection, { embed });
    if (indexing.embeddedCount !== 1 || indexing.failures.length !== 0) {
      throw new Error(`Superseded lesson version was not indexed: ${JSON.stringify(indexing)}`);
    }
    console.log(JSON.stringify({
      status: "superseded",
      supersededVersion: result.supersededVersion,
      version: result.version,
      activeVersion: result.activeVersion,
    }));
  } else {
    const { project } = resolveProjectIdentity(connection, {
      projectPath: projectPathOrLessonId as string,
    });
    hooks = composePluginHooks({
      connection,
      config: createDefaultConfig(),
      projectId: project.id,
      compatibility: { status: "supported", version: "1.18.27" },
      diagnosticsPath,
      createLessonEmbedder: async () => embed,
    });

    const hybrid = await retrieveConfirmedLessonsHybrid(connection, {
      projectId: project.id,
      query: query as string,
      embed,
    });
    const suppression = suppressConflictingLessons({ results: hybrid.lessons });

    const chatMessage = hooks["chat.message"] as ChatMessageHook;
    // The first guarded message starts the plugin's lazy local embedder.
    const warmup = chatInput("isolation-warmup", "Initialize local meaning search.", "warmup-message");
    await chatMessage(warmup.input, warmup.output);
    await Promise.resolve();

    const recall = chatInput("isolation-recall", query as string, "recall-message");
    await chatMessage(recall.input, recall.output);
    const system = ["You are a coding agent."];
    const transform = hooks["experimental.chat.system.transform"] as SystemTransformHook;
    await transform(createSystemTransformInputFixture("isolation-recall"), { system });

    console.log(JSON.stringify({
      status: "recalled",
      semanticStatus: hybrid.semantic.status,
      retrieved: hybrid.lessons.map((lesson) => ({
        lessonId: lesson.lessonId,
        version: lesson.version,
        scope: lesson.scope,
        body: lesson.body,
        lexicalRank: lesson.lexicalRank,
        semanticRank: lesson.semanticRank,
      })),
      suppressed: suppression.suppressed.map((entry) => ({
        lessonId: entry.lessonId,
        conflictsWith: entry.conflictsWith,
      })),
      system: system[0],
    }));
  }

  await hooks?.dispose?.();
} finally {
  if (!connection.isClosed) {
    connection.close();
  }
}
