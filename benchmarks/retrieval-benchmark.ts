import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { suppressConflictingLessons } from "../src/core/lessons/lesson-conflict-suppression.js";
import { packLessonContext } from "../src/core/lessons/lesson-context.js";
import { indexConfirmedLessonEmbeddings } from "../src/core/lessons/lesson-embedding-index.js";
import { retrieveConfirmedLessonsHybrid } from "../src/core/lessons/lesson-hybrid-retrieval.js";
import { migrateSqliteSchema } from "../src/core/db/migrations.js";
import { releaseSchemaMigrations } from "../src/core/db/schema.js";
import { openSqliteConnection, type SqliteConnection } from "../src/core/db/sqlite.js";
import type {
  ConfirmedLessonBenchmarkCase,
  ConfirmedLessonBenchmarkLesson,
  ConfirmedLessonBenchmarkVersion,
  ConfirmedLessonRetrievalBenchmarkCorpus,
  ConfirmedLessonRetrievalBenchmarkInput,
  ConfirmedLessonRetrievalBenchmarkResult,
} from "./retrieval-benchmark-types.js";
import {
  BENCHMARK_TIMESTAMP,
  CONFIRMED_LESSON_BENCHMARK_SCHEMA_VERSION,
  DEFAULT_CONFIRMED_LESSON_BENCHMARK_LIMIT,
} from "./retrieval-benchmark-constants.js";

export class RetrievalBenchmarkCorpusError extends Error {
  constructor(message: string) {
    super(`Invalid confirmed-lesson retrieval benchmark corpus: ${message}`);
    this.name = "RetrievalBenchmarkCorpusError";
  }
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RetrievalBenchmarkCorpusError(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireText(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RetrievalBenchmarkCorpusError(`${path} must be a non-empty string.`);
  }
  return value;
}

function requireUniqueTextArray(value: unknown, path: string, requireItems = false): ReadonlyArray<string> {
  if (!Array.isArray(value) || (requireItems && value.length === 0)) {
    throw new RetrievalBenchmarkCorpusError(`${path} must be an array of strings${requireItems ? " with at least one id" : ""}.`);
  }
  const values = value.map((item, index) => requireText(item, `${path}[${index}]`));
  if (new Set(values).size !== values.length) {
    throw new RetrievalBenchmarkCorpusError(`${path} must not contain duplicate ids.`);
  }
  return values;
}

function requireOptionalTaskProfile(value: unknown, path: string): ConfirmedLessonBenchmarkCase["taskProfile"] {
  if (value === undefined) return undefined;
  const candidate = requireRecord(value, path);
  const profile: Record<string, string | null | ReadonlyArray<string>> = {};
  for (const key of ["activity", "domain", "complexity"] as const) {
    const item = candidate[key];
    if (item !== undefined && item !== null && typeof item !== "string") {
      throw new RetrievalBenchmarkCorpusError(`${path}.${key} must be a string or null.`);
    }
    if (item !== undefined) profile[key] = item as string | null;
  }
  if (candidate.stack !== undefined) {
    profile.stack = requireUniqueTextArray(candidate.stack, `${path}.stack`);
  }
  return profile;
}

function requireTimestamp(value: unknown, path: string): string {
  const timestamp = requireText(value, path);
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new RetrievalBenchmarkCorpusError(`${path} must be an ISO-compatible timestamp.`);
  }
  return timestamp;
}

function parseVersion(value: unknown, path: string): ConfirmedLessonBenchmarkVersion {
  const candidate = requireRecord(value, path);
  if (!Number.isInteger(candidate.version) || (candidate.version as number) < 1) {
    throw new RetrievalBenchmarkCorpusError(`${path}.version must be a positive integer.`);
  }
  if (typeof candidate.active !== "boolean") {
    throw new RetrievalBenchmarkCorpusError(`${path}.active must be boolean.`);
  }
  return {
    version: candidate.version as number,
    title: requireText(candidate.title, `${path}.title`),
    body: requireText(candidate.body, `${path}.body`),
    rationale: requireText(candidate.rationale, `${path}.rationale`),
    applicability: candidate.applicability === undefined
      ? {}
      : requireRecord(candidate.applicability, `${path}.applicability`),
    createdAt: requireTimestamp(candidate.createdAt, `${path}.createdAt`),
    active: candidate.active,
  };
}

