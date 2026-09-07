import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ConfirmedLessonBenchmarkCase,
  ConfirmedLessonBenchmarkLesson,
  ConfirmedLessonBenchmarkVersion,
  ConfirmedLessonRetrievalBenchmarkCorpus,
  ConfirmedLessonRetrievalBenchmarkInput,
  ConfirmedLessonRetrievalBenchmarkResult,
} from "../types/retrieval-benchmark-types.js";
import { suppressConflictingLessons } from "./lesson-conflict-suppression.js";
import { packLessonContext } from "./lesson-context.js";
import { indexConfirmedLessonEmbeddings } from "./lesson-embedding-index.js";
import { retrieveConfirmedLessonsHybrid } from "./lesson-hybrid-retrieval.js";
import { migrateSqliteSchema } from "./migrations.js";
import { releaseSchemaMigrations } from "./schema.js";
import { openSqliteConnection } from "./sqlite.js";
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

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RetrievalBenchmarkCorpusError(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RetrievalBenchmarkCorpusError(`${path} must be a non-empty string.`);
  }
  return value;
}

function stringArray(value: unknown, path: string): ReadonlyArray<string> {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new RetrievalBenchmarkCorpusError(`${path} must be an array of non-empty strings.`);
  }
  return value;
}

function optionalTaskProfile(value: unknown, path: string): ConfirmedLessonBenchmarkCase["taskProfile"] {
  if (value === undefined) return undefined;
  const candidate = record(value, path);
  const profile: Record<string, string | null | ReadonlyArray<string>> = {};
  for (const key of ["activity", "domain", "complexity"] as const) {
    const item = candidate[key];
    if (item !== undefined && item !== null && typeof item !== "string") {
      throw new RetrievalBenchmarkCorpusError(`${path}.${key} must be a string or null.`);
    }
    if (item !== undefined) profile[key] = item as string | null;
  }
  if (candidate.stack !== undefined) profile.stack = stringArray(candidate.stack, `${path}.stack`);
  return profile;
}

function parseVersion(value: unknown, path: string): ConfirmedLessonBenchmarkVersion {
  const candidate = record(value, path);
  if (!Number.isInteger(candidate.version) || (candidate.version as number) < 1) {
    throw new RetrievalBenchmarkCorpusError(`${path}.version must be a positive integer.`);
  }
  if (typeof candidate.active !== "boolean") {
    throw new RetrievalBenchmarkCorpusError(`${path}.active must be boolean.`);
  }
  return {
    version: candidate.version as number,
    title: text(candidate.title, `${path}.title`),
    body: text(candidate.body, `${path}.body`),
    rationale: text(candidate.rationale, `${path}.rationale`),
    applicability: candidate.applicability === undefined ? {} : record(candidate.applicability, `${path}.applicability`),
    active: candidate.active,
  };
}

