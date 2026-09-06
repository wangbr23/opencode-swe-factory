import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  aggregateDecayedEvidence,
  createTask,
  EvidenceAggregationError,
  migrateSqliteSchema,
  openSqliteConnection,
  persistTaskProfile,
  recordExecutionProfile,
  recordOutcomeSignal,
  releaseSchemaMigrations,
  resolveProjectIdentity,
  type SqliteConnection,
} from "../src/core/index.js";

const NOW = new Date("2026-09-06T12:00:00.000Z");
const DAY_MS = 86_400_000;

function withTestDatabase(
  run: (connection: SqliteConnection, projectId: string) => void,
): void {
  const directory = mkdtempSync(
    join(tmpdir(), "opencode-swe-factory-evidence-aggregation-"),
  );
  const dbPath = join(directory, "memory.sqlite");
  const connection = openSqliteConnection(dbPath);
  migrateSqliteSchema(connection, releaseSchemaMigrations);
  const { project } = resolveProjectIdentity(connection, { projectPath: "/repos/test-project" });
  try {
    run(connection, project.id);
  } finally {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function createTaskWithProfile(
  connection: SqliteConnection,
  projectId: string,
  sessionId: string,
  profileOverrides?: Partial<Parameters<typeof persistTaskProfile>[1]["profile"]>,
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
      summary: "Add the execution profile module.",
      ...profileOverrides,
    },
    now: NOW,
  });
  return task.taskId;
}

function executionInput(overrides?: Partial<Parameters<typeof recordExecutionProfile>[1]>) {
  return {
    taskId: "task-placeholder",
    provider: "openai",
    model: "gpt-4.1",
    agent: "build",
    selectionSource: "host",
    startedAt: NOW,
    completedAt: new Date(NOW.getTime() + 5_000),
    latencyMs: 5000,
    tokens: { input: 100, output: 50, reasoning: 10, cacheRead: 20, cacheWrite: 5 },
    costUsd: 0.01,
    finishState: "stop",
    ...overrides,
  };
}

function recordSignal(
  connection: SqliteConnection,
  taskId: string,
  executionId: string,
  overrides?: Partial<Parameters<typeof recordOutcomeSignal>[1]>,
): string {
  return recordOutcomeSignal(connection, {
    taskId,
    executionId,
    dimension: "quality",
    kind: "test-kind",
    source: "test-source",
    confidence: 1,
    value: 1,
    observedAt: NOW,
    now: NOW,
    ...overrides,
  }).signalId;
}

function qualityEstimate(summary: ReturnType<typeof aggregateDecayedEvidence>) {
  return summary.estimates.find((estimate) => estimate.dimension === "quality");
}

test("aggregateDecayedEvidence returns empty estimates when no evidence exists", () => {
  withTestDatabase((connection) => {
    const summary = aggregateDecayedEvidence(connection, {
      provider: "openai",
      model: "gpt-4.1",
      now: NOW,
    });

    expect(summary.consideredSignalCount).toBe(0);
    expect(summary.estimates.map((estimate) => estimate.dimension)).toEqual([
      "quality",
      "reliability",
      "cost",
      "latency",
    ]);
    for (const estimate of summary.estimates) {
      expect(estimate.mean).toBeNull();
      expect(estimate.effectiveSampleSize).toBe(0);
      expect(estimate.sampleCount).toBe(0);
    }
  });
});

test("aggregateDecayedEvidence decays older evidence and reports effective sample size", () => {
  withTestDatabase((connection, projectId) => {
    const taskId = createTaskWithProfile(connection, projectId, "session-1");
    const execution = recordExecutionProfile(connection, executionInput({ taskId }));
    recordSignal(connection, taskId, execution.executionId, { value: 1, observedAt: NOW });
    recordSignal(connection, taskId, execution.executionId, {
      value: 0,
      observedAt: new Date(NOW.getTime() - 60 * DAY_MS),
    });

    const summary = aggregateDecayedEvidence(connection, {
      provider: "openai",
      model: "gpt-4.1",
      now: NOW,
    });

    expect(summary.consideredSignalCount).toBe(2);
    const quality = qualityEstimate(summary);
    expect(quality?.backoffLevel).toBe(3);
    expect(quality?.sampleCount).toBe(2);
    // Recent weight 1, 60-day-old weight 0.5^(60/30) = 0.25 → mean 0.8.
    expect(quality?.mean).toBeCloseTo(0.8, 10);
    expect(quality?.decayedWeight).toBeCloseTo(1.25, 10);
    expect(quality?.effectiveSampleSize).toBeCloseTo(1.25 ** 2 / (1 + 0.0625), 10);
    expect(quality?.uncertainty).toBeGreaterThan(0);
  });
});

