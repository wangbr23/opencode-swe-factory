import {
  PINNED_EMBEDDING_MODEL_ID,
  PINNED_EMBEDDING_MODEL_REVISION,
} from "../documents/embedding-artifact-manifest.js";
import {
  DEFAULT_SEMANTIC_LESSON_LIMIT,
  MAX_SEMANTIC_LESSON_LIMIT,
} from "./lesson-semantic-retrieval-constants.js";
import { EMBEDDING_VECTOR_BYTE_LENGTH, EMBEDDING_VECTOR_DIMENSIONS } from "../../types/embedding-types.js";
import type { SqliteConnection } from "../db/sqlite.js";
import type {
  RetrieveConfirmedLessonsSemanticallyInput,
  SemanticLessonResult,
  SemanticLessonRow,
} from "../../types/lesson-semantic-retrieval-types.js";

export {
  DEFAULT_SEMANTIC_LESSON_LIMIT,
  MAX_SEMANTIC_LESSON_LIMIT,
} from "./lesson-semantic-retrieval-constants.js";
export type {
  RetrieveConfirmedLessonsSemanticallyInput,
  SemanticLessonResult,
} from "../../types/lesson-semantic-retrieval-types.js";

export class LessonSemanticRetrievalError extends Error {}

const SELECT_SCOPED_VECTORS = `
SELECT
  lesson_version_embeddings.lesson_id,
  lesson_version_embeddings.lesson_version,
  lessons.project_id,
  lessons.scope,
  lesson_versions.title,
  lesson_versions.body,
  lesson_versions.rationale,
  lesson_versions.applicability_json,
  lesson_versions.provenance_json,
  lesson_versions.created_at,
  lesson_version_embeddings.vector
FROM lesson_version_embeddings
JOIN lessons
  ON lessons.id = lesson_version_embeddings.lesson_id
  AND lessons.active_version = lesson_version_embeddings.lesson_version
JOIN lesson_versions
  ON lesson_versions.lesson_id = lesson_version_embeddings.lesson_id
  AND lesson_versions.version = lesson_version_embeddings.lesson_version
WHERE lesson_version_embeddings.model = ?
  AND lesson_version_embeddings.revision = ?
  AND lesson_versions.superseded_by_version IS NULL
  AND (
    (lessons.scope = 'project' AND lessons.project_id = ?)
    OR (lessons.scope = 'global' AND lessons.project_id IS NULL)
  )
`;

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new LessonSemanticRetrievalError(`${label} must be a non-empty string.`);
  }
  return value;
}

function resolveLimit(limit: number | undefined): number {
  const resolved = limit ?? DEFAULT_SEMANTIC_LESSON_LIMIT;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > MAX_SEMANTIC_LESSON_LIMIT) {
    throw new LessonSemanticRetrievalError(
      `limit must be a positive safe integer no greater than ${MAX_SEMANTIC_LESSON_LIMIT}.`,
    );
  }
  return resolved;
}

function parseMetadata(value: string, lessonId: string, field: "applicability" | "provenance"): Readonly<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new TypeError(`${field} must be an object.`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new LessonSemanticRetrievalError(
      `Lesson ${lessonId} has invalid ${field} metadata.`,
      { cause: error },
    );
  }
}

function decodeVector(blob: Uint8Array, lessonId: string): Float32Array {
  if (blob.byteLength !== EMBEDDING_VECTOR_BYTE_LENGTH) {
    throw new LessonSemanticRetrievalError(
      `Lesson ${lessonId} has a stored vector of ${blob.byteLength} bytes; expected ${EMBEDDING_VECTOR_BYTE_LENGTH}.`,
    );
  }
  return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
}

function validateQueryVector(vector: Float32Array): Float32Array {
  if (vector.length !== EMBEDDING_VECTOR_DIMENSIONS) {
    throw new LessonSemanticRetrievalError(
      `Query embedding has ${vector.length} dimensions; expected ${EMBEDDING_VECTOR_DIMENSIONS}.`,
    );
  }
  for (const component of vector) {
    if (!Number.isFinite(component)) {
      throw new LessonSemanticRetrievalError("Query embedding contains a non-finite component.");
    }
  }
  return vector;
}

/**
 * Exact cosine similarity between the query vector and the stored vector. A
 * zero-magnitude vector (either side) yields a similarity of 0 instead of NaN
 * so ranking stays deterministic.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Ranks active confirmed lesson versions by exact cosine similarity between
 * the embedded query and their stored vectors for the current (model,
 * revision). Project-scoped lessons rank above global lessons (matching
 * lexical retrieval precedence); ties break by similarity, then lesson id.
 */
export async function retrieveConfirmedLessonsSemantically(
  connection: SqliteConnection,
  input: RetrieveConfirmedLessonsSemanticallyInput,
): Promise<ReadonlyArray<SemanticLessonResult>> {
  const projectId = requireNonEmptyString(input.projectId, "projectId");
  if (typeof input.query !== "string") {
    throw new LessonSemanticRetrievalError("query must be a string.");
  }
  const limit = resolveLimit(input.limit);
  const model = input.model ?? PINNED_EMBEDDING_MODEL_ID;
  const revision = input.revision ?? PINNED_EMBEDDING_MODEL_REVISION;
  requireNonEmptyString(model, "model");
  requireNonEmptyString(revision, "revision");

  if (input.query.trim().length === 0) {
    return [];
  }
  const queryVector = validateQueryVector(await input.embed(input.query));

  const rows = connection.database
    .query<SemanticLessonRow, [string, string, string]>(SELECT_SCOPED_VECTORS)
    .all(model, revision, projectId);

  const scored = rows.map((row) => ({
    row,
    similarity: cosineSimilarity(queryVector, decodeVector(row.vector, row.lesson_id)),
  }));
  scored.sort((left, right) => {
    const leftPriority = left.row.scope === "project" ? 0 : 1;
    const rightPriority = right.row.scope === "project" ? 0 : 1;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
    if (right.similarity !== left.similarity) {
      return right.similarity - left.similarity;
    }
    // Byte-order comparison, not locale-aware, to match SQLite's id ordering.
    return left.row.lesson_id < right.row.lesson_id ? -1 : 1;
  });

  return scored.slice(0, limit).map((entry, index) => ({
    lessonId: entry.row.lesson_id,
    version: entry.row.lesson_version,
    projectId: entry.row.project_id,
    scope: entry.row.scope,
    title: entry.row.title,
    body: entry.row.body,
    rationale: entry.row.rationale,
    applicability: parseMetadata(entry.row.applicability_json, entry.row.lesson_id, "applicability"),
    provenance: parseMetadata(entry.row.provenance_json, entry.row.lesson_id, "provenance"),
    createdAt: entry.row.created_at,
    similarity: entry.similarity,
    semanticRank: index + 1,
  }));
}