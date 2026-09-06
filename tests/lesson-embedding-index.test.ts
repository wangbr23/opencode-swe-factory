import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LESSON_EMBEDDING_TEXT_SEPARATOR,
  LessonEmbeddingIndexError,
  MAX_LESSON_EMBEDDING_BATCH,
  createLessonEmbeddingIndexer,
  indexConfirmedLessonEmbeddings,
  migrateSqliteSchema,
  openSqliteConnection,
  releaseSchemaMigrations,
  supersedeLesson,
  type EmbedLessonTextFn,
  type SqliteConnection,
} from "../src/core/index.js";
import { EMBEDDING_VECTOR_DIMENSIONS } from "../src/types/embedding-types.js";
import { PINNED_EMBEDDING_MODEL_ID, PINNED_EMBEDDING_MODEL_REVISION } from "../src/core/embedding-artifact-manifest.js";

const NOW = new Date("2026-09-06T00:00:00.000Z");
const NOW_ISO = NOW.toISOString();

async function withDatabase(run: (connection: SqliteConnection) => Promise<void> | void): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-lesson-embedding-index-"));
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

function deterministicEmbedding(text: string): Float32Array {
  let seed = text.length;
  return Float32Array.from({ length: EMBEDDING_VECTOR_DIMENSIONS }, (_, index) => {
    seed = (seed * 31 + index + text.charCodeAt(index % text.length)) % 97;
    return seed / 97;
  });
}

function createRecordingEmbed(
  overrides: Readonly<Record<string, (text: string) => Promise<Float32Array>>> = {},
): { embed: EmbedLessonTextFn; texts: string[] } {
  const texts: string[] = [];
  return {
    texts,
    embed: async (text: string) => {
      texts.push(text);
      const override = overrides[text];
      if (override !== undefined) {
        return override(text);
      }
      return deterministicEmbedding(text);
    },
  };
}

type EmbeddingRow = Readonly<{
  lesson_id: string;
  lesson_version: number;
  model: string;
  revision: string;
  dimensions: number;
  vector: Uint8Array;
  created_at: string;
}>;

function listEmbeddingRows(connection: SqliteConnection): EmbeddingRow[] {
  return connection.database
    .query<EmbeddingRow, []>(
      `SELECT lesson_id, lesson_version, model, revision, dimensions, vector, created_at
       FROM lesson_version_embeddings
       ORDER BY lesson_id ASC, lesson_version ASC`,
    )
    .all();
}

function blobToFloat32(blob: Uint8Array): Float32Array {
  return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
}

test("indexes active confirmed lesson versions using title and body text", async () => {
  await withDatabase(async (connection) => {
    insertProject(connection, "project-a");
    insertLesson(connection, {
      id: "global-lesson",
      scope: "global",
      projectId: null,
      title: "Verify rollback behavior",
      body: "Run migration rollback tests before release.",
    });
    insertLesson(connection, {
      id: "project-lesson",
      scope: "project",
      projectId: "project-a",
      title: "Use the fixture loader",
      body: "Load fixtures through the repository loader.",
    });

    const { embed, texts } = createRecordingEmbed();
    const result = await indexConfirmedLessonEmbeddings(connection, { embed, now: NOW });

    expect(result).toEqual({
      model: PINNED_EMBEDDING_MODEL_ID,
      revision: PINNED_EMBEDDING_MODEL_REVISION,
      embeddedCount: 2,
      skippedCount: 0,
      prunedCount: 0,
      remainingCount: 0,
      failures: [],
    });
    expect(texts).toEqual([
      `Verify rollback behavior${LESSON_EMBEDDING_TEXT_SEPARATOR}Run migration rollback tests before release.`,
      `Use the fixture loader${LESSON_EMBEDDING_TEXT_SEPARATOR}Load fixtures through the repository loader.`,
    ]);

    const expectedVectorByLessonId = new Map<string, Float32Array>([
      ["global-lesson", deterministicEmbedding(texts[0] ?? "")],
      ["project-lesson", deterministicEmbedding(texts[1] ?? "")],
    ]);
    const rows = listEmbeddingRows(connection);
    expect(rows.map((row) => row.lesson_id)).toEqual(["global-lesson", "project-lesson"]);
    for (const row of rows) {
      expect(row.model).toBe(PINNED_EMBEDDING_MODEL_ID);
      expect(row.revision).toBe(PINNED_EMBEDDING_MODEL_REVISION);
      expect(row.dimensions).toBe(EMBEDDING_VECTOR_DIMENSIONS);
      expect(row.created_at).toBe(NOW_ISO);
      const expected = expectedVectorByLessonId.get(row.lesson_id);
      expect(expected).toBeDefined();
      expect(Array.from(blobToFloat32(row.vector))).toEqual(Array.from(expected ?? new Float32Array()));
    }
  });
});