/** Parses and validates checked-in corpus JSON before it can seed SQLite. */
export function loadConfirmedLessonRetrievalBenchmarkCorpus(content: string): ConfirmedLessonRetrievalBenchmarkCorpus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new RetrievalBenchmarkCorpusError(`invalid JSON (${error instanceof Error ? error.message : String(error)}).`);
  }
  const root = record(parsed, "root");
  if (root.schemaVersion !== CONFIRMED_LESSON_BENCHMARK_SCHEMA_VERSION) {
    throw new RetrievalBenchmarkCorpusError(`schemaVersion must be ${CONFIRMED_LESSON_BENCHMARK_SCHEMA_VERSION}.`);
  }
  if (!Array.isArray(root.lessons) || !Array.isArray(root.cases)) {
    throw new RetrievalBenchmarkCorpusError("lessons and cases must be arrays.");
  }
  const lessonIds = new Set<string>();
  const lessons = root.lessons.map((value, index): ConfirmedLessonBenchmarkLesson => {
    const candidate = record(value, `lessons[${index}]`);
    const lessonId = text(candidate.lessonId, `lessons[${index}].lessonId`);
    if (lessonIds.has(lessonId)) throw new RetrievalBenchmarkCorpusError(`duplicate lessonId ${lessonId}.`);
    lessonIds.add(lessonId);
    const scope = candidate.scope;
    if (scope !== "global" && scope !== "project") throw new RetrievalBenchmarkCorpusError(`lessons[${index}].scope is invalid.`);
    const projectId: string | null = candidate.projectId === null ? null : typeof candidate.projectId === "string" ? candidate.projectId : "";
    if ((scope === "global" && projectId !== null) || (scope === "project" && (typeof projectId !== "string" || projectId.length === 0))) {
      throw new RetrievalBenchmarkCorpusError(`lessons[${index}].projectId does not match scope.`);
    }
    if (!Array.isArray(candidate.versions) || candidate.versions.length === 0) throw new RetrievalBenchmarkCorpusError(`lessons[${index}].versions must not be empty.`);
    const versions = candidate.versions.map((version, versionIndex) => parseVersion(version, `lessons[${index}].versions[${versionIndex}]`));
    if (versions.filter((version) => version.active).length !== 1 || new Set(versions.map((version) => version.version)).size !== versions.length) {
      throw new RetrievalBenchmarkCorpusError(`lessons[${index}] must have unique versions and exactly one active version.`);
    }
    return { lessonId, scope, projectId, versions };
  });
  const caseIds = new Set<string>();
  const cases = root.cases.map((value, index): ConfirmedLessonBenchmarkCase => {
    const candidate = record(value, `cases[${index}]`);
    const id = text(candidate.id, `cases[${index}].id`);
    if (caseIds.has(id)) throw new RetrievalBenchmarkCorpusError(`duplicate case id ${id}.`);
    caseIds.add(id);
    if (!Number.isInteger(candidate.tokenBudget) || (candidate.tokenBudget as number) < 1) throw new RetrievalBenchmarkCorpusError(`cases[${index}].tokenBudget must be a positive integer.`);
    const relevantLessonIds = stringArray(candidate.relevantLessonIds, `cases[${index}].relevantLessonIds`);
    const expectedSuppressedLessonIds = stringArray(candidate.expectedSuppressedLessonIds, `cases[${index}].expectedSuppressedLessonIds`);
    for (const lessonId of [...relevantLessonIds, ...expectedSuppressedLessonIds]) {
      if (!lessonIds.has(lessonId)) throw new RetrievalBenchmarkCorpusError(`cases[${index}] references unknown lesson ${lessonId}.`);
    }
    const taskProfile = optionalTaskProfile(candidate.taskProfile, `cases[${index}].taskProfile`);
    const base = { id, projectId: text(candidate.projectId, `cases[${index}].projectId`), query: text(candidate.query, `cases[${index}].query`), tokenBudget: candidate.tokenBudget as number, relevantLessonIds, expectedSuppressedLessonIds };
    return taskProfile === undefined ? base : { ...base, taskProfile };
  });
  return { schemaVersion: 1, lessons, cases };
}

