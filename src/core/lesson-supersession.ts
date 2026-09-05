import type {
  LessonVersionSnapshot,
  SupersedeLessonInput,
  SupersedeLessonResult,
} from "../types/lesson-supersession-types.js";
import type { SqliteConnection } from "./sqlite.js";

export type {
  LessonVersionSnapshot,
  SupersedeLessonInput,
  SupersedeLessonResult,
} from "../types/lesson-supersession-types.js";

export class LessonSupersessionError extends Error {
  readonly lessonId: string;

  constructor(lessonId: string, message: string) {
    super(message);
    this.name = "LessonSupersessionError";
    this.lessonId = lessonId;
  }
}

type LessonRow = Readonly<{
  id: string;
  scope: string;
  project_id: string | null;
  active_version: number | null;
  created_at: string;
  updated_at: string;
}>;

type LessonVersionRow = Readonly<{
  lesson_id: string;
  version: number;
  title: string;
  body: string;
  rationale: string;
  applicability_json: string;
  provenance_json: string;
  superseded_by_version: number | null;
  created_at: string;
}>;

function getLessonRow(connection: SqliteConnection, lessonId: string): LessonRow {
  const row = findLessonRow(connection, lessonId);
  if (!row) {
    throw new LessonSupersessionError(lessonId, `Lesson ${lessonId} was not found.`);
  }
  return row;
}

function findLessonRow(connection: SqliteConnection, lessonId: string): LessonRow | undefined {
  return (
    connection.database
      .query<LessonRow, [string]>(
        "SELECT id, scope, project_id, active_version, created_at, updated_at FROM lessons WHERE id = ?",
      )
      .get(lessonId) ?? undefined
  );
}

function getLessonVersionRow(
  connection: SqliteConnection,
  lessonId: string,
  version: number,
): LessonVersionRow {
  const row = connection.database
    .query<LessonVersionRow, [string, number]>(
      "SELECT lesson_id, version, title, body, rationale, applicability_json, provenance_json, superseded_by_version, created_at FROM lesson_versions WHERE lesson_id = ? AND version = ?",
    )
    .get(lessonId, version);
  if (!row) {
    throw new LessonSupersessionError(lessonId, `Lesson ${lessonId} version ${version} was not found.`);
  }
  return row;
}

function parseJsonObject(value: string, lessonId: string, label: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new LessonSupersessionError(lessonId, `Lesson ${lessonId} ${label} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function toSnapshot(row: LessonVersionRow): LessonVersionSnapshot {
  return {
    lessonId: row.lesson_id,
    version: row.version,
    title: row.title,
    body: row.body,
    rationale: row.rationale,
    applicability: parseJsonObject(row.applicability_json, row.lesson_id, "applicability"),
    provenance: parseJsonObject(row.provenance_json, row.lesson_id, "provenance"),
    supersededByVersion: row.superseded_by_version,
    createdAt: row.created_at,
  };
}

/**
 * Reads the active confirmed version of a lesson and validates the
 * active-version invariants: the pointer must reference an existing version,
 * and that version must not itself be superseded. Returns null when the
 * lesson does not exist or has no active version yet.
 */
export function readActiveLessonVersion(connection: SqliteConnection, lessonId: string): LessonVersionSnapshot | null {
  const lesson = findLessonRow(connection, lessonId);
  if (!lesson || lesson.active_version === null) {
    return null;
  }
  const version = getLessonVersionRow(connection, lessonId, lesson.active_version);
  if (version.superseded_by_version !== null) {
    throw new LessonSupersessionError(
      lessonId,
      `Lesson ${lessonId} active version ${lesson.active_version} is marked superseded.`,
    );
  }
  return toSnapshot(version);
}

/**
 * Marks a confirmed version as superseded by a newer version of the same
 * lesson. The replacement version row must already exist, so the
 * supersession pointer can never dangle. Immutable content is never touched.
 */
export function markVersionSuperseded(
  connection: SqliteConnection,
  lessonId: string,
  supersededVersion: number,
  byVersion: number,
): void {
  const previous = getLessonVersionRow(connection, lessonId, supersededVersion);
  getLessonVersionRow(connection, lessonId, byVersion);
  if (previous.superseded_by_version !== null) {
    throw new LessonSupersessionError(
      lessonId,
      `Lesson ${lessonId} version ${supersededVersion} is already superseded by version ${previous.superseded_by_version}.`,
    );
  }
  connection.database.run("UPDATE lesson_versions SET superseded_by_version = ? WHERE lesson_id = ? AND version = ?", [
    byVersion,
    lessonId,
    supersededVersion,
  ]);
}

/**
 * Supersedes the active confirmed version of a lesson with new content as an
 * additional immutable version. Prior versions and their provenance remain
 * untouched; only the active-version pointer and the supersession marker
 * move. Refuses to supersede a lesson whose active version is already
 * superseded.
 */
export function supersedeLesson(connection: SqliteConnection, input: SupersedeLessonInput): SupersedeLessonResult {
  const lesson = getLessonRow(connection, input.lessonId);
  if (lesson.active_version === null) {
    throw new LessonSupersessionError(input.lessonId, `Lesson ${input.lessonId} has no active version to supersede.`);
  }
  const supersededVersion = lesson.active_version;
  const now = (input.now ?? new Date()).toISOString();

  return connection.database.transaction((): SupersedeLessonResult => {
    const nextVersionRow = connection.database
      .query<{ max_version: number | null }, [string]>(
        "SELECT max(version) AS max_version FROM lesson_versions WHERE lesson_id = ?",
      )
      .get(input.lessonId);
    const nextVersion = (nextVersionRow?.max_version ?? 0) + 1;

    connection.database.run(
      "INSERT INTO lesson_versions (lesson_id, version, title, body, rationale, applicability_json, provenance_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        input.lessonId,
        nextVersion,
        input.draft.title,
        input.draft.body,
        input.draft.rationale,
        JSON.stringify(input.draft.applicability),
        JSON.stringify(input.draft.provenance),
        now,
      ],
    );
    markVersionSuperseded(connection, input.lessonId, supersededVersion, nextVersion);
    connection.database.run("UPDATE lessons SET active_version = ?, updated_at = ? WHERE id = ?", [
      nextVersion,
      now,
      input.lessonId,
    ]);

    return {
      lessonId: input.lessonId,
      supersededVersion,
      version: nextVersion,
      activeVersion: nextVersion,
    };
  })();
}
