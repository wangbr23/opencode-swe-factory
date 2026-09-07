import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EVIDENCE_WINNER_MODEL,
  MODEL_RECOMMENDATION_TASK_MESSAGE,
  PRIOR_FAVORITE_MODEL,
} from "./fixtures/model-recommendation-values.js";

type RecommendationSummary = Readonly<{
  provider: unknown;
  model: unknown;
  variant: unknown;
}>;

type RecordResult = Readonly<{
  status: "recorded";
  cold: Readonly<{
    recommendation: RecommendationSummary | null;
    isEvidenceBacked: unknown;
  }>;
}>;

type GateEvaluation = Readonly<{ gate: string; passed: boolean }>;

type ReceiptResult = Readonly<{
  status: "recommended";
  receipt: Readonly<{
    mode: string;
    recommendation:
      | (Readonly<{
          utility: number;
          evidenceSampleCount: number;
          evidenceWeightShare: number;
          dimensions: ReadonlyArray<Readonly<{ dimension: string; backedBy: string }>>;
        }> & RecommendationSummary)
      | null;
    currentModel: RecommendationSummary | null;
    isEvidenceBacked: boolean;
    gates: ReadonlyArray<GateEvaluation>;
  }>;
}>;

const PROCESS_FIXTURE = join(import.meta.dir, "fixtures", "model-recommendation-process.ts");
const PROCESS_TIMEOUT_MS = 15_000;

type Mode = "record" | "recommend";

function runRecordProcess(databasePath: string, diagnosticsPath: string): Promise<RecordResult> {
  return runProcess("record", databasePath, diagnosticsPath) as Promise<RecordResult>;
}

function runRecommendProcess(databasePath: string, diagnosticsPath: string): Promise<ReceiptResult> {
  return runProcess("recommend", databasePath, diagnosticsPath) as Promise<ReceiptResult>;
}

async function runProcess(
  mode: Mode,
  databasePath: string,
  diagnosticsPath: string,
): Promise<RecordResult | ReceiptResult> {
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
    throw new Error(`Model-recommendation ${mode} process ${reason}: ${stderr}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch (error) {
    throw new Error(`Model-recommendation ${mode} process returned invalid JSON: ${stdout}`, {
      cause: error,
    });
  }
  const result = parsed as Record<string, unknown>;
  if (mode === "record" && result.status === "recorded") {
    return result as RecordResult;
  }
  if (mode === "recommend" && result.status === "recommended") {
    return result as ReceiptResult;
  }
  throw new Error(`Model-recommendation ${mode} process returned an invalid result: ${stdout}`);
}

test("recorded execution evidence flips the recommendation and backs it through the gates", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-model-recommendation-"));
  const databasePath = join(directory, "memory.sqlite");

  try {
    const record = await runRecordProcess(databasePath, directory);
    const recommend = await runRecommendProcess(databasePath, directory);

    // Cold start: the prior favorite wins, and the receipt says so honestly.
    expect(record.status).toBe("recorded");
    expect(record.cold.recommendation).toMatchObject({ ...PRIOR_FAVORITE_MODEL });
    expect(record.cold.isEvidenceBacked).toBe(false);

    // After evidence: the recommendation flips to the recorded model.
    expect(recommend.status).toBe("recommended");
    const { receipt } = recommend as ReceiptResult;
    expect(receipt.mode).toBe("recommendation-only");
    expect(receipt.recommendation).toMatchObject({ ...EVIDENCE_WINNER_MODEL });
    expect(receipt.isEvidenceBacked).toBe(true);
    expect(receipt.currentModel).toMatchObject({ ...PRIOR_FAVORITE_MODEL });

    // The evidence and reason are inspectable: sample-backed dimensions,
    // every gate evaluated and passed.
    expect(receipt.recommendation?.evidenceSampleCount).toBeGreaterThanOrEqual(5);
    expect(receipt.recommendation?.evidenceWeightShare).toBe(1);
    for (const dimension of receipt.recommendation?.dimensions ?? []) {
      expect(dimension.backedBy).toBe("evidence");
    }
    for (const gate of receipt.gates) {
      expect(gate.passed).toBe(true);
    }
    expect(receipt.gates.map((gate) => gate.gate)).toEqual([
      "min-evidence-samples",
      "confidence-floor",
      "utility-margin",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 45_000);
