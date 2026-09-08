import {
  PINNED_EMBEDDING_MODEL_ID,
  PINNED_EMBEDDING_MODEL_REVISION,
} from "../documents/embedding-artifact-manifest.js";
import {
  LESSON_EMBEDDING_TEXT_SEPARATOR,
  LESSON_EMBEDDING_VECTOR_DIMENSIONS,
  MAX_LESSON_EMBEDDING_BATCH,
} from "./lesson-embedding-index-constants.js";
import type { SqliteConnection } from "../db/sqlite.js";
import type {
  EmbedLessonTextFn,
  IndexConfirmedLessonEmbeddingsInput,
  LessonEmbeddingFailure,
  LessonEmbeddingIndexResult,
  LessonEmbeddingIndexer,
  ScheduledLessonEmbeddingIndexResult,
} from "../../types/lesson-embedding-index-types.js";

export type {
  EmbedLessonTextFn,
  IndexConfirmedLessonEmbeddingsInput,
  LessonEmbeddingFailure,
  LessonEmbeddingIndexResult,
  LessonEmbeddingIndexer,
  ScheduledLessonEmbeddingIndexResult,
} from "../../types/lesson-embedding-index-types.js";
export { LESSON_EMBEDDING_TEXT_SEPARATOR, MAX_LESSON_EMBEDDING_BATCH } from "./lesson-embedding-index-constants.js";

export class LessonEmbeddingIndexError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "LessonEmbeddingIndexError";
  }
}

type PendingLessonVersionRow = Readonly<{
  lesson_id: string;
  lesson_version: number;
  title: string;
  body: string;
}>;

type EmbeddingVectorRow = Readonly<{
  lesson_id: string;
  lesson_version: number;
}>;

const SELECT_PENDING_VERSIONS = `
SELECT
  lesson_versions.lesson_id,
  lesson_versions.version AS lesson_version,
  lesson_versions.title,
  lesson_versions.body
FROM lesson_versions
JOIN lessons
  ON lessons.id = lesson_versions.lesson_id
  AND lessons.active_version = lesson_versions.version
WHERE lesson_versions.superseded_by_version IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM lesson_version_embeddings
    WHERE lesson_version_embeddings.lesson_id = lesson_versions.lesson_id
      AND lesson_version_embeddings.lesson_version = lesson_versions.version
      AND lesson_version_embeddings.model = ?
      AND lesson_version_embeddings.revision = ?
  )
ORDER BY lesson_versions.lesson_id ASC, lesson_versions.version ASC
LIMIT ?
`;

const COUNT_PENDING_VERSIONS = `
SELECT COUNT(*) AS pending_count
FROM lesson_versions
JOIN lessons
  ON lessons.id = lesson_versions.lesson_id
  AND lessons.active_version = lesson_versions.version
WHERE lesson_versions.superseded_by_version IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM lesson_version_embeddings
    WHERE lesson_version_embeddings.lesson_id = lesson_versions.lesson_id
      AND lesson_version_embeddings.lesson_version = lesson_versions.version
      AND lesson_version_embeddings.model = ?
      AND lesson_version_embeddings.revision = ?
  )
`;

const COUNT_CURRENT_VERSIONS = `
SELECT COUNT(*) AS current_count
FROM lesson_version_embeddings
JOIN lessons
  ON lessons.id = lesson_version_embeddings.lesson_id
  AND lessons.active_version = lesson_version_embeddings.lesson_version
WHERE lesson_version_embeddings.model = ?
  AND lesson_version_embeddings.revision = ?
`;

const DELETE_STALE_REVISION_VECTORS = `
DELETE FROM lesson_version_embeddings
WHERE model <> ? OR revision <> ?
`;

const DELETE_NON_ACTIVE_VERSION_VECTORS = `
DELETE FROM lesson_version_embeddings
WHERE NOT EXISTS (
  SELECT 1
  FROM lessons
  WHERE lessons.id = lesson_version_embeddings.lesson_id
    AND lessons.active_version = lesson_version_embeddings.lesson_version
)
`;

const INSERT_EMBEDDING = `
INSERT INTO lesson_version_embeddings (lesson_id, lesson_version, model, revision, dimensions, vector, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
`;

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new LessonEmbeddingIndexError(`${label} must be a non-empty string.`);
  }
  return value;
}

function validateVector(vector: Float32Array, lessonId: string, lessonVersion: number): Float32Array {
  if (vector.length !== LESSON_EMBEDDING_VECTOR_DIMENSIONS) {
    throw new LessonEmbeddingIndexError(
      `Embedding for lesson ${lessonId} version ${lessonVersion} has ${vector.length} dimensions; expected ${LESSON_EMBEDDING_VECTOR_DIMENSIONS}.`,
    );
  }
  for (const component of vector) {
    if (!Number.isFinite(component)) {
      throw new LessonEmbeddingIndexError(
        `Embedding for lesson ${lessonId} version ${lessonVersion} contains a non-finite component.`,
      );
    }
  }
  return vector;
}

function vectorToBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

function listPendingLessonVersions(
  connection: SqliteConnection,
  model: string,
  revision: string,
): ReadonlyArray<PendingLessonVersionRow> {
  return connection.database
    .query<PendingLessonVersionRow, [string, string, number]>(SELECT_PENDING_VERSIONS)
    .all(model, revision, MAX_LESSON_EMBEDDING_BATCH);
}

function countPendingLessonVersions(connection: SqliteConnection, model: string, revision: string): number {
  const row = connection.database
    .query<Readonly<{ pending_count: number }>, [string, string]>(COUNT_PENDING_VERSIONS)
    .get(model, revision);
  return row?.pending_count ?? 0;
}

function countCurrentLessonVersions(connection: SqliteConnection, model: string, revision: string): number {
  const row = connection.database
    .query<Readonly<{ current_count: number }>, [string, string]>(COUNT_CURRENT_VERSIONS)
    .get(model, revision);
  return row?.current_count ?? 0;
}

async function embedLessonVersion(
  embed: EmbedLessonTextFn,
  row: PendingLessonVersionRow,
): Promise<Float32Array> {
  const text = `${row.title}${LESSON_EMBEDDING_TEXT_SEPARATOR}${row.body}`;
  let vector: Float32Array;
  try {
    vector = await embed(text);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new LessonEmbeddingIndexError(
      `Embedding lesson ${row.lesson_id} version ${row.lesson_version} failed: ${detail}`,
      { cause },
    );
  }
  return validateVector(vector, row.lesson_id, row.lesson_version);
}

/**
 * Embeds active confirmed lesson versions that are missing a vector for the
 * current (model, revision), then prunes vectors for stale revisions and
 * non-active versions inside the same transaction. Embedding is injectable so
 * indexing never initiates downloads and tests run network-free; callers that
 * construct a real local embedder are responsible for artifact verification.
 */
export async function indexConfirmedLessonEmbeddings(
  connection: SqliteConnection,
  input: IndexConfirmedLessonEmbeddingsInput,
): Promise<LessonEmbeddingIndexResult> {
  const model = input.model ?? PINNED_EMBEDDING_MODEL_ID;
  const revision = input.revision ?? PINNED_EMBEDDING_MODEL_REVISION;
  requireNonEmptyString(model, "model");
  requireNonEmptyString(revision, "revision");
  const createdAt = (input.now ?? new Date()).toISOString();

  const pendingTotal = countPendingLessonVersions(connection, model, revision);
  const pending = listPendingLessonVersions(connection, model, revision);
  const embeddedRows: Array<{ row: PendingLessonVersionRow; vector: Float32Array }> = [];
  const failures: LessonEmbeddingFailure[] = [];

  for (const row of pending) {
    try {
      const vector = await embedLessonVersion(input.embed, row);
      embeddedRows.push({ row, vector });
    } catch (error) {
      failures.push({
        lessonId: row.lesson_id,
        lessonVersion: row.lesson_version,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const skippedCount = countCurrentLessonVersions(connection, model, revision);

  const prunedCount = connection.database.transaction(() => {
    const staleRevisions = connection.database.run(DELETE_STALE_REVISION_VECTORS, [model, revision]).changes;
    const nonActiveVersions = connection.database.run(DELETE_NON_ACTIVE_VERSION_VECTORS).changes;
    for (const { row, vector } of embeddedRows) {
      connection.database.run(INSERT_EMBEDDING, [
        row.lesson_id,
        row.lesson_version,
        model,
        revision,
        LESSON_EMBEDDING_VECTOR_DIMENSIONS,
        vectorToBlob(vector),
        createdAt,
      ]);
    }
    return staleRevisions + nonActiveVersions;
  })();

  return {
    model,
    revision,
    embeddedCount: embeddedRows.length,
    skippedCount,
    prunedCount,
    failures,
    remainingCount: pendingTotal - embeddedRows.length,
  };}

/**
 * Creates a fail-open background indexer over one SQLite connection. Runs are
 * serialized: a `run` or `schedule` call during an in-flight run joins that
 * run instead of starting a second one.
 */
export function createLessonEmbeddingIndexer(
  connection: SqliteConnection,
  input: IndexConfirmedLessonEmbeddingsInput,
): LessonEmbeddingIndexer {
  let inFlight: Promise<LessonEmbeddingIndexResult> | null = null;

  const run = (): Promise<LessonEmbeddingIndexResult> => {
    if (inFlight !== null) {
      return inFlight;
    }
    const task = indexConfirmedLessonEmbeddings(connection, input).finally(() => {
      inFlight = null;
    });
    inFlight = task;
    return task;
  };

  const schedule = async (): Promise<ScheduledLessonEmbeddingIndexResult> => {
    try {
      return { outcome: "indexed", result: await run() };
    } catch (error) {
      return {
        outcome: "failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };

  return { run, schedule };
}
