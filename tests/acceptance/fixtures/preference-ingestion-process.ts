import type { Hooks } from "@opencode-ai/plugin";
import {
  createDefaultConfig,
  migrateSqliteSchema,
  openSqliteConnection,
  releaseSchemaMigrations,
  resolveProjectIdentity,
  type SqliteConnection,
} from "../../../src/core/index.js";
import { composePluginHooks } from "../../../src/opencode/plugin.js";
import { createToolContext, textOf } from "../../opencode/fixtures.js";
import {
  BLOCKED_PREFERENCE,
  NEAR_DUPLICATE_PREFERENCE,
  PREFERENCE_INGESTION_PROJECT_PATH,
  PREFERENCE_LESSON,
  REPLACED_PREFERENCE,
} from "./preference-ingestion-values.js";

const mode = process.argv[2];
const databasePath = process.argv[3];
const diagnosticsPath = process.argv[4];

const usage = "Usage: preference-ingestion-process.ts preference <db> <diag>";
if (mode !== "preference" || databasePath === undefined || diagnosticsPath === undefined) {
  throw new Error(usage);
}

const RECORDING_TABLES = ["lessons", "lesson_versions", "pending_lesson_candidates"] as const;

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

function extractCandidateId(card: string): string {
  const candidateId = card.match(/^Candidate ID: (.+)$/m)?.[1];
  if (candidateId === undefined) {
    throw new Error(`Proposal did not return a candidate ID:\n${card}`);
  }
  return candidateId;
}

async function propose(
  hooks: Hooks,
  lesson: { title: string; body: string; rationale: string },
  scope: "global" | "project",
): Promise<{ card: string; candidateId: string }> {
  const tool = hooks.tool?.swe_factory_propose_lesson;
  if (tool === undefined) {
    throw new Error("Lesson proposal tool is not registered.");
  }
  const card = textOf(
    await tool.execute({ ...lesson, scope }, createToolContext("preference-session")),
  );
  return { card, candidateId: extractCandidateId(card) };
}

async function commit(
  hooks: Hooks,
  candidateId: string,
  decision: "approve" | "reject",
): Promise<string> {
  const tool = hooks.tool?.swe_factory_commit_lesson;
  if (tool === undefined) {
    throw new Error("Lesson commit tool is not registered.");
  }
  return textOf(
    await tool.execute({ candidateId, decision }, createToolContext("preference-session")),
  );
}

const connection = openSqliteConnection(databasePath);
let hooks: Hooks | undefined;

try {
  migrateSqliteSchema(connection, releaseSchemaMigrations);

  if (mode === "preference") {
    const { project } = resolveProjectIdentity(connection, {
      projectPath: PREFERENCE_INGESTION_PROJECT_PATH,
    });
    hooks = composePluginHooks({
      connection,
      config: createDefaultConfig(),
      projectId: project.id,
      compatibility: { status: "supported", version: "1.18.27" },
      diagnosticsPath,
    });

    const original = await propose(hooks, PREFERENCE_LESSON, "global");
    const replacement = await propose(hooks, REPLACED_PREFERENCE, "project");
    const replacementApproved = await commit(hooks, replacement.candidateId, "approve");

    const duplicate = await propose(hooks, NEAR_DUPLICATE_PREFERENCE, "global");
    const duplicateApproved = await commit(hooks, duplicate.candidateId, "approve");

    const proposeTool = hooks.tool?.swe_factory_propose_lesson;
    if (proposeTool === undefined) {
      throw new Error("Lesson proposal tool is not registered.");
    }
    const blockedCard = textOf(
      await proposeTool.execute(
        { ...BLOCKED_PREFERENCE, scope: "global" },
        createToolContext("preference-session"),
      ),
    );

    const rejected = await commit(hooks, original.candidateId, "reject");

    console.log(JSON.stringify({
      status: "preference-ingested",
      originalCard: original.card,
      replacementCard: replacement.card,
      replacementApproved,
      duplicateCard: duplicate.card,
      duplicateApproved,
      blockedCard,
      rejected,
      projectId: project.id,
      counts: countRows(connection),
    }));
  } else {
    throw new Error(usage);
  }

  await hooks?.dispose?.();
} finally {
  if (!connection.isClosed) {
    connection.close();
  }
}
