import type {
  LexicalLessonRow,
  LexicalLessonResult,
  RetrieveConfirmedLessonsLexicallyInput,
} from "../../types/lesson-retrieval-types.js";
import {
  DEFAULT_LEXICAL_LESSON_LIMIT,
  MAX_LEXICAL_LESSON_LIMIT,
  MAX_LEXICAL_QUERY_TERMS,
} from "./lesson-retrieval-constants.js";
import type { SqliteConnection } from "../db/sqlite.js";

export {
  DEFAULT_LEXICAL_LESSON_LIMIT,
  MAX_LEXICAL_LESSON_LIMIT,
  MAX_LEXICAL_QUERY_TERMS,
} from "./lesson-retrieval-constants.js";
export type {
  LexicalLessonResult,
  RetrieveConfirmedLessonsLexicallyInput,
} from "../../types/lesson-retrieval-types.js";

export class LessonRetrievalInputError extends Error {}

export class LessonRetrievalDataError extends Error {
  readonly lessonId: string;

  constructor(lessonId: string, field: "applicability" | "provenance", cause?: unknown) {
    super(`Lesson ${lessonId} has invalid ${field} metadata.`, { cause });
    this.name = "LessonRetrievalDataError";
    this.lessonId = lessonId;
  }
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new LessonRetrievalInputError(`${label} must be a non-empty string.`);
  }
  return value;
}

function resolveLimit(limit: number | undefined): number {
  const resolved = limit ?? DEFAULT_LEXICAL_LESSON_LIMIT;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > MAX_LEXICAL_LESSON_LIMIT) {
    throw new LessonRetrievalInputError(
      `limit must be a positive safe integer no greater than ${MAX_LEXICAL_LESSON_LIMIT}.`,
    );
  }
  return resolved;
}

function buildLiteralFtsQuery(query: string): string | null {
  const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const uniqueTerms: string[] = [];
  const seenTerms = new Set<string>();

  for (const term of terms) {
    const normalized = term.toLowerCase();
    if (!seenTerms.has(normalized)) {
      seenTerms.add(normalized);
      uniqueTerms.push(term);
    }
    if (uniqueTerms.length === MAX_LEXICAL_QUERY_TERMS) {
      break;
    }
  }

  if (uniqueTerms.length === 0) {
    return null;
  }
  return uniqueTerms.map((term) => `"${term}"`).join(" OR ");
}

function parseMetadata(
  value: string,
  lessonId: string,
  field: "applicability" | "provenance",
): Readonly<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new TypeError(`${field} must be an object.`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new LessonRetrievalDataError(lessonId, field, error);
  }
}

/**
 * Searches only active, confirmed lesson versions visible to the current
 * project. Task text is reduced to literal tokens before reaching MATCH, so
 * FTS operators and punctuation from external input cannot alter the query.
 */
export function retrieveConfirmedLessonsLexically(
  connection: SqliteConnection,
  input: RetrieveConfirmedLessonsLexicallyInput,
): ReadonlyArray<LexicalLessonResult> {
  const projectId = requireNonEmptyString(input.projectId, "projectId");
  if (typeof input.query !== "string") {
    throw new LessonRetrievalInputError("query must be a string.");
  }
  const limit = resolveLimit(input.limit);
  const ftsQuery = buildLiteralFtsQuery(input.query);
  if (ftsQuery === null) {
    return [];
  }

  const rows = connection.database
    .query<LexicalLessonRow, [string, string, number]>(
      `SELECT
        lesson_versions_fts.lesson_id,
        lesson_versions_fts.lesson_version,
        lessons.project_id,
        lessons.scope,
        lesson_versions.title,
        lesson_versions.body,
        lesson_versions.rationale,
        lesson_versions.applicability_json,
        lesson_versions.provenance_json,
        lesson_versions.created_at,
        bm25(lesson_versions_fts) AS lexical_score
      FROM lesson_versions_fts
      JOIN lessons
        ON lessons.id = lesson_versions_fts.lesson_id
        AND lessons.active_version = lesson_versions_fts.lesson_version
      JOIN lesson_versions
        ON lesson_versions.lesson_id = lesson_versions_fts.lesson_id
        AND lesson_versions.version = lesson_versions_fts.lesson_version
      WHERE lesson_versions_fts MATCH ?
        AND lesson_versions.superseded_by_version IS NULL
        AND (
          (lessons.scope = 'project' AND lessons.project_id = ?)
          OR (lessons.scope = 'global' AND lessons.project_id IS NULL)
        )
      ORDER BY
        CASE WHEN lessons.scope = 'project' THEN 0 ELSE 1 END ASC,
        lexical_score ASC,
        lesson_versions_fts.lesson_id ASC
      LIMIT ?`,
    )
    .all(ftsQuery, projectId, limit);

  return rows.map((row, index) => ({
    lessonId: row.lesson_id,
    version: row.lesson_version,
    projectId: row.project_id,
    scope: row.scope,
    title: row.title,
    body: row.body,
    rationale: row.rationale,
    applicability: parseMetadata(row.applicability_json, row.lesson_id, "applicability"),
    provenance: parseMetadata(row.provenance_json, row.lesson_id, "provenance"),
    createdAt: row.created_at,
    lexicalRank: index + 1,
  }));
}
