import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONFLICT_LESSONS,
  GLOBAL_LESSON,
  LESSON_ISOLATION_PROJECT_ALPHA_PATH,
  LESSON_ISOLATION_PROJECT_BETA_PATH,
  PRECEDENCE_QUERY,
  SEMANTIC_OVERRIDE_LESSON,
  SEMANTIC_OVERRIDE_QUERY,
  CONFLICT_QUERY,
  SUPERSEDED_LESSON,
  SUPERSEDED_QUERY,
} from "./fixtures/lesson-isolation-values.js";

type RecalledLesson = Readonly<{
  lessonId: string;
  version: number;
  scope: string;
  body: string;
  lexicalRank: number | null;
  semanticRank: number | null;
}>;

type SeededResult = Readonly<{
  status: "seeded";
  supersededLessonId: string;
  globalLessonId: string;
  conflictLessonIds: ReadonlyArray<string>;
}>;

type SemanticSeededResult = Readonly<{
  status: "semantic-seeded";
  lessonId: string;
}>;

type SupersededResult = Readonly<{
  status: "superseded";
  supersededVersion: number;
  version: number;
  activeVersion: number;
}>;

type ResolvedResult = Readonly<{
  status: "resolved";
  approvalCard: string;
  resolution: string;
  activeVersion: number;
  indexedVersion: number;
  pendingCandidateCount: number;
}>;

type RecalledResult = Readonly<{
  status: "recalled";
  semanticStatus: string;
  retrieved: ReadonlyArray<RecalledLesson>;
  suppressed: ReadonlyArray<Readonly<{ lessonId: string; conflictsWith: string }>>;
  system: string;
}>;

type RecallOptions = Readonly<{ projectPath: string; query: string }>;

const PROCESS_FIXTURE = join(import.meta.dir, "fixtures", "lesson-isolation-process.ts");
const PROCESS_TIMEOUT_MS = 10_000;

