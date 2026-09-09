import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CREDENTIAL, PREFERENCE_LESSON } from "./fixtures/preference-ingestion-values.js";

type PreferenceIngestionResult = Readonly<{
  status: "preference-ingested";
  originalCard: string;
  replacementCard: string;
  replacementApproved: string;
  duplicateCard: string;
  duplicateApproved: string;
  blockedCard: string;
  rejected: string;
  projectId: string;
  counts: Readonly<Record<string, number>>;
}>;

const PROCESS_FIXTURE = join(import.meta.dir, "fixtures", "preference-ingestion-process.ts");
const PROCESS_TIMEOUT_MS = 30_000;

async function runProcess(
  databasePath: string,
  diagnosticsPath: string,
): Promise<PreferenceIngestionResult> {
  const child = Bun.spawn({
    cmd: [process.execPath, PROCESS_FIXTURE, "preference", databasePath, diagnosticsPath],
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
    throw new Error(`Preference-ingestion process ${reason}: ${stderr}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch (error) {
    throw new Error(`Preference-ingestion process returned invalid JSON: ${stdout}`, {
      cause: error,
    });
  }
  const result = parsed as Record<string, unknown>;
  if (typeof result !== "object" || result === null || result.status !== "preference-ingested") {
    throw new Error(`Preference-ingestion process returned an invalid result: ${stdout}`);
  }
  return result as unknown as PreferenceIngestionResult;
}

test("an explicit preference proposes a draft, the card renders scope and overlaps, and only approval makes it durable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-preference-ingestion-"));
  const databasePath = join(directory, "memory.sqlite");
  const diagnosticsPath = join(directory, "diag");

  try {
    const result = await runProcess(databasePath, diagnosticsPath);

    // The first explicit statement of the preference proposes a global-scope draft
    // immediately, carried on the approval card with the question-tool instruction.
    expect(result.originalCard).toContain("Lesson Candidate");
    expect(result.originalCard).toContain(`Title: ${PREFERENCE_LESSON.title}`);
    expect(result.originalCard).toContain("Scope: global");
    expect(result.originalCard).toContain(
      "Present this candidate for approval now via the question tool",
    );

    // Edit is model-driven: the replacement candidate carries the corrected scope.
    expect(result.replacementCard).toContain("Scope: project");
    expect(result.replacementCard).toContain(`Project: ${result.projectId}`);
    expect(result.replacementApproved).toBe("Lesson approved successfully.");

    // A restated preference renders the overlapping confirmed lesson on the card.
    expect(result.duplicateCard).toContain("Scope: global");
    expect(result.duplicateCard).toContain("Overlapping confirmed lessons");
    expect(result.duplicateCard).toContain(PREFERENCE_LESSON.title);
    expect(result.duplicateApproved).toBe("Lesson approved successfully.");

    // A secret-bearing preference draft is blocked before any persistence.
    expect(result.blockedCard).toContain("Lesson proposal blocked");
    expect(result.blockedCard).not.toContain(CREDENTIAL);

    // Rejecting the superseded original deletes the draft; approvals are the only durable path.
    expect(result.rejected).toBe("Lesson rejected successfully.");
    expect(result.counts.lessons).toBe(2);
    expect(result.counts.lesson_versions).toBe(2);
    expect(result.counts.pending_lesson_candidates).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