function parseLesson(value: unknown, index: number): ConfirmedLessonBenchmarkLesson {
  const path = `lessons[${index}]`;
  const candidate = requireRecord(value, path);
  const scope = candidate.scope;
  if (scope !== "global" && scope !== "project") {
    throw new RetrievalBenchmarkCorpusError(`${path}.scope is invalid.`);
  }
  const projectId: string | null = candidate.projectId === null
    ? null
    : typeof candidate.projectId === "string"
      ? candidate.projectId
      : "";
  if (scope === "global" && projectId !== null) {
    throw new RetrievalBenchmarkCorpusError(`${path}.projectId must be null for global scope.`);
  }
  if (scope === "project" && (typeof projectId !== "string" || projectId.trim().length === 0)) {
    throw new RetrievalBenchmarkCorpusError(`${path}.projectId must be set for project scope.`);
  }
  if (!Array.isArray(candidate.versions) || candidate.versions.length === 0) {
    throw new RetrievalBenchmarkCorpusError(`${path}.versions must not be empty.`);
  }
  const versions = candidate.versions.map((version, versionIndex) => parseVersion(version, `${path}.versions[${versionIndex}]`));
  const active = versions.filter((version) => version.active);
  const versionNumbers = versions.map((version) => version.version);
  if (new Set(versionNumbers).size !== versionNumbers.length || active.length !== 1) {
    throw new RetrievalBenchmarkCorpusError(`${path} must have unique versions and exactly one active version.`);
  }
  if (active[0]?.version !== Math.max(...versionNumbers)) {
    throw new RetrievalBenchmarkCorpusError(`${path} active version must be the latest version.`);
  }
  return {
    lessonId: requireText(candidate.lessonId, `${path}.lessonId`),
    scope,
    projectId,
    versions,
  };
}

function parseCase(value: unknown, index: number, lessonIds: ReadonlySet<string>): ConfirmedLessonBenchmarkCase {
  const path = `cases[${index}]`;
  const candidate = requireRecord(value, path);
  if (!Number.isInteger(candidate.tokenBudget) || (candidate.tokenBudget as number) < 1) {
    throw new RetrievalBenchmarkCorpusError(`${path}.tokenBudget must be a positive integer.`);
  }
  const expectations = {
    relevantLessonIds: requireUniqueTextArray(candidate.relevantLessonIds, `${path}.relevantLessonIds`, true),
    expectedSuppressedLessonIds: requireUniqueTextArray(candidate.expectedSuppressedLessonIds, `${path}.expectedSuppressedLessonIds`),
    expectedPackedLessonIds: requireUniqueTextArray(candidate.expectedPackedLessonIds, `${path}.expectedPackedLessonIds`),
  };
  for (const lessonId of Object.values(expectations).flat()) {
    if (!lessonIds.has(lessonId)) {
      throw new RetrievalBenchmarkCorpusError(`${path} references unknown lesson ${lessonId}.`);
    }
  }
  const taskProfile = requireOptionalTaskProfile(candidate.taskProfile, `${path}.taskProfile`);
  const base = {
    id: requireText(candidate.id, `${path}.id`),
    projectId: requireText(candidate.projectId, `${path}.projectId`),
    query: requireText(candidate.query, `${path}.query`),
    tokenBudget: candidate.tokenBudget as number,
    ...expectations,
  };
  return taskProfile === undefined ? base : { ...base, taskProfile };
}

