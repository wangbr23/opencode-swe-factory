import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LessonSemanticRetrievalError,
  indexConfirmedLessonEmbeddings,
  migrateSqliteSchema,
  openSqliteConnection,
  releaseSchemaMigrations,
  retrieveConfirmedLessonsSemantically,
  supersedeLesson,
  type EmbedLessonTextFn,
  type SqliteConnection,
} from "../src/core/index.js";
import { EMBEDDING_VECTOR_DIMENSIONS } from "../src/types/embedding-types.js";
import { PINNED_EMBEDDING_MODEL_ID, PINNED_EMBEDDING_MODEL_REVISION } from "../src/core/embedding-artifact-manifest.js";

const NOW = new Date("2026-09-06T00:00:00.000Z");
const NOW_ISO = NOW.toISOString();

async function withDatabase(run: (connection: SqliteConnection) => Promise<void> | void): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-lesson-semantic-"));
  const connection = openSqliteConnection(join(directory, "memory.sqlite"));
  migrateSqliteSchema(connection, releaseSchemaMigrations);
  try {
    await run(connection);
  } finally {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function insertProject(connection: SqliteConnection, projectId: string): void {
  connection.database.run("INSERT INTO projects (id, path, created_at, updated_at) VALUES (?, ?, ?, ?)", [
    projectId,
    `/repos/${projectId}`,
    NOW_ISO,
    NOW_ISO,
  ]);
}

function insertLesson(
  connection: SqliteConnection,
  input: Readonly<{
    id: string;
    scope: "project" | "global";
    projectId: string | null;
    title: string;
    body: string;
  }>,
): void {
  connection.database.run(
    "INSERT INTO lessons (id, project_id, scope, active_version, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
    [input.id, input.projectId, input.scope, NOW_ISO, NOW_ISO],
  );
  connection.database.run(
    "INSERT INTO lesson_versions (lesson_id, version, title, body, rationale, applicability_json, provenance_json, created_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?)",
    [
      input.id,
      input.title,
      input.body,
      `Rationale for ${input.id}`,
      JSON.stringify({ activity: "test" }),
      JSON.stringify({ source: "correction" }),
      NOW_ISO,
    ],
  );
}

/**
 * Maps text to an axis-aligned unit vector: alpha lessons live on axis 0, beta
 * on axis 1, everything else on axis 2. Same-axis texts have similarity 1,
 * different-axis texts 0, and a two-axis mix ~0.707 with each.
 */
function axisEmbedding(text: string): Float32Array {
  const vector = new Float32Array(EMBEDDING_VECTOR_DIMENSIONS);
  const axis = text.includes("alpha") ? 0 : text.includes("beta") ? 1 : 2;
  vector[axis] = 1;
  return vector;
}

const embedAxis: EmbedLessonTextFn = (text) => Promise.resolve(axisEmbedding(text));

function createEmbed(overrides: Readonly<Record<string, (text: string) => Promise<Float32Array>>> = {}): {
  embed: EmbedLessonTextFn;
  texts: string[];
} {
  const texts: string[] = [];
  return {
    texts,
    embed: async (text: string) => {
      texts.push(text);
      const override = overrides[text];
      if (override !== undefined) {
        return override(text);
      }
      return axisEmbedding(text);
    },
  };
}

async function seedLessons(connection: SqliteConnection): Promise<void> {
  insertProject(connection, "project-a");
  insertProject(connection, "project-b");
  insertLesson(connection, {
    id: "global-alpha",
    scope: "global",
    projectId: null,
    title: "alpha rule",
    body: "alpha body",
  });
  insertLesson(connection, {
    id: "global-gamma",
    scope: "global",
    projectId: null,
    title: "gamma rule",
    body: "gamma body",
  });
  insertLesson(connection, {
    id: "project-beta",
    scope: "project",
    projectId: "project-a",
    title: "beta rule",
    body: "beta body",
  });
  insertLesson(connection, {
    id: "project-other",
    scope: "project",
    projectId: "project-b",
    title: "gamma rule",
    body: "gamma body",
  });
  await indexConfirmedLessonEmbeddings(connection, { embed: embedAxis, now: NOW });
}

test("ranks by exact cosine similarity with project-over-global precedence", async () => {
  await withDatabase(async (connection) => {
    await seedLessons(connection);

    const exact = await retrieveConfirmedLessonsSemantically(connection, {
      projectId: "project-a",
      query: "beta rule",
      embed: embedAxis,
    });
    expect(exact).toHaveLength(3);
    expect(exact[0]?.lessonId).toBe("project-beta");
    expect(exact[0]?.scope).toBe("project");
    expect(exact[0]?.similarity).toBeCloseTo(1, 6);
    expect(exact[0]?.semanticRank).toBe(1);
    expect(exact.slice(1).map((lesson) => lesson.lessonId)).toEqual(["global-alpha", "global-gamma"]);
    for (const lower of exact.slice(1)) {
      expect(lower.similarity).toBeCloseTo(0, 6);
      expect(lower.scope).toBe("global");
    }

    const mixed = await retrieveConfirmedLessonsSemantically(connection, {
      projectId: "project-a",
      query: "mixed alpha beta query",
      embed: async () => {
        const vector = new Float32Array(EMBEDDING_VECTOR_DIMENSIONS);
        vector[0] = 0.5;
        vector[1] = 0.5;
        return vector;
      },
    });
    expect(mixed.map((lesson) => lesson.lessonId)).toEqual(["project-beta", "global-alpha", "global-gamma"]);
    expect(mixed[0]?.similarity).toBeCloseTo(mixed[1]?.similarity ?? 0, 6);
    expect(mixed[2]?.similarity).toBeCloseTo(0, 6);
  });
});

test("keeps other projects' lessons out of the result set", async () => {
  await withDatabase(async (connection) => {
    await seedLessons(connection);

    const results = await retrieveConfirmedLessonsSemantically(connection, {
      projectId: "project-a",
      query: "gamma rule",
      embed: embedAxis,
    });
    expect(results.map((lesson) => lesson.lessonId)).toEqual(["project-beta", "global-gamma", "global-alpha"]);
    expect(results.map((lesson) => lesson.lessonId)).not.toContain("project-other");
    const projectBeta = results.find((lesson) => lesson.lessonId === "project-beta");
    const globalGamma = results.find((lesson) => lesson.lessonId === "global-gamma");
    expect(projectBeta?.similarity).toBeCloseTo(0, 6);
    expect(globalGamma?.similarity).toBeCloseTo(1, 6);
  });
});

test("retrieves full lesson metadata on each result", async () => {
  await withDatabase(async (connection) => {
    await seedLessons(connection);

    const [result] = await retrieveConfirmedLessonsSemantically(connection, {
      projectId: "project-a",
      query: "beta rule",
      embed: embedAxis,
    });
    expect(result).toMatchObject({
      lessonId: "project-beta",
      version: 1,
      projectId: "project-a",
      scope: "project",
      title: "beta rule",
      body: "beta body",
      rationale: "Rationale for project-beta",
      applicability: { activity: "test" },
      provenance: { source: "correction" },
      createdAt: NOW_ISO,
    });
  });
});

test("excludes superseded versions after re-indexing", async () => {
  await withDatabase(async (connection) => {
    insertLesson(connection, {
      id: "lesson-a",
      scope: "global",
      projectId: null,
      title: "alpha rule",
      body: "alpha body",
    });
    await indexConfirmedLessonEmbeddings(connection, { embed: embedAxis, now: NOW });

    supersedeLesson(connection, {
      lessonId: "lesson-a",
      draft: {
        title: "gamma rule",
        body: "gamma body",
        rationale: "Superseded with corrected guidance",
        applicability: {},
        provenance: { source: "correction" },
      },
      now: NOW,
    });
    await indexConfirmedLessonEmbeddings(connection, { embed: embedAxis, now: NOW });

    const results = await retrieveConfirmedLessonsSemantically(connection, {
      projectId: "project-a",
      query: "gamma rule",
      embed: embedAxis,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.version).toBe(2);
    expect(results[0]?.title).toBe("gamma rule");
  });
});

test("only matches vectors for the requested model and revision", async () => {
  await withDatabase(async (connection) => {
    insertLesson(connection, {
      id: "lesson-a",
      scope: "global",
      projectId: null,
      title: "alpha rule",
      body: "alpha body",
    });
    await indexConfirmedLessonEmbeddings(connection, { embed: embedAxis, revision: "rev-1", now: NOW });

    await expect(
      retrieveConfirmedLessonsSemantically(connection, {
        projectId: "project-a",
        query: "alpha rule",
        embed: embedAxis,
        revision: "rev-2",
      }),
    ).resolves.toEqual([]);

    const results = await retrieveConfirmedLessonsSemantically(connection, {
      projectId: "project-a",
      query: "alpha rule",
      embed: embedAxis,
      revision: "rev-1",
    });
    expect(results.map((lesson) => lesson.lessonId)).toEqual(["lesson-a"]);
  });
});

test("uses the pinned model and revision by default", async () => {
  await withDatabase(async (connection) => {
    await seedLessons(connection);
    const { embed, texts } = createEmbed();
    await retrieveConfirmedLessonsSemantically(connection, { projectId: "project-a", query: "beta rule", embed });
    expect(texts).toEqual(["beta rule"]);

    const results = await retrieveConfirmedLessonsSemantically(connection, {
      projectId: "project-a",
      query: "beta rule",
      embed: embedAxis,
      model: "other-model",
    });
    expect(results).toEqual([]);
    expect(PINNED_EMBEDDING_MODEL_ID).toBeTruthy();
    expect(PINNED_EMBEDDING_MODEL_REVISION).toBeTruthy();
  });
});

test("returns an empty list for empty or whitespace queries without embedding", async () => {
  await withDatabase(async (connection) => {
    await seedLessons(connection);
    const { embed, texts } = createEmbed();

    await expect(
      retrieveConfirmedLessonsSemantically(connection, { projectId: "project-a", query: "", embed }),
    ).resolves.toEqual([]);
    await expect(
      retrieveConfirmedLessonsSemantically(connection, { projectId: "project-a", query: "   ", embed }),
    ).resolves.toEqual([]);
    expect(texts).toEqual([]);
  });
});

test("treats zero-magnitude vectors as zero similarity instead of NaN", async () => {
  await withDatabase(async (connection) => {
    insertLesson(connection, {
      id: "lesson-zero",
      scope: "global",
      projectId: null,
      title: "alpha rule",
      body: "alpha body",
    });
    await indexConfirmedLessonEmbeddings(connection, {
      embed: async () => new Float32Array(EMBEDDING_VECTOR_DIMENSIONS),
      now: NOW,
    });

    const results = await retrieveConfirmedLessonsSemantically(connection, {
      projectId: "project-a",
      query: "alpha rule",
      embed: embedAxis,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.similarity).toBe(0);
    expect(Number.isFinite(results[0]?.similarity ?? Number.NaN)).toBe(true);
  });
});

test("breaks similarity ties by lesson id", async () => {
  await withDatabase(async (connection) => {
    insertLesson(connection, {
      id: "lesson-b",
      scope: "global",
      projectId: null,
      title: "alpha rule",
      body: "alpha body",
    });
    insertLesson(connection, {
      id: "lesson-a",
      scope: "global",
      projectId: null,
      title: "alpha rule",
      body: "alpha body",
    });
    await indexConfirmedLessonEmbeddings(connection, { embed: embedAxis, now: NOW });

    const results = await retrieveConfirmedLessonsSemantically(connection, {
      projectId: "project-a",
      query: "alpha rule",
      embed: embedAxis,
    });
    expect(results.map((lesson) => lesson.lessonId)).toEqual(["lesson-a", "lesson-b"]);
    expect(results[0]?.semanticRank).toBe(1);
    expect(results[1]?.semanticRank).toBe(2);
  });
});

test("respects the limit after ranking", async () => {
  await withDatabase(async (connection) => {
    await seedLessons(connection);

    const results = await retrieveConfirmedLessonsSemantically(connection, {
      projectId: "project-a",
      query: "beta rule",
      embed: embedAxis,
      limit: 1,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.lessonId).toBe("project-beta");
  });
});

test("rejects query embeddings with wrong dimensions or non-finite components", async () => {
  await withDatabase(async (connection) => {
    await seedLessons(connection);

    await expect(
      retrieveConfirmedLessonsSemantically(connection, {
        projectId: "project-a",
        query: "beta rule",
        embed: async () => new Float32Array(3),
      }),
    ).rejects.toThrow(/dimensions/);

    await expect(
      retrieveConfirmedLessonsSemantically(connection, {
        projectId: "project-a",
        query: "beta rule",
        embed: async () => {
          const vector = new Float32Array(EMBEDDING_VECTOR_DIMENSIONS);
          vector[0] = Number.NaN;
          return vector;
        },
      }),
    ).rejects.toThrow(/non-finite/);
  });
});

test("rejects invalid inputs", async () => {
  await withDatabase(async (connection) => {
    await seedLessons(connection);

    await expect(
      retrieveConfirmedLessonsSemantically(connection, { projectId: "", query: "beta rule", embed: embedAxis }),
    ).rejects.toThrow(LessonSemanticRetrievalError);
    await expect(
      retrieveConfirmedLessonsSemantically(connection, {
        projectId: "project-a",
        query: 42 as unknown as string,
        embed: embedAxis,
      }),
    ).rejects.toThrow(LessonSemanticRetrievalError);
    for (const limit of [0, -1, 101, 1.5]) {
      await expect(
        retrieveConfirmedLessonsSemantically(connection, {
          projectId: "project-a",
          query: "beta rule",
          embed: embedAxis,
          limit,
        }),
      ).rejects.toThrow(LessonSemanticRetrievalError);
    }
  });
});

test("rejects lessons with non-object stored metadata", async () => {
  await withDatabase(async (connection) => {
    insertLesson(connection, {
      id: "lesson-a",
      scope: "global",
      projectId: null,
      title: "alpha rule",
      body: "alpha body",
    });
    await indexConfirmedLessonEmbeddings(connection, { embed: embedAxis, now: NOW });
    connection.database.run("UPDATE lesson_versions SET applicability_json = '[1]' WHERE lesson_id = 'lesson-a'");

    await expect(
      retrieveConfirmedLessonsSemantically(connection, {
        projectId: "project-a",
        query: "alpha rule",
        embed: embedAxis,
      }),
    ).rejects.toThrow(/applicability/);
  });
});