test("aggregateDecayedEvidence excludes evidence older than maxAgeDays", () => {
  withTestDatabase((connection, projectId) => {
    const taskId = createTaskWithProfile(connection, projectId, "session-1");
    const execution = recordExecutionProfile(connection, executionInput({ taskId }));
    recordSignal(connection, taskId, execution.executionId, {
      value: 1,
      observedAt: new Date(NOW.getTime() - 91 * DAY_MS),
    });

    const summary = aggregateDecayedEvidence(connection, {
      provider: "openai",
      model: "gpt-4.1",
      now: NOW,
    });

    expect(qualityEstimate(summary)?.sampleCount).toBe(0);
    expect(qualityEstimate(summary)?.mean).toBeNull();
  });
});

test("aggregateDecayedEvidence matches the exact profile at level 0 and backs off only when necessary", () => {
  withTestDatabase((connection, projectId) => {
    const exactTask = createTaskWithProfile(connection, projectId, "session-1");
    const exactExecution = recordExecutionProfile(
      connection,
      executionInput({ taskId: exactTask }),
    );
    recordSignal(connection, exactTask, exactExecution.executionId, { value: 1 });

    const summary = aggregateDecayedEvidence(connection, {
      provider: "openai",
      model: "gpt-4.1",
      now: NOW,
      targetProfile: { activity: "implement", domain: "backend", complexity: "medium" },
    });
    expect(qualityEstimate(summary)?.backoffLevel).toBe(0);
    expect(qualityEstimate(summary)?.mean).toBe(1);
  });
});

test("aggregateDecayedEvidence backs off across complexity, activity, then any profile", () => {
  withTestDatabase((connection, projectId) => {
    const implementBackendTask = createTaskWithProfile(
      connection,
      projectId,
      "session-1",
      { complexity: "high" },
    );
    const implementBackendExecution = recordExecutionProfile(
      connection,
      executionInput({ taskId: implementBackendTask }),
    );
    recordSignal(connection, implementBackendTask, implementBackendExecution.executionId, {
      value: 1,
    });

    const fixBackendTask = createTaskWithProfile(
      connection,
      projectId,
      "session-2",
      { activity: "fix", complexity: "high" },
    );
    const fixBackendExecution = recordExecutionProfile(
      connection,
      executionInput({ taskId: fixBackendTask }),
    );
    recordSignal(connection, fixBackendTask, fixBackendExecution.executionId, {
      value: 1,
    });

    const fixFrontendTask = createTaskWithProfile(
      connection,
      projectId,
      "session-3",
      { activity: "fix", domain: "frontend", complexity: "high" },
    );
    const fixFrontendExecution = recordExecutionProfile(
      connection,
      executionInput({ taskId: fixFrontendTask }),
    );
    recordSignal(connection, fixFrontendTask, fixFrontendExecution.executionId, { value: 1 });

    // Exact complexity mismatch backs off to activity+domain.
    const byComplexity = aggregateDecayedEvidence(connection, {
      provider: "openai",
      model: "gpt-4.1",
      now: NOW,
      targetProfile: { activity: "implement", domain: "backend", complexity: "medium" },
    });
    expect(qualityEstimate(byComplexity)?.backoffLevel).toBe(1);
    expect(qualityEstimate(byComplexity)?.sampleCount).toBe(1);

    // No recorded activity+backend combination matches this activity, so the
    // aggregation widens to domain-only and both backend tasks contribute.
    const byDomain = aggregateDecayedEvidence(connection, {
      provider: "openai",
      model: "gpt-4.1",
      now: NOW,
      targetProfile: { activity: "test", domain: "backend", complexity: "medium" },
    });
    expect(qualityEstimate(byDomain)?.backoffLevel).toBe(2);
    expect(qualityEstimate(byDomain)?.sampleCount).toBe(2);

    // No recorded infrastructure profile matches at any narrower level, so
    // every task contributes.
    const anyProfile = aggregateDecayedEvidence(connection, {
      provider: "openai",
      model: "gpt-4.1",
      now: NOW,
      targetProfile: { activity: "test", domain: "infrastructure", complexity: "medium" },
    });
    expect(qualityEstimate(anyProfile)?.backoffLevel).toBe(3);
    expect(qualityEstimate(anyProfile)?.sampleCount).toBe(3);
  });
});