test("skips versions that already have a vector for the current model and revision", async () => {
  await withDatabase(async (connection) => {
    insertLesson(connection, {
      id: "lesson-a",
      scope: "global",
      projectId: null,
      title: "Title A",
      body: "Body A",
    });

    const first = createRecordingEmbed();
    await indexConfirmedLessonEmbeddings(connection, { embed: first.embed, now: NOW });
    expect(first.texts).toHaveLength(1);

    const second = createRecordingEmbed();
    const result = await indexConfirmedLessonEmbeddings(connection, { embed: second.embed, now: NOW });
    expect(second.texts).toHaveLength(0);
    expect(result.embeddedCount).toBe(0);
    expect(result.skippedCount).toBe(1);
    expect(result.remainingCount).toBe(0);
    expect(result.failures).toEqual([]);
  });
});

test("re-embeds under a new revision and prunes stale-revision vectors", async () => {
  await withDatabase(async (connection) => {
    insertLesson(connection, {
      id: "lesson-a",
      scope: "global",
      projectId: null,
      title: "Title A",
      body: "Body A",
    });

    await indexConfirmedLessonEmbeddings(connection, { embed: createRecordingEmbed().embed, revision: "rev-1" });
    expect(listEmbeddingRows(connection).map((row) => row.revision)).toEqual(["rev-1"]);

    const result = await indexConfirmedLessonEmbeddings(connection, {
      embed: createRecordingEmbed().embed,
      revision: "rev-2",
    });
    expect(result.embeddedCount).toBe(1);
    expect(result.prunedCount).toBe(1);
    expect(result.skippedCount).toBe(0);

    const rows = listEmbeddingRows(connection);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revision).toBe("rev-2");
  });
});

test("removes vectors for non-active versions after supersession", async () => {
  await withDatabase(async (connection) => {
    insertLesson(connection, {
      id: "lesson-a",
      scope: "global",
      projectId: null,
      title: "Old guidance",
      body: "Old body",
    });
    await indexConfirmedLessonEmbeddings(connection, { embed: createRecordingEmbed().embed, now: NOW });
    expect(listEmbeddingRows(connection)).toHaveLength(1);

    supersedeLesson(connection, {
      lessonId: "lesson-a",
      draft: {
        title: "New guidance",
        body: "New body",
        rationale: "Supersede with corrected guidance",
        applicability: {},
        provenance: { source: "correction" },
      },
      now: NOW,
    });

    const result = await indexConfirmedLessonEmbeddings(connection, { embed: createRecordingEmbed().embed, now: NOW });
    expect(result.embeddedCount).toBe(1);
    expect(result.prunedCount).toBe(1);

    const rows = listEmbeddingRows(connection);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lesson_version).toBe(2);
  });
});

test("records per-lesson failures and still indexes the remaining lessons", async () => {
  await withDatabase(async (connection) => {
    insertLesson(connection, {
      id: "lesson-reject",
      scope: "global",
      projectId: null,
      title: "Reject title",
      body: "Reject body",
    });
    insertLesson(connection, {
      id: "lesson-wrong-dimensions",
      scope: "global",
      projectId: null,
      title: "Wrong dimensions title",
      body: "Wrong dimensions body",
    });
    insertLesson(connection, {
      id: "lesson-good",
      scope: "global",
      projectId: null,
      title: "Good title",
      body: "Good body",
    });

    const rejectOverride = async () => {
      throw new Error("embedder unavailable");
    };
    const { embed } = createRecordingEmbed({
      "Reject title\n\nReject body": rejectOverride,
      "Wrong dimensions title\n\nWrong dimensions body": async () => new Float32Array(3),
    });

    const result = await indexConfirmedLessonEmbeddings(connection, { embed, now: NOW });

    expect(result.embeddedCount).toBe(1);
    expect(result.remainingCount).toBe(2);
    expect(result.failures).toHaveLength(2);
    expect(result.failures.map((failure) => failure.lessonId).sort()).toEqual([
      "lesson-reject",
      "lesson-wrong-dimensions",
    ]);
    for (const failure of result.failures) {
      expect(failure.lessonVersion).toBe(1);
      expect(failure.message).toContain(failure.lessonId);
    }

    expect(listEmbeddingRows(connection).map((row) => row.lesson_id)).toEqual(["lesson-good"]);
  });
});