/** Parses and validates the checked-in corpus before it can seed SQLite. */
export function loadConfirmedLessonRetrievalBenchmarkCorpus(content: string): ConfirmedLessonRetrievalBenchmarkCorpus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new RetrievalBenchmarkCorpusError(`invalid JSON (${detail}).`);
  }
  const root = requireRecord(parsed, "root");
  if (root.schemaVersion !== CONFIRMED_LESSON_BENCHMARK_SCHEMA_VERSION) {
    throw new RetrievalBenchmarkCorpusError(`schemaVersion must be ${CONFIRMED_LESSON_BENCHMARK_SCHEMA_VERSION}.`);
  }
  if (!Array.isArray(root.lessons) || root.lessons.length === 0 || !Array.isArray(root.cases) || root.cases.length === 0) {
    throw new RetrievalBenchmarkCorpusError("lessons and cases must be non-empty arrays.");
  }
  const lessons = root.lessons.map(parseLesson);
  const lessonIds = new Set(lessons.map((lesson) => lesson.lessonId));
  if (lessonIds.size !== lessons.length) {
    throw new RetrievalBenchmarkCorpusError("lessonId values must be unique.");
  }
  const cases = root.cases.map((benchmarkCase, index) => parseCase(benchmarkCase, index, lessonIds));
  const caseIds = cases.map((benchmarkCase) => benchmarkCase.id);
  if (new Set(caseIds).size !== caseIds.length) {
    throw new RetrievalBenchmarkCorpusError("case ids must be unique.");
  }
  return { schemaVersion: 1, lessons, cases };
}

function seedLesson(connection: SqliteConnection, lesson: ConfirmedLessonBenchmarkLesson): void {
  const active = lesson.versions.find((version) => version.active);
  if (!active) throw new RetrievalBenchmarkCorpusError(`lesson ${lesson.lessonId} has no active version.`);
  connection.database.run(
    "INSERT INTO lessons (id, project_id, scope, active_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    [lesson.lessonId, lesson.projectId, lesson.scope, active.version, active.createdAt, active.createdAt],
  );
  const versions = [...lesson.versions].sort((left, right) => Number(right.active) - Number(left.active));
  for (const version of versions) {
    connection.database.run(
      "INSERT INTO lesson_versions (lesson_id, version, title, body, rationale, applicability_json, provenance_json, created_at, superseded_by_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [lesson.lessonId, version.version, version.title, version.body, version.rationale, JSON.stringify(version.applicability), "{}", version.createdAt, version.active ? null : active.version],
    );
  }
}