function parseProcessOutput(
  mode: "seed" | "seed-override" | "supersede" | "resolve" | "recall",
  stdout: string,
): SeededResult | SemanticSeededResult | SupersededResult | ResolvedResult | RecalledResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch (error) {
    throw new Error(`Lesson-isolation ${mode} process returned invalid JSON: ${stdout}`, {
      cause: error,
    });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Lesson-isolation ${mode} process returned a non-object result.`);
  }
  const result = parsed as Record<string, unknown>;
  const validStatus =
    (mode === "seed" && result.status === "seeded") ||
    (mode === "seed-override" && result.status === "semantic-seeded") ||
    (mode === "supersede" && result.status === "superseded") ||
    (mode === "resolve" && result.status === "resolved") ||
    (mode === "recall" && result.status === "recalled");
  if (!validStatus) {
    throw new Error(`Lesson-isolation ${mode} process returned an invalid result: ${stdout}`);
  }
  return result as unknown as SeededResult | SemanticSeededResult | SupersededResult | ResolvedResult | RecalledResult;
}

async function runProcess(
  mode: "seed",
  databasePath: string,
  diagnosticsPath: string,
): Promise<SeededResult>;
async function runProcess(
  mode: "seed-override",
  databasePath: string,
  diagnosticsPath: string,
): Promise<SemanticSeededResult>;
async function runProcess(
  mode: "supersede",
  databasePath: string,
  diagnosticsPath: string,
  options: { lessonId: string },
): Promise<SupersededResult>;
async function runProcess(
  mode: "resolve",
  databasePath: string,
  diagnosticsPath: string,
  options: { lessonId: string },
): Promise<ResolvedResult>;
async function runProcess(
  mode: "recall",
  databasePath: string,
  diagnosticsPath: string,
  options: RecallOptions,
): Promise<RecalledResult>;
async function runProcess(
  mode: "seed" | "seed-override" | "supersede" | "resolve" | "recall",
  databasePath: string,
  diagnosticsPath: string,
  options?: { lessonId?: string; projectPath?: string; query?: string },
): Promise<unknown> {
  const cmd = [process.execPath, PROCESS_FIXTURE, mode, databasePath, diagnosticsPath];
  if (mode === "supersede" || mode === "resolve") cmd.push(options?.lessonId ?? "");
  if (mode === "recall") cmd.push(options?.projectPath ?? "", options?.query ?? "");

  const child = Bun.spawn({
    cmd,
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, PROCESS_TIMEOUT_MS);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).finally(() => clearTimeout(timeout));
  if (exitCode !== 0) {
    const reason = timedOut ? "timed out" : `failed (${exitCode})`;
    throw new Error(`Lesson-isolation ${mode} process ${reason}: ${stderr}`);
  }

  return parseProcessOutput(mode, stdout);
}

function retrievedByBody(recall: RecalledResult, body: string): RecalledLesson {
  const entry = recall.retrieved.find((lesson) => lesson.body === body);
  if (entry === undefined) {
    throw new Error(
      `Expected lesson body was not retrieved: ${body}\nRetrieved: ${JSON.stringify(recall.retrieved)}`,
    );
  }
  return entry;
}

test("isolates project lessons across processes with supersession and conflict suppression", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-lesson-isolation-"));
  const databasePath = join(directory, "memory.sqlite");

  try {
    const seeded = await runProcess("seed", databasePath, directory);
    expect(seeded.status).toBe("seeded");

    const v1Recall = await runProcess("recall", databasePath, directory, {
      projectPath: LESSON_ISOLATION_PROJECT_ALPHA_PATH,
      query: SUPERSEDED_QUERY,
    });
    expect(v1Recall.semanticStatus).toBe("available");
    const v1Entry = retrievedByBody(v1Recall, SUPERSEDED_LESSON.v1Body);
    expect(v1Entry.version).toBe(1);
    expect(v1Entry.scope).toBe("project");
    expect(v1Entry.lexicalRank).toBe(1);
    expect(v1Recall.system).toContain(SUPERSEDED_LESSON.v1Body);
    expect(v1Recall.system).toMatch(/\[lesson [^\]]+ v1\]/);
    expect(v1Recall.system).toContain("[project]");

    const superseded = await runProcess("supersede", databasePath, directory, {
      lessonId: seeded.supersededLessonId,
    });
    expect(superseded.supersededVersion).toBe(1);
    expect(superseded.version).toBe(2);
    expect(superseded.activeVersion).toBe(2);

    const precedenceRecall = await runProcess("recall", databasePath, directory, {
      projectPath: LESSON_ISOLATION_PROJECT_ALPHA_PATH,
      query: PRECEDENCE_QUERY,
    });
    const projectEntry = retrievedByBody(precedenceRecall, SUPERSEDED_LESSON.v2Body);
    const globalEntry = retrievedByBody(precedenceRecall, GLOBAL_LESSON.body);
    expect(precedenceRecall.retrieved.indexOf(projectEntry)).toBeLessThan(
      precedenceRecall.retrieved.indexOf(globalEntry),
    );
    expect(projectEntry.version).toBe(2);
    expect(projectEntry.scope).toBe("project");
    expect(globalEntry.scope).toBe("global");
    expect(precedenceRecall.system).toContain(SUPERSEDED_LESSON.v2Body);
    expect(precedenceRecall.system).toContain(GLOBAL_LESSON.body);
    expect(precedenceRecall.system.indexOf(SUPERSEDED_LESSON.v2Body)).toBeLessThan(
      precedenceRecall.system.indexOf(GLOBAL_LESSON.body),
    );
    expect(precedenceRecall.system).toMatch(/\[lesson [^\]]+ v2\]/);
    expect(precedenceRecall.system).not.toContain(SUPERSEDED_LESSON.v1Body);

    const isolationRecall = await runProcess("recall", databasePath, directory, {
      projectPath: LESSON_ISOLATION_PROJECT_BETA_PATH,
      query: PRECEDENCE_QUERY,
    });
    expect(isolationRecall.retrieved).toHaveLength(1);
    const isolatedEntry = retrievedByBody(isolationRecall, GLOBAL_LESSON.body);
    expect(isolatedEntry.scope).toBe("global");
    expect(isolationRecall.system).toContain(GLOBAL_LESSON.body);
    expect(isolationRecall.system).not.toContain(SUPERSEDED_LESSON.v1Body);
    expect(isolationRecall.system).not.toContain(SUPERSEDED_LESSON.v2Body);
    expect(isolationRecall.system).not.toContain(CONFLICT_LESSONS[0].body);
    expect(isolationRecall.system).not.toContain(CONFLICT_LESSONS[1].body);

    const staleRecall = await runProcess("recall", databasePath, directory, {
      projectPath: LESSON_ISOLATION_PROJECT_ALPHA_PATH,
      query: SUPERSEDED_QUERY,
    });
    expect(staleRecall.retrieved.some((lesson) => lesson.body === SUPERSEDED_LESSON.v1Body)).toBe(false);
    const staleSupersededEntry = staleRecall.retrieved.find(
      (lesson) => lesson.lessonId === seeded.supersededLessonId,
    );
    if (staleSupersededEntry !== undefined) {
      expect(staleSupersededEntry.version).toBe(2);
    }
    const staleActiveEntry = retrievedByBody(staleRecall, SUPERSEDED_LESSON.v2Body);
    expect(staleActiveEntry.version).toBe(2);
    expect(staleRecall.system).not.toContain(SUPERSEDED_LESSON.v1Body);

    const conflictRecall = await runProcess("recall", databasePath, directory, {
      projectPath: LESSON_ISOLATION_PROJECT_ALPHA_PATH,
      query: CONFLICT_QUERY,
    });
    const conflictA = retrievedByBody(conflictRecall, CONFLICT_LESSONS[0].body);
    const conflictB = retrievedByBody(conflictRecall, CONFLICT_LESSONS[1].body);
    expect(conflictA.scope).toBe("project");
    expect(conflictB.scope).toBe("project");
    expect(conflictRecall.suppressed).toHaveLength(1);
    const suppressedEntry = conflictRecall.suppressed[0];
    if (suppressedEntry === undefined) {
      throw new Error(`Conflict suppression did not flag the lower-ranked lesson: ${JSON.stringify(conflictRecall)}`);
    }
    expect(suppressedEntry.lessonId).not.toBe(suppressedEntry.conflictsWith);
    expect(seeded.conflictLessonIds).toContain(suppressedEntry.lessonId);
    expect(seeded.conflictLessonIds).toContain(suppressedEntry.conflictsWith);
    const suppressedLesson = conflictRecall.retrieved.find(
      (lesson) => lesson.lessonId === suppressedEntry.lessonId,
    );
    const keptLesson = conflictRecall.retrieved.find(
      (lesson) => lesson.lessonId === suppressedEntry.conflictsWith,
    );
    expect(suppressedLesson).toBeDefined();
    expect(keptLesson).toBeDefined();
    expect(conflictRecall.system).toContain(keptLesson?.body ?? "");
    expect(conflictRecall.system).not.toContain(suppressedLesson?.body ?? "");

    const semanticSeed = await runProcess("seed-override", databasePath, directory);
    const resolved = await runProcess("resolve", databasePath, directory, {
      lessonId: semanticSeed.lessonId,
    });
    expect(resolved.approvalCard).toContain("[related]");
    expect(resolved.approvalCard).toContain(SEMANTIC_OVERRIDE_LESSON.v1Title);
    expect(resolved.approvalCard).toContain(SEMANTIC_OVERRIDE_LESSON.v1Body);
    expect(resolved.approvalCard).toContain("100% semantic similarity");
    expect(resolved.approvalCard).not.toContain(
      `Available action: Supersede ${semanticSeed.lessonId}`,
    );
    expect(resolved.resolution).toContain(
      `lesson ${semanticSeed.lessonId} version 1 superseded by version 2`,
    );
    expect(resolved.activeVersion).toBe(2);
    expect(resolved.indexedVersion).toBe(2);
    expect(resolved.pendingCandidateCount).toBe(0);

    const overrideRecall = await runProcess("recall", databasePath, directory, {
      projectPath: LESSON_ISOLATION_PROJECT_ALPHA_PATH,
      query: SEMANTIC_OVERRIDE_QUERY,
    });
    const overrideEntry = retrievedByBody(overrideRecall, SEMANTIC_OVERRIDE_LESSON.v2Body);
    expect(overrideEntry.lessonId).toBe(semanticSeed.lessonId);
    expect(overrideEntry.version).toBe(2);
    expect(overrideRecall.retrieved.some(
      (lesson) => lesson.body === SEMANTIC_OVERRIDE_LESSON.v1Body,
    )).toBe(false);
    expect(overrideRecall.system).toContain(SEMANTIC_OVERRIDE_LESSON.v2Body);
    expect(overrideRecall.system).not.toContain(SEMANTIC_OVERRIDE_LESSON.v1Body);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
