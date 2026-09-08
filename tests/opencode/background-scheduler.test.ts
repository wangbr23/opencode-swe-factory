import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  completeTask,
  createTask,
  persistTaskProfile,
  proposeLessonCandidate,
  readLocalDiagnostics,
  recordToolOutcomeSignal,
  resolveProjectIdentity,
  reviewLessonCandidate,
} from "../../src/core/index.js";
import type { SecretScanResult } from "../../src/core/secrets.js";
import { createDefaultConfig, type ConfigV1 } from "../../src/core/config.js";
import { withPlugin } from "./fixtures.js";
import {
  createBackgroundSchedulerState,
  runBackgroundMaintenance,
  DIGEST_MIN_INTERVAL_MS,
} from "../../src/opencode/background-scheduler.js";
import { migrateSqliteSchema, openSqliteConnection, releaseSchemaMigrations, type SqliteConnection } from "../../src/core/index.js";

const NOW = new Date("2026-09-07T12:00:00.000Z");

const clearScan = {
  disposition: "clear",
  findings: [],
  redactedText: "",
} as const satisfies SecretScanResult;

function withSchedulerDatabase(
  run: (connection: SqliteConnection, projectId: string, directory: string) => void | Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-background-"));
  const connection = openSqliteConnection(join(directory, "memory.sqlite"));
  migrateSqliteSchema(connection, releaseSchemaMigrations);
  const { project } = resolveProjectIdentity(connection, { projectPath: "/repos/background-test" });
  const result = run(connection, project.id, directory);
  const cleanup = () => {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  };
  if (result instanceof Promise) {
    return result.finally(cleanup);
  }
  cleanup();
  return Promise.resolve();
}

function backupEnabledConfig(): ConfigV1 {
  return {
    ...createDefaultConfig(),
    backups: {
      enabled: true,
      schedule: { intervalDays: 1 },
      retention: { maxBackups: 3 },
    },
  };
}

function inputFor(
  projectId: string,
  directory: string,
  backupDirectory: string | null,
) {
  return {
    projectId,
    diagnosticsPath: directory,
    backupDirectory,
    now: NOW,
  };
}

function createVerifiedTask(
  connection: SqliteConnection,
  projectId: string,
  sessionId: string,
): string {
  const task = createTask(connection, {
    projectId,
    sessionId,
    boundary: "top-level",
    now: NOW,
  });
  persistTaskProfile(connection, {
    taskId: task.taskId,
    profile: {
      taxonomyVersion: 1,
      activity: "implement",
      domain: "backend",
      complexity: "medium",
      risk: "low",
      stack: ["typescript"],
      signals: ["activity-lexical"],
      summary: "Add a small module.",
    },
    now: NOW,
  });
  recordToolOutcomeSignal(connection, {
    taskId: task.taskId,
    record: { tool: "bash", exitCode: 0, commandText: "bun test", observedAt: NOW },
    now: NOW,
  });
  completeTask(connection, { taskId: task.taskId, now: NOW });
  return task.taskId;
}

test("backup job creates a due snapshot, then reports not-due", () =>
  withSchedulerDatabase((connection, projectId, directory) => {
    const state = createBackgroundSchedulerState();
    const backupDirectory = join(directory, "backups");
    const input = inputFor(projectId, directory, backupDirectory);

    const first = runBackgroundMaintenance(state, connection, backupEnabledConfig(), {
      privateMode: false,
      retrieval: true,
      recording: true,
      modelTelemetry: true,
      routing: false,
    }, input);
    const second = first.then(() =>
      runBackgroundMaintenance(state, connection, backupEnabledConfig(), {
        privateMode: false,
        retrieval: true,
        recording: true,
        modelTelemetry: true,
        routing: false,
      }, input),
    );

    return Promise.all([first, second]).then(([firstResult, secondResult]) => {
      expect(firstResult.backup).toBe("created");
      expect(existsSync(backupDirectory)).toBe(true);
      expect(secondResult.backup).toBe("not-due");
    });
  }));

test("backup job is skipped without a managed backup directory and failures stay contained", () =>
  withSchedulerDatabase((connection, projectId, directory) => {
    const state = createBackgroundSchedulerState();

    return runBackgroundMaintenance(
      state,
      connection,
      backupEnabledConfig(),
      { privateMode: false, retrieval: true, recording: true, modelTelemetry: true, routing: false },
      inputFor(projectId, directory, null),
    ).then((result) => {
      expect(result.backup).toBe("skipped");
      expect(result.candidateCleanup).toBe("ran");
      expect(result.digest).toBe("clean");
    });
  }));

test("a backup failure does not prevent the other background jobs", () =>
  withSchedulerDatabase((connection, projectId, directory) => {
    const blockedBackupDirectory = join(directory, "not-a-directory");
    writeFileSync(blockedBackupDirectory, "blocked", "utf8");
    const state = createBackgroundSchedulerState();

    return runBackgroundMaintenance(
      state,
      connection,
      backupEnabledConfig(),
      { privateMode: false, retrieval: true, recording: true, modelTelemetry: true, routing: false },
      inputFor(projectId, directory, blockedBackupDirectory),
    ).then((result) => {
      expect(result.backup).toBe("failed");
      expect(result.candidateCleanup).toBe("ran");
      expect(result.digest).toBe("clean");
      expect(result.proposal).toBe("no-trigger");
    });
  }));