test("aggregateDecayedEvidence labels coarse-profile evidence without altering its mean", () => {
  withTestDatabase((connection, projectId) => {
    const task = createTaskWithProfile(connection, projectId, "session-1", { complexity: "high" });
    const execution = recordExecutionProfile(connection, executionInput({ taskId: task }));
    recordSignal(connection, task, execution.executionId, { value: 1, observedAt: NOW });
    recordSignal(connection, task, execution.executionId, { value: 0, observedAt: NOW });

    const summary = aggregateDecayedEvidence(connection, {
      provider: "openai",
      model: "gpt-4.1",
      now: NOW,
      targetProfile: { activity: "implement", domain: "backend", complexity: "medium" },
    });

    const quality = qualityEstimate(summary);
    expect(quality?.backoffLevel).toBe(1);
    expect(quality?.mean).toBeCloseTo(0.5, 10);
    expect(quality?.decayedWeight).toBeCloseTo(2, 10);
  });
});

test("aggregateDecayedEvidence starts at level 3 when the target profile lacks dimensions", () => {
  withTestDatabase((connection, projectId) => {
    const task = createTaskWithProfile(connection, projectId, "session-1");
    const execution = recordExecutionProfile(connection, executionInput({ taskId: task }));
    recordSignal(connection, task, execution.executionId, { value: 1 });

    const summary = aggregateDecayedEvidence(connection, {
      provider: "openai",
      model: "gpt-4.1",
      now: NOW,
      targetProfile: { activity: null, domain: null, complexity: "medium" },
    });
    expect(qualityEstimate(summary)?.backoffLevel).toBe(3);
    expect(qualityEstimate(summary)?.sampleCount).toBe(1);
  });
});

test("aggregateDecayedEvidence only attributes execution-linked signals for the exact model and variant", () => {
  withTestDatabase((connection, projectId) => {
    const taskId = createTaskWithProfile(connection, projectId, "session-1");
    const execution = recordExecutionProfile(connection, executionInput({ taskId }));
    recordSignal(connection, taskId, execution.executionId, { value: 1 });

    recordOutcomeSignal(connection, {
      taskId,
      dimension: "quality",
      kind: "explicit-feedback",
      source: "explicit-user-feedback",
      confidence: 1,
      value: 1,
      now: NOW,
    });
    const otherModelExecution = recordExecutionProfile(
      connection,
      executionInput({ taskId, model: "gpt-4o" }),
    );
    recordSignal(connection, taskId, otherModelExecution.executionId, { value: 0 });
    const otherVariantExecution = recordExecutionProfile(
      connection,
      executionInput({ taskId, variant: "thinking" }),
    );
    recordSignal(connection, taskId, otherVariantExecution.executionId, { value: 0 });

    const summary = aggregateDecayedEvidence(connection, {
      provider: "openai",
      model: "gpt-4.1",
      now: NOW,
    });
    expect(qualityEstimate(summary)?.sampleCount).toBe(1);
    expect(qualityEstimate(summary)?.mean).toBe(1);

    const variantSummary = aggregateDecayedEvidence(connection, {
      provider: "openai",
      model: "gpt-4.1",
      variant: "thinking",
      now: NOW,
    });
    expect(qualityEstimate(variantSummary)?.sampleCount).toBe(1);
    expect(qualityEstimate(variantSummary)?.mean).toBe(0);
  });
});

