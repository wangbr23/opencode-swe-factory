import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ACKNOWLEDGMENT_DOCUMENT,
  BLOCKED_DOCUMENT,
  CREDENTIAL,
  CHECKSUM_HASH,
  SAFE_DOCUMENT,
  SEEDED_LESSON,
} from "./fixtures/private-mode-values.js";

type Counts = Readonly<Record<string, number>>;

type SeededResult = Readonly<{ status: "seeded"; counts: Counts }>;
type RecalledResult = Readonly<{ status: "recalled"; system: string }>;
type PrivateActivityResult = Readonly<{
  status: "private-activity";
  embedderCreated: boolean;
  toggleText: string;
  proposalText: string;
  feedbackText: string;
  recommendationText: string;
  system: string;
  counts: Counts;
}>;
type SecretLessonResult = Readonly<{
  status: "secret-lesson";
  blockedProposal: string;
  withoutAcknowledgment: string;
  withAcknowledgment: string;
  counts: Counts;
}>;
type SecretDocsResult = Readonly<{
  status: "secret-docs";
  admitted: ReadonlyArray<string | null>;
  skipped: ReadonlyArray<Readonly<{ path: string; reason: string }>>;
  chunks: ReadonlyArray<Readonly<{ source_path: string; text: string }>>;
  indexedChunkCount: number;
  counts: Counts;
}>;

type ProcessResult =
  | SeededResult
  | RecalledResult
  | PrivateActivityResult
  | SecretLessonResult
  | SecretDocsResult;

const PROCESS_FIXTURE = join(import.meta.dir, "fixtures", "private-mode-process.ts");
const PROCESS_TIMEOUT_MS = 30_000;

const STATUS_BY_MODE: Readonly<Record<string, string>> = {
  seed: "seeded",
  recall: "recalled",
  private: "private-activity",
  counts: "counts",
  "secret-lesson": "secret-lesson",
  "secret-docs": "secret-docs",
};