test("digest runs once per throttle window and reports actionable lessons with a diagnostic", () =>
  withSchedulerDatabase(async (connection, projectId, directory) => {
    const state = createBackgroundSchedulerState();
    const toggles = { privateMode: false, retrieval: true, recording: true, modelTelemetry: true, routing: false };
    const input = inputFor(projectId, directory, null);

    const candidate = proposeLessonCandidate(connection, {
      projectId: null,
      scope: "global",
      draft: {
        title: "Run tests before commits",
        body: "Always run bun test before committing.",
        rationale: "User corrected a commit without tests.",
        applicability: {},
        provenance: {},
      },
      secretScan: clearScan,
      now: NOW,
    });
    reviewLessonCandidate(connection, { candidateId: candidate.id, decision: "approve" });
    connection.database.run("UPDATE lessons SET updated_at = ?", ["2026-01-01T00:00:00.000Z"]);

    const first = await runBackgroundMaintenance(state, connection, createDefaultConfig(), toggles, input);
    expect(first.digest).toBe("actionable");
    const diagnostics = readLocalDiagnostics(join(directory, "diagnostics.jsonl"));
    expect(diagnostics.filter((d) => d.code === "maintenance-digest")).toHaveLength(1);

    const second = await runBackgroundMaintenance(state, connection, createDefaultConfig(), toggles, input);
    expect(second.digest).toBe("skipped");
    expect(
      readLocalDiagnostics(join(directory, "diagnostics.jsonl")).filter(
        (d) => d.code === "maintenance-digest",
      ),
    ).toHaveLength(1);
  }));

test("digest re-runs after the throttle window expires", () =>
  withSchedulerDatabase(async (connection, projectId, directory) => {
    const state = createBackgroundSchedulerState();
    const toggles = { privateMode: false, retrieval: true, recording: true, modelTelemetry: true, routing: false };

    const first = await runBackgroundMaintenance(state, connection, createDefaultConfig(), toggles, {
      ...inputFor(projectId, directory, null),
      now: NOW,
    });
    expect(first.digest).toBe("clean");

    const afterWindow = new Date(NOW.getTime() + DIGEST_MIN_INTERVAL_MS + 1);
    const second = await runBackgroundMaintenance(state, connection, createDefaultConfig(), toggles, {
      ...inputFor(projectId, directory, null),
      now: afterWindow,
    });
    expect(second.digest).toBe("clean");
  }));

test("successful-method proposals trigger with evidence and are surfaced via diagnostic", () =>
  withSchedulerDatabase(async (connection, projectId, directory) => {
    for (const sessionId of ["s1", "s2", "s3"]) {
      createVerifiedTask(connection, projectId, sessionId);
    }
    const state = createBackgroundSchedulerState();
    const input = inputFor(projectId, directory, null);

    const result = await runBackgroundMaintenance(
      state,
      connection,
      createDefaultConfig(),
      { privateMode: false, retrieval: true, recording: true, modelTelemetry: true, routing: false },
      input,
    );
    expect(result.proposal).toBe("triggered");
    expect(
      connection.database
        .query<Record<string, unknown>, []>("SELECT * FROM pending_lesson_candidates")
        .all(),
    ).toHaveLength(1);
    const diagnostics = readLocalDiagnostics(join(directory, "diagnostics.jsonl"));
    expect(diagnostics.filter((d) => d.code === "automatic-lesson-proposed")).toHaveLength(1);

    const again = await runBackgroundMaintenance(
      state,
      connection,
      createDefaultConfig(),
      { privateMode: false, retrieval: true, recording: true, modelTelemetry: true, routing: false },
      input,
    );
    expect(again.proposal).toBe("no-trigger");
  }));

test("proposals are skipped in private mode and with recording disabled", () =>
  withSchedulerDatabase(async (connection, projectId, directory) => {
    for (const sessionId of ["s1", "s2", "s3"]) {
      createVerifiedTask(connection, projectId, sessionId);
    }
    const state = createBackgroundSchedulerState();
    const input = inputFor(projectId, directory, null);

    const privateResult = await runBackgroundMaintenance(
      state,
      connection,
      createDefaultConfig(),
      { privateMode: true, retrieval: false, recording: false, modelTelemetry: false, routing: false },
      input,
    );
    expect(privateResult.proposal).toBe("skipped");

    const recordingOffResult = await runBackgroundMaintenance(
      state,
      connection,
      createDefaultConfig(),
      { privateMode: false, retrieval: true, recording: false, modelTelemetry: true, routing: false },
      input,
    );
    expect(recordingOffResult.proposal).toBe("skipped");
    expect(
      connection.database
        .query<Record<string, unknown>, []>("SELECT * FROM pending_lesson_candidates")
        .all(),
    ).toHaveLength(0);
  }));

test("plugin init schedules a background run without surfacing errors", () =>
  withPlugin(async ({ diagnosticsPath }) => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const diagnostics = readLocalDiagnostics(join(diagnosticsPath, "diagnostics.jsonl"));
    expect(diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
  }));

test("plugin session.idle runs background work before the session-end reminder", () =>
  withPlugin(async ({ hooks, connection, projectId, diagnosticsPath }) => {
    for (const sessionId of ["s1", "s2", "s3"]) {
      createVerifiedTask(connection, projectId, sessionId);
    }

    await hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: "session-1" } },
    });

    const candidates = connection.database
      .query<{ draft_json: string }, []>("SELECT draft_json FROM pending_lesson_candidates")
      .all();
    expect(candidates).toHaveLength(1);
    const title = (JSON.parse(candidates[0]!.draft_json) as { draft: { title: string } }).draft.title;

    const diagnostics = readLocalDiagnostics(join(diagnosticsPath, "diagnostics.jsonl"));
    const proposalIndex = diagnostics.findIndex((d) => d.code === "automatic-lesson-proposed");
    const reminderIndex = diagnostics.findIndex((d) => d.code === "deferred-candidate-reminder");
    expect(proposalIndex).toBeGreaterThanOrEqual(0);
    expect(reminderIndex).toBeGreaterThan(proposalIndex);
    expect(diagnostics[reminderIndex]?.summary).toContain(title);
  }));