test("aggregateDecayedEvidence excludes superseded signals", () => {
  withTestDatabase((connection, projectId) => {
    const taskId = createTaskWithProfile(connection, projectId, "session-1");
    const execution = recordExecutionProfile(connection, executionInput({ taskId }));
    const supersededId = recordSignal(connection, taskId, execution.executionId, { value: 1 });
    recordSignal(connection, taskId, execution.executionId, {
      value: 0,
      supersedesSignalId: supersededId,
    });

    const summary = aggregateDecayedEvidence(connection, {
      provider: "openai",
      model: "gpt-4.1",
      now: NOW,
    });
    expect(qualityEstimate(summary)?.sampleCount).toBe(1);
    expect(qualityEstimate(summary)?.mean).toBe(0);
  });
});

test("aggregateDecayedEvidence keeps cost and latency estimates separate", () => {
  withTestDatabase((connection, projectId) => {
    const taskId = createTaskWithProfile(connection, projectId, "session-1");
    const execution = recordExecutionProfile(connection, executionInput({ taskId }));
    recordSignal(connection, taskId, execution.executionId, {
      dimension: "cost",
      value: 0.02,
    });
    recordSignal(connection, taskId, execution.executionId, {
      dimension: "cost",
      value: 0.04,
    });
    recordSignal(connection, taskId, execution.executionId, {
      dimension: "latency",
      value: 1000,
    });

    const summary = aggregateDecayedEvidence(connection, {
      provider: "openai",
      model: "gpt-4.1",
      now: NOW,
    });
    const cost = summary.estimates.find((estimate) => estimate.dimension === "cost");
    const latency = summary.estimates.find((estimate) => estimate.dimension === "latency");
    const reliability = summary.estimates.find((estimate) => estimate.dimension === "reliability");
    expect(cost?.mean).toBeCloseTo(0.03, 10);
    expect(cost?.sampleCount).toBe(2);
    expect(cost?.uncertainty).toBeGreaterThan(0);
    expect(latency?.mean).toBe(1000);
    expect(latency?.uncertainty).toBe(0);
    expect(reliability?.mean).toBeNull();
  });
});

test("aggregateDecayedEvidence ignores evidence outside the current task taxonomy", () => {
  withTestDatabase((connection, projectId) => {
    const taskId = createTaskWithProfile(connection, projectId, "session-1");
    const execution = recordExecutionProfile(connection, executionInput({ taskId }));
    recordSignal(connection, taskId, execution.executionId, { value: 1 });

    connection.database.run(
      `INSERT INTO task_profiles (
         task_id, version, taxonomy_version, activity, domain, complexity, risk,
         stack_json, required_capabilities_json, signals_json, summary, source, created_at
       ) VALUES (?, 2, 999, 'implement', 'backend', 'medium', 'low', '[]', '[]', '[]', 'legacy', 'inferred', ?)`,
      [taskId, NOW.toISOString()],
    );
    connection.database.run(
      "UPDATE tasks SET active_profile_version = 2 WHERE id = ?",
      [taskId],
    );

    const summary = aggregateDecayedEvidence(connection, {
      provider: "openai",
      model: "gpt-4.1",
      now: NOW,
    });
    expect(qualityEstimate(summary)?.sampleCount).toBe(0);
  });
});

test("aggregateDecayedEvidence validates inputs", () => {
  withTestDatabase((connection) => {
    expect(() =>
      aggregateDecayedEvidence(connection, { provider: "", model: "gpt-4.1", now: NOW }),
    ).toThrow(EvidenceAggregationError);
    expect(() =>
      aggregateDecayedEvidence(connection, {
        provider: "openai",
        model: "gpt-4.1",
        now: NOW,
        halfLifeDays: 0,
      }),
    ).toThrow(EvidenceAggregationError);
    expect(() =>
      aggregateDecayedEvidence(connection, {
        provider: "openai",
        model: "gpt-4.1",
        now: NOW,
        maxAgeDays: -1,
      }),
    ).toThrow(EvidenceAggregationError);
  });
});