async function runProcess(
  mode: "seed" | "recall" | "private" | "secret-lesson",
  databasePath: string,
  diagnosticsPath: string,
): Promise<ProcessResult>;
async function runProcess(
  mode: "counts",
  databasePath: string,
): Promise<ProcessResult>;
async function runProcess(
  mode: "secret-docs",
  databasePath: string,
  diagnosticsPath: string,
  projectRoot: string,
): Promise<ProcessResult>;
async function runProcess(
  mode: string,
  databasePath: string,
  diagnosticsPath?: string,
  projectRoot?: string,
): Promise<ProcessResult> {
  const cmd = [process.execPath, PROCESS_FIXTURE, mode, databasePath];
  if (diagnosticsPath !== undefined) cmd.push(diagnosticsPath);
  if (mode === "secret-docs") cmd.push(projectRoot ?? "");

  const child = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });
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
    throw new Error(`Private-mode ${mode} process ${reason}: ${stderr}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch (error) {
    throw new Error(`Private-mode ${mode} process returned invalid JSON: ${stdout}`, {
      cause: error,
    });
  }
  const result = parsed as Record<string, unknown>;
  if (typeof result !== "object" || result === null || result.status !== STATUS_BY_MODE[mode]) {
    throw new Error(`Private-mode ${mode} process returned an invalid result: ${stdout}`);
  }
  return result as unknown as ProcessResult;
}

function expectCountsEqual(before: Counts, after: Counts): void {
  for (const [table, count] of Object.entries(before)) {
    expect(after[table]).toBe(count);
  }
}

test("private mode records nothing across hooks and leaves the database snapshot untouched", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-private-mode-"));
  const databasePath = join(directory, "memory.sqlite");
  const publicDiagnostics = join(directory, "diag-public");
  const privateDiagnostics = join(directory, "diag-private");

  try {
    const seeded = (await runProcess("seed", databasePath, publicDiagnostics)) as SeededResult;
    expect(seeded.status).toBe("seeded");
    expect(seeded.counts.lessons).toBe(1);
    expect(seeded.counts.lesson_versions).toBe(1);
    expect(seeded.counts.lesson_version_embeddings).toBe(1);
    expect(seeded.counts.tasks).toBe(0);
    expect(seeded.counts.outcome_signals).toBe(0);

    // Positive control: with private mode off, the same query retrieves and injects the lesson.
    const recalled = (await runProcess("recall", databasePath, publicDiagnostics)) as RecalledResult;
    expect(recalled.system).toContain(SEEDED_LESSON.body);

    const snapshot = (await runProcess("counts", databasePath)) as unknown as {
      status: "counts";
      counts: Counts;
    };
    expect(snapshot.counts.tasks).toBe(1);

    const activity = (await runProcess(
      "private",
      databasePath,
      privateDiagnostics,
    )) as PrivateActivityResult;

    expect(activity.embedderCreated).toBe(false);
    expect(activity.toggleText).toContain("enabled");
    expect(activity.proposalText).toContain("private mode is active");
    expect(activity.feedbackText).toContain("private mode");
    expect(activity.recommendationText).toContain("No routing receipt");
    expect(activity.system).not.toContain(SEEDED_LESSON.body);
    expect(activity.system).toBe("You are a coding agent.");

    const after = (await runProcess("counts", databasePath)) as unknown as {
      status: "counts";
      counts: Counts;
    };
    expectCountsEqual(snapshot.counts, after.counts);

    const privateDiagnosticsFile = join(privateDiagnostics, "diagnostics.jsonl");
    if (existsSync(privateDiagnosticsFile)) {
      expect(readFileSync(privateDiagnosticsFile, "utf8").trim()).toBe("");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);

test("high-confidence credentials are blocked before persistence and low-confidence findings need explicit acknowledgment", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-secret-handling-"));
  const databasePath = join(directory, "memory.sqlite");
  const diagnosticsPath = join(directory, "diag");
  const projectRoot = join(directory, "docs-project");

  try {
    const result = (await runProcess(
      "secret-lesson",
      databasePath,
      diagnosticsPath,
    )) as SecretLessonResult;

    expect(result.blockedProposal).toContain("Lesson proposal blocked");
    expect(result.blockedProposal).not.toContain(CREDENTIAL);
    expect(result.withoutAcknowledgment).toContain("Lesson commit failed");
    expect(result.withoutAcknowledgment).toContain("acknowledgment");
    expect(result.withAcknowledgment).toContain("approved successfully");

    expect(result.counts.lessons).toBe(1);
    expect(result.counts.lesson_versions).toBe(1);
    // The un-acknowledged candidate stays pending (until expiry cleanup) while the
    // acknowledged one was consumed by approval.
    expect(result.counts.pending_lesson_candidates).toBe(1);

    // The high-confidence credential never reached any persistent byte of the store;
    // the acknowledged low-confidence checksum did, by design. Recent writes may still
    // sit in the WAL, so every database file is scanned.
    const databaseFiles = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
      .filter((path) => existsSync(path))
      .map((path) => readFileSync(path).toString("latin1"));
    expect(databaseFiles.join("")).not.toContain(CREDENTIAL);
    expect(databaseFiles.join("")).toContain(CHECKSUM_HASH);

    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(join(projectRoot, "safe.md"), SAFE_DOCUMENT);
    writeFileSync(join(projectRoot, "leaked.md"), BLOCKED_DOCUMENT);
    writeFileSync(join(projectRoot, "checksum.md"), ACKNOWLEDGMENT_DOCUMENT);

    const docs = (await runProcess(
      "secret-docs",
      databasePath,
      diagnosticsPath,
      projectRoot,
    )) as SecretDocsResult;

    expect(docs.admitted).toEqual(["safe.md"]);
    expect(docs.skipped.map((entry) => [entry.path, entry.reason])).toEqual([
      [expect.stringContaining("checksum.md"), "secret-acknowledgment-required"],
      [expect.stringContaining("leaked.md"), "secret-blocked"],
    ]);
    expect(JSON.stringify(docs.skipped)).not.toContain(CREDENTIAL);
    expect(JSON.stringify(docs.skipped)).not.toContain(CHECKSUM_HASH);

    expect(docs.indexedChunkCount).toBe(1);
    expect(docs.chunks).toHaveLength(1);
    expect(docs.chunks[0]?.source_path).toContain("safe.md");
    expect(docs.chunks[0]?.text).toContain("Safe guide");
    expect(docs.counts.document_sources).toBe(1);
    expect(docs.counts.document_chunks).toBe(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);