test("refuses empty model or revision identifiers", async () => {
  await withDatabase(async (connection) => {
    await expect(indexConfirmedLessonEmbeddings(connection, { embed: createRecordingEmbed().embed, model: " " })).rejects.toThrow(
      LessonEmbeddingIndexError,
    );
    await expect(indexConfirmedLessonEmbeddings(connection, { embed: createRecordingEmbed().embed, revision: "" })).rejects.toThrow(
      LessonEmbeddingIndexError,
    );
  });
});

test("caps each run and reports the remaining pending versions", async () => {
  await withDatabase(async (connection) => {
    const lessonCount = MAX_LESSON_EMBEDDING_BATCH + 3;
    for (let index = 0; index < lessonCount; index += 1) {
      insertLesson(connection, {
        id: `lesson-${String(index).padStart(4, "0")}`,
        scope: "global",
        projectId: null,
        title: `Title ${index}`,
        body: `Body ${index}`,
      });
    }

    const result = await indexConfirmedLessonEmbeddings(connection, { embed: createRecordingEmbed().embed, now: NOW });
    expect(result.embeddedCount).toBe(MAX_LESSON_EMBEDDING_BATCH);
    expect(result.remainingCount).toBe(3);

    const secondRun = await indexConfirmedLessonEmbeddings(connection, { embed: createRecordingEmbed().embed, now: NOW });
    expect(secondRun.embeddedCount).toBe(3);
    expect(secondRun.remainingCount).toBe(0);
    expect(listEmbeddingRows(connection)).toHaveLength(lessonCount);
  });
});

test("schedule is fail-open and serialized across concurrent calls", async () => {
  await withDatabase(async (connection) => {
    insertLesson(connection, {
      id: "lesson-a",
      scope: "global",
      projectId: null,
      title: "Title A",
      body: "Body A",
    });

    let embedCalls = 0;
    const indexer = createLessonEmbeddingIndexer(connection, {
      embed: async (text) => {
        embedCalls += 1;
        return deterministicEmbedding(text);
      },
      now: NOW,
    });

    const [first, second] = await Promise.all([indexer.schedule(), indexer.schedule()]);
    expect(first.outcome).toBe("indexed");
    expect(second.outcome).toBe("indexed");
    expect(embedCalls).toBe(1);
    if (first.outcome === "indexed" && second.outcome === "indexed") {
      expect(first.result.embeddedCount).toBe(1);
      expect(second.result.embeddedCount).toBe(1);
      expect(listEmbeddingRows(connection)).toHaveLength(1);
    }
  });
});

test("schedule reports failures instead of rejecting", async () => {
  await withDatabase(async (connection) => {
    insertLesson(connection, {
      id: "lesson-a",
      scope: "global",
      projectId: null,
      title: "Title A",
      body: "Body A",
    });

    const indexer = createLessonEmbeddingIndexer(connection, {
      embed: async () => {
        throw new Error("embedder crashed");
      },
      now: NOW,
    });

    const outcome = await indexer.schedule();
    expect(outcome.outcome).toBe("indexed");
    if (outcome.outcome === "indexed") {
      expect(outcome.result.embeddedCount).toBe(0);
      expect(outcome.result.failures[0]?.message).toContain("embedder crashed");
    }

    await connection.close();
    const closedOutcome = await indexer.schedule();
    expect(closedOutcome).toEqual({ outcome: "failed", message: expect.any(String) });
  });
});
