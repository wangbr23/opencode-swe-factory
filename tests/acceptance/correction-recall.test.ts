import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CORRECTION_RECALL_LESSON } from "./fixtures/correction-recall-values.js";

type ApprovalResult = Readonly<{
  status: "approved";
}>;

type RecallResult = Readonly<{
  status: "recalled";
  semanticStatus: "available";
  lexicalRank: null;
  semanticRank: 1;
  system: string;
}>;

const PROCESS_FIXTURE = join(import.meta.dir, "fixtures", "correction-recall-process.ts");
const PROCESS_TIMEOUT_MS = 10_000;

function parseProcessOutput(
  mode: "approve" | "recall",
  stdout: string,
): ApprovalResult | RecallResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch (error) {
    throw new Error(`Correction-recall ${mode} process returned invalid JSON: ${stdout}`, {
      cause: error,
    });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Correction-recall ${mode} process returned a non-object result.`);
  }
  const result = parsed as Record<string, unknown>;
  if (mode === "approve" && result.status === "approved") {
    return { status: "approved" };
  }
  if (
    mode === "recall" &&
    result.status === "recalled" &&
    result.semanticStatus === "available" &&
    result.lexicalRank === null &&
    result.semanticRank === 1 &&
    typeof result.system === "string"
  ) {
    return {
      status: "recalled",
      semanticStatus: "available",
      lexicalRank: null,
      semanticRank: 1,
      system: result.system,
    };
  }
  throw new Error(`Correction-recall ${mode} process returned an invalid result: ${stdout}`);
}

async function runProcess(
  mode: "approve",
  databasePath: string,
  diagnosticsPath: string,
): Promise<ApprovalResult>;
async function runProcess(
  mode: "recall",
  databasePath: string,
  diagnosticsPath: string,
): Promise<RecallResult>;
async function runProcess(
  mode: "approve" | "recall",
  databasePath: string,
  diagnosticsPath: string,
): Promise<ApprovalResult | RecallResult> {
  const child = Bun.spawn({
    cmd: [process.execPath, PROCESS_FIXTURE, mode, databasePath, diagnosticsPath],
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
    throw new Error(`Correction-recall ${mode} process ${reason}: ${stderr}`);
  }

  return parseProcessOutput(mode, stdout);
}

test("recalls a human-approved correction from a paraphrase in a later process", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-correction-recall-"));
  const databasePath = join(directory, "memory.sqlite");

  try {
    const approval = await runProcess("approve", databasePath, directory);
    const recall = await runProcess("recall", databasePath, directory);

    expect(approval.status).toBe("approved");
    expect(recall.status).toBe("recalled");
    expect(recall.semanticStatus).toBe("available");
    expect(recall.lexicalRank).toBeNull();
    expect(recall.semanticRank).toBe(1);
    expect(recall.system).toContain(CORRECTION_RECALL_LESSON.body);
    expect(recall.system).toMatch(/\[lesson [^\]]+ v1\]/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