function seedLesson(connection: ReturnType<typeof openSqliteConnection>, lesson: ConfirmedLessonBenchmarkLesson, now: string): void {
  const active = lesson.versions.find((version) => version.active);
  if (!active) throw new RetrievalBenchmarkCorpusError(`lesson ${lesson.lessonId} has no active version.`);
  connection.database.run("INSERT INTO lessons (id, project_id, scope, active_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [lesson.lessonId, lesson.projectId, lesson.scope, active.version, now, now]);
  for (const version of [...lesson.versions].sort((left, right) => Number(right.active) - Number(left.active))) {
    connection.database.run("INSERT INTO lesson_versions (lesson_id, version, title, body, rationale, applicability_json, provenance_json, created_at, superseded_by_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [lesson.lessonId, version.version, version.title, version.body, version.rationale, JSON.stringify(version.applicability), "{}", now, version.active ? null : active.version]);
  }
}

function fraction(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export async function runConfirmedLessonRetrievalBenchmark(input: ConfirmedLessonRetrievalBenchmarkInput): Promise<ConfirmedLessonRetrievalBenchmarkResult> {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-retrieval-benchmark-"));
  const connection = openSqliteConnection(join(directory, "benchmark.sqlite"));
  const now = (input.now ?? new Date(BENCHMARK_TIMESTAMP)).toISOString();
  const clock = input.clock ?? (() => performance.now());
  const limit = input.limit ?? DEFAULT_CONFIRMED_LESSON_BENCHMARK_LIMIT;
  try {
    const coldStartedAt = clock();
    migrateSqliteSchema(connection, releaseSchemaMigrations);
    const projectIds = new Set(input.corpus.cases.map((benchmarkCase) => benchmarkCase.projectId));
    for (const lesson of input.corpus.lessons) if (lesson.projectId !== null) projectIds.add(lesson.projectId);
    for (const projectId of projectIds) connection.database.run("INSERT INTO projects (id, path, created_at, updated_at) VALUES (?, ?, ?, ?)", [projectId, `/benchmark/${projectId}`, now, now]);
    for (const lesson of input.corpus.lessons) seedLesson(connection, lesson, now);
    const indexed = await indexConfirmedLessonEmbeddings(connection, { embed: input.embed, now: new Date(now) });
    if (indexed.failures.length > 0 || indexed.remainingCount > 0) throw new Error(`Could not index benchmark corpus: ${indexed.failures.map((failure) => failure.message).join("; ") || "embedding batch incomplete"}.`);
    const caseResults = [];
    let coldLatencyMs = 0;
    for (const benchmarkCase of input.corpus.cases) {
      const startedAt = clock();
      const retrievalInput = benchmarkCase.taskProfile === undefined
        ? { projectId: benchmarkCase.projectId, query: benchmarkCase.query, limit, embed: input.embed }
        : { projectId: benchmarkCase.projectId, query: benchmarkCase.query, taskProfile: benchmarkCase.taskProfile, limit, embed: input.embed };
      const retrieval = await retrieveConfirmedLessonsHybrid(connection, retrievalInput);
      const suppression = suppressConflictingLessons({ results: retrieval.lessons });
      const packed = packLessonContext({ kept: suppression.kept, suppressed: suppression.suppressed, query: benchmarkCase.query, tokenBudget: benchmarkCase.tokenBudget });
      const retrievedLessonIds = retrieval.lessons.map((lesson) => lesson.lessonId);
      const packedLessonIds = packed.packed.map((lesson) => lesson.lessonId);
      const firstRelevant = retrievedLessonIds.findIndex((lessonId) => benchmarkCase.relevantLessonIds.includes(lessonId));
      const suppressedLessonIds = suppression.suppressed.map((lesson) => lesson.lessonId);
      const finishedAt = clock();
      const latencyMs = finishedAt - startedAt;
      if (caseResults.length === 0) coldLatencyMs = finishedAt - coldStartedAt;
      caseResults.push({ id: benchmarkCase.id, retrievedLessonIds, suppressedLessonIds, packedLessonIds, recallAtK: fraction(retrievedLessonIds.filter((lessonId) => benchmarkCase.relevantLessonIds.includes(lessonId)).length, benchmarkCase.relevantLessonIds.length), reciprocalRank: firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1), incorrectInjectionCount: packedLessonIds.filter((lessonId) => !benchmarkCase.relevantLessonIds.includes(lessonId)).length, packedCount: packedLessonIds.length, conflictSuppressionCorrect: suppressedLessonIds.length === benchmarkCase.expectedSuppressedLessonIds.length && suppressedLessonIds.every((lessonId) => benchmarkCase.expectedSuppressedLessonIds.includes(lessonId)), contextBudgetCompliant: packed.receipt.estimatedTokensUsed <= benchmarkCase.tokenBudget, latencyMs });
    }
    const warm = caseResults.slice(1);
    return { schemaVersion: 1, caseResults, aggregate: { recallAtK: fraction(caseResults.reduce((total, result) => total + result.recallAtK, 0), caseResults.length), meanReciprocalRank: fraction(caseResults.reduce((total, result) => total + result.reciprocalRank, 0), caseResults.length), incorrectInjectionRate: fraction(caseResults.reduce((total, result) => total + result.incorrectInjectionCount, 0), caseResults.reduce((total, result) => total + result.packedCount, 0)), conflictSuppressionCorrectness: fraction(caseResults.filter((result) => result.conflictSuppressionCorrect).length, caseResults.length), contextBudgetCompliance: fraction(caseResults.filter((result) => result.contextBudgetCompliant).length, caseResults.length), coldLatencyMs, warmLatencyMs: warm.length === 0 ? null : fraction(warm.reduce((total, result) => total + result.latencyMs, 0), warm.length) } };
  } finally {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