function fraction(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function sameIds(actual: ReadonlyArray<string>, expected: ReadonlyArray<string>): boolean {
  return actual.length === expected.length && actual.every((lessonId) => expected.includes(lessonId));
}

function sameOrderedIds(actual: ReadonlyArray<string>, expected: ReadonlyArray<string>): boolean {
  return actual.length === expected.length && actual.every((lessonId, index) => lessonId === expected[index]);
}

export async function runConfirmedLessonRetrievalBenchmark(
  input: ConfirmedLessonRetrievalBenchmarkInput,
): Promise<ConfirmedLessonRetrievalBenchmarkResult> {
  const clock = input.clock ?? (() => performance.now());
  const coldStartedAt = clock();
  let directory: string | undefined;
  let connection: SqliteConnection | undefined;
  try {
    directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-retrieval-benchmark-"));
    connection = openSqliteConnection(join(directory, "benchmark.sqlite"));
    const embed = await input.createEmbed();
    migrateSqliteSchema(connection, releaseSchemaMigrations);

    const projectIds = new Set(input.corpus.cases.map((benchmarkCase) => benchmarkCase.projectId));
    for (const lesson of input.corpus.lessons) {
      if (lesson.projectId !== null) projectIds.add(lesson.projectId);
    }
    for (const projectId of projectIds) {
      connection.database.run(
        "INSERT INTO projects (id, path, created_at, updated_at) VALUES (?, ?, ?, ?)",
        [projectId, `/benchmark/${projectId}`, BENCHMARK_TIMESTAMP, BENCHMARK_TIMESTAMP],
      );
    }
    for (const lesson of input.corpus.lessons) seedLesson(connection, lesson);

    const indexed = await indexConfirmedLessonEmbeddings(connection, {
      embed,
      now: input.now ?? new Date(BENCHMARK_TIMESTAMP),
    });
    if (indexed.failures.length > 0 || indexed.remainingCount > 0) {
      const detail = indexed.failures.map((failure) => failure.message).join("; ") || "embedding batch incomplete";
      throw new Error(`Could not index benchmark corpus: ${detail}.`);
    }
    const setupLatencyMs = clock() - coldStartedAt;
    const limit = input.limit ?? DEFAULT_CONFIRMED_LESSON_BENCHMARK_LIMIT;
    const caseResults = [];
    let coldLatencyMs = 0;

    for (const benchmarkCase of input.corpus.cases) {
      const startedAt = clock();
      const retrievalInput = benchmarkCase.taskProfile === undefined
        ? { projectId: benchmarkCase.projectId, query: benchmarkCase.query, limit, embed }
        : { projectId: benchmarkCase.projectId, query: benchmarkCase.query, taskProfile: benchmarkCase.taskProfile, limit, embed };
      const retrieval = await retrieveConfirmedLessonsHybrid(connection, retrievalInput);
      const suppression = suppressConflictingLessons({ results: retrieval.lessons });
      const packed = packLessonContext({
        kept: suppression.kept,
        suppressed: suppression.suppressed,
        query: benchmarkCase.query,
        tokenBudget: benchmarkCase.tokenBudget,
      });
      const retrievedLessonIds = retrieval.lessons.map((lesson) => lesson.lessonId);
      const retrievedLessonVersions = retrieval.lessons.map((lesson) => ({
        lessonId: lesson.lessonId,
        version: lesson.version,
      }));
      const suppressedLessonIds = suppression.suppressed.map((lesson) => lesson.lessonId);
      const packedLessonIds = packed.packed.map((lesson) => lesson.lessonId);
      const firstRelevant = retrievedLessonIds.findIndex((lessonId) => benchmarkCase.relevantLessonIds.includes(lessonId));
      const finishedAt = clock();
      const latencyMs = finishedAt - startedAt;
      if (caseResults.length === 0) coldLatencyMs = finishedAt - coldStartedAt;
      caseResults.push({
        id: benchmarkCase.id,
        retrievedLessonIds,
        retrievedLessonVersions,
        semanticAvailable: retrieval.semantic.status === "available",
        semanticCandidateCount: retrieval.semantic.candidateCount,
        suppressedLessonIds,
        packedLessonIds,
        recallAtK: fraction(retrievedLessonIds.filter((lessonId) => benchmarkCase.relevantLessonIds.includes(lessonId)).length, benchmarkCase.relevantLessonIds.length),
        reciprocalRank: firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1),
        incorrectInjectionCount: packedLessonIds.filter((lessonId) => !benchmarkCase.relevantLessonIds.includes(lessonId)).length,
        packedCount: packedLessonIds.length,
        conflictSuppressionCorrect: sameIds(suppressedLessonIds, benchmarkCase.expectedSuppressedLessonIds),
        packingCorrect: sameOrderedIds(packedLessonIds, benchmarkCase.expectedPackedLessonIds),
        contextBudgetCompliant: packed.receipt.estimatedTokensUsed <= benchmarkCase.tokenBudget,
        latencyMs,
      });
    }
    const warmResults = caseResults.slice(1);
    return {
      schemaVersion: 1,
      caseResults,
      aggregate: {
        recallAtK: fraction(caseResults.reduce((total, result) => total + result.recallAtK, 0), caseResults.length),
        meanReciprocalRank: fraction(caseResults.reduce((total, result) => total + result.reciprocalRank, 0), caseResults.length),
        incorrectInjectionRate: fraction(caseResults.reduce((total, result) => total + result.incorrectInjectionCount, 0), caseResults.reduce((total, result) => total + result.packedCount, 0)),
        conflictSuppressionCorrectness: fraction(caseResults.filter((result) => result.conflictSuppressionCorrect).length, caseResults.length),
        packingCorrectness: fraction(caseResults.filter((result) => result.packingCorrect).length, caseResults.length),
        contextBudgetCompliance: fraction(caseResults.filter((result) => result.contextBudgetCompliant).length, caseResults.length),
        semanticAvailability: fraction(caseResults.filter((result) => result.semanticAvailable).length, caseResults.length),
        coldLatencyMs,
        setupLatencyMs,
        warmLatencyMs: warmResults.length === 0 ? null : fraction(warmResults.reduce((total, result) => total + result.latencyMs, 0), warmResults.length),
      },
    };
  } finally {
    connection?.close();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
}
