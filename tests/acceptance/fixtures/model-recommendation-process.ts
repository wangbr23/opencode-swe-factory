import {
  createDefaultConfig,
  migrateSqliteSchema,
  openSqliteConnection,
  releaseSchemaMigrations,
  resolveProjectIdentity,
  type ConfigV1,
} from "../../../src/core/index.js";
import { composePluginHooks } from "../../../src/opencode/plugin.js";
import { EVIDENCE_TASK_COUNT } from "./model-recommendation-values.js";
import {
  EVIDENCE_WINNER_MODEL,
  MODEL_RECOMMENDATION_PROJECT_PATH,
  MODEL_RECOMMENDATION_TASK_MESSAGE,
  PRIOR_FAVORITE_MODEL,
} from "./model-recommendation-values.js";

const mode = process.argv[2];
const databasePath = process.argv[3];
const diagnosticsPath = process.argv[4];

if ((mode !== "record" && mode !== "recommend") || databasePath === undefined || diagnosticsPath === undefined) {
  throw new Error(
    "Usage: model-recommendation-process.ts <record|recommend> <database-path> <diagnostics-path>",
  );
}

type ModelIdentity = Readonly<{ provider: string; model: string; variant: string }>;

function configWithRouting(): ConfigV1 {
  const base = createDefaultConfig();
  return {
    ...base,
    routing: {
      ...base.routing,
      allowlist: [PRIOR_FAVORITE_MODEL, EVIDENCE_WINNER_MODEL].map((entry) => ({
        ...entry,
        capabilities: ["toolcall"],
        privacy: "remote" as const,
      })),
      priors: [
        {
          ...PRIOR_FAVORITE_MODEL,
          estimates: { quality: 0.9, reliability: 0.95 },
        },
      ],
    },
  };
}

function chatMessage(
  sessionId: string,
  messageId: string,
  model: ModelIdentity,
  text: string,
) {
  return {
    input: {
      sessionID: sessionId,
      messageID: messageId,
      agent: "build",
      model: { providerID: model.provider, modelID: model.model },
      variant: model.variant,
    },
    output: {
      message: {
        id: messageId,
        sessionID: sessionId,
        role: "user" as const,
        time: { created: 0 },
        agent: "build",
        model: { providerID: model.provider, modelID: model.model },
      },
      parts: [
        {
          id: `part-${messageId}`,
          sessionID: sessionId,
          messageID: messageId,
          type: "text" as const,
          text,
        },
      ],
    },
  };
}

function completionEvent(
  sessionId: string,
  messageId: string,
  model: ModelIdentity,
  startedAtMs: number,
) {
  return {
    type: "message.updated" as const,
    properties: {
      info: {
        id: messageId,
        sessionID: sessionId,
        role: "assistant" as const,
        time: { created: startedAtMs, completed: startedAtMs + 5_000 },
        parentID: `message-${sessionId}`,
        modelID: model.model,
        providerID: model.provider,
        mode: "build",
        path: { cwd: MODEL_RECOMMENDATION_PROJECT_PATH, root: MODEL_RECOMMENDATION_PROJECT_PATH },
        cost: 0.01,
        tokens: { input: 120, output: 80, reasoning: 15, cache: { read: 30, write: 6 } },
        finish: "stop",
      },
    },
  };
}

const connection = openSqliteConnection(databasePath);

try {
  migrateSqliteSchema(connection, releaseSchemaMigrations);
  const { project } = resolveProjectIdentity(connection, {
    projectPath: MODEL_RECOMMENDATION_PROJECT_PATH,
  });
  const hooks = composePluginHooks({
    connection,
    config: configWithRouting(),
    projectId: project.id,
    compatibility: { status: "supported", version: "1.18.27" },
    diagnosticsPath,
  });

  const chatMessageHook = hooks["chat.message"];
  const eventHook = hooks.event;
  const getRecommendation = hooks.tool?.swe_factory_get_recommendation;
  if (chatMessageHook === undefined || getRecommendation === undefined) {
    throw new Error("Routing hooks and tools are not registered.");
  }

  async function lastReceipt(sessionId: string): Promise<Record<string, unknown>> {
    const output = await getRecommendation!.execute({}, {
      sessionID: sessionId,
      messageID: "receipt-message",
      agent: "build",
      directory: MODEL_RECOMMENDATION_PROJECT_PATH,
      worktree: MODEL_RECOMMENDATION_PROJECT_PATH,
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {},
    });
    return JSON.parse(typeof output === "string" ? output : output.output) as Record<string, unknown>;
  }

  if (mode === "record") {
    // Cold start: the prior favorite wins on configured priors alone.
    const cold = chatMessage(
      "cold-session",
      "cold-message",
      PRIOR_FAVORITE_MODEL,
      MODEL_RECOMMENDATION_TASK_MESSAGE,
    );
    await chatMessageHook(cold.input, cold.output);
    const coldReceipt = await lastReceipt("cold-session");
    const coldRecommendation = coldReceipt.recommendation as Record<string, unknown> | null;

    // Record successful executions of the second model on compatible tasks.
    const startedAtMs = Date.now();
    for (let index = 0; index < EVIDENCE_TASK_COUNT; index += 1) {
      const sessionId = `evidence-session-${index}`;
      const message = chatMessage(
        sessionId,
        `evidence-message-${index}`,
        EVIDENCE_WINNER_MODEL,
        MODEL_RECOMMENDATION_TASK_MESSAGE,
      );
      await chatMessageHook(message.input, message.output);
      if (eventHook === undefined) {
        throw new Error("Event hook is not registered.");
      }
      await eventHook({
        event: completionEvent(
          sessionId,
          `assistant-${index}`,
          EVIDENCE_WINNER_MODEL,
          startedAtMs + index * 1_000,
        ),
      });
    }

    const recorded = connection.database
      .query<{ count: number }, [string, string, string]>(
        "SELECT COUNT(*) AS count FROM execution_profiles WHERE provider = ? AND model = ? AND variant = ?",
      )
      .get(EVIDENCE_WINNER_MODEL.provider, EVIDENCE_WINNER_MODEL.model, EVIDENCE_WINNER_MODEL.variant);
    if (recorded?.count !== EVIDENCE_TASK_COUNT) {
      throw new Error(`Expected ${EVIDENCE_TASK_COUNT} recorded executions, got ${recorded?.count}.`);
    }

    console.log(JSON.stringify({
      status: "recorded",
      cold: {
        recommendation: coldRecommendation === null
          ? null
          : {
              provider: coldRecommendation.provider,
              model: coldRecommendation.model,
              variant: coldRecommendation.variant,
            },
        isEvidenceBacked: coldReceipt.isEvidenceBacked,
      },
    }));
  } else {
    const message = chatMessage(
      "recommend-session",
      "recommend-message",
      PRIOR_FAVORITE_MODEL,
      MODEL_RECOMMENDATION_TASK_MESSAGE,
    );
    await chatMessageHook(message.input, message.output);

    console.log(JSON.stringify({
      status: "recommended",
      receipt: await lastReceipt("recommend-session"),
    }));
  }

  await hooks.dispose?.();
} finally {
  if (!connection.isClosed) {
    connection.close();
  }
}
