import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RoutingGatesConfig } from "../../types/config-types.js";
import type { OutcomeDimension } from "../../types/execution-profile-types.js";
import type { ModelEligibilityRejection } from "../../types/model-eligibility-types.js";
import type { ModelRecommendationResult } from "../../types/model-recommendation-types.js";
import type {
  RoutingReplayBenchmarkInput,
  RoutingReplayBenchmarkResult,
  RoutingReplayCase,
  RoutingReplayCaseResult,
  RoutingReplayModelIdentity,
} from "../../types/routing-replay-benchmark-types.js";
import { recordExecutionProfile, recordOutcomeSignal } from "../evidence/execution-profiles.js";
import { migrateSqliteSchema } from "../db/migrations.js";
import { recommendModel } from "../models/model-recommendation.js";
import { resolveProjectIdentity } from "../project-identity.js";
import {
  ROUTING_REPLAY_BENCHMARK_CONSTANTS,
  ROUTING_REPLAY_BENCHMARK_SCHEMA_VERSION,
} from "./routing-replay-benchmark-constants.js";
import { releaseSchemaMigrations } from "../db/schema.js";
import { openSqliteConnection, type SqliteConnection } from "../db/sqlite.js";
import { createTask, persistTaskProfile } from "../tasks/task-persistence.js";
import { TASK_TAXONOMY_VERSION } from "../tasks/task-taxonomy.js";

export type {
  RoutingReplayBenchmarkInput,
  RoutingReplayBenchmarkResult,
  RoutingReplayCaseResult,
} from "../../types/routing-replay-benchmark-types.js";

function identity(value: RoutingReplayModelIdentity): RoutingReplayModelIdentity {
  return { provider: value.provider, model: value.model, variant: value.variant };
}

function sameIdentity(
  left: RoutingReplayModelIdentity | null,
  right: RoutingReplayModelIdentity | null,
): boolean {
  return left === null || right === null
    ? left === right
    : left.provider === right.provider && left.model === right.model && left.variant === right.variant;
}

function sameIdentityList(
  left: ReadonlyArray<RoutingReplayModelIdentity>,
  right: ReadonlyArray<RoutingReplayModelIdentity>,
): boolean {
  const keys = (items: ReadonlyArray<RoutingReplayModelIdentity>) =>
    items.map((item) => `${item.provider}\u0000${item.model}\u0000${item.variant}`).sort();
  return JSON.stringify(keys(left)) === JSON.stringify(keys(right));
}

function rejectionIdentity(rejection: ModelEligibilityRejection): RoutingReplayModelIdentity {
  return identity(rejection);
}

function fraction(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function seedHistory(
  connection: SqliteConnection,
  projectId: string,
  benchmarkCase: RoutingReplayCase,
  now: Date,
): void {
  let executionNumber = 0;
  for (const entry of benchmarkCase.history) {
    const observedAt = new Date(
      now.getTime() - entry.ageDays * ROUTING_REPLAY_BENCHMARK_CONSTANTS.millisecondsPerDay,
    );
    for (let repeat = 0; repeat < entry.count; repeat += 1) {
      executionNumber += 1;
      const task = createTask(connection, {
        projectId,
        sessionId: `${benchmarkCase.id}-${executionNumber}`,
        boundary: "top-level",
        now: observedAt,
      });
      persistTaskProfile(connection, {
        taskId: task.taskId,
        profile: {
          taxonomyVersion: TASK_TAXONOMY_VERSION,
          activity: entry.profile.activity,
          domain: entry.profile.domain,
          complexity: entry.profile.complexity,
          risk: entry.profile.risk,
          stack: entry.profile.stack,
          signals: [],
          summary: `Synthetic routing replay case ${benchmarkCase.id}.`,
        },
        now: observedAt,
      });
      const execution = recordExecutionProfile(connection, {
        taskId: task.taskId,
        provider: entry.model.provider,
        model: entry.model.model,
        variant: entry.model.variant,
        agent: "routing-replay",
        selectionSource: "synthetic-replay",
        startedAt: observedAt,
        completedAt: new Date(
          observedAt.getTime() + ROUTING_REPLAY_BENCHMARK_CONSTANTS.executionLatencyMs,
        ),
        latencyMs: ROUTING_REPLAY_BENCHMARK_CONSTANTS.executionLatencyMs,
        tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        costUsd: 0,
        finishState: "stop",
        now: observedAt,
      });
      for (const replaySignal of entry.signals) {
        recordOutcomeSignal(connection, {
          taskId: task.taskId,
          executionId: execution.executionId,
          dimension: replaySignal.dimension,
          kind: "synthetic-replay",
          source: "benchmark",
          confidence: replaySignal.confidence,
          value: replaySignal.value,
          observedAt,
          now: observedAt,
        });
      }
    }
  }
}

function recommend(
  connection: SqliteConnection,
  benchmarkCase: RoutingReplayCase,
  now: Date,
  gates: RoutingGatesConfig,
  evidenceDecay: RoutingReplayBenchmarkInput["corpus"]["evidenceDecay"],
): ModelRecommendationResult {
  return recommendModel(connection, {
    candidates: benchmarkCase.candidates,
    preset: benchmarkCase.preset,
    gates,
    now,
    currentModel: benchmarkCase.currentModel,
    requiredCapabilities: benchmarkCase.requiredCapabilities,
    privacyPolicy: benchmarkCase.privacyPolicy,
    hardLimits: benchmarkCase.hardLimits,
    priors: benchmarkCase.priors,
    targetProfile: benchmarkCase.targetProfile,
    halfLifeDays: evidenceDecay.halfLifeDays,
    maxAgeDays: evidenceDecay.maxAgeDays,
  });
}

function contributionFor(
  result: ModelRecommendationResult,
  dimension: OutcomeDimension,
) {
  return result.recommendation?.contributions.find((item) => item.dimension === dimension) ?? null;
}

function runCase(
  benchmarkCase: RoutingReplayCase,
  now: Date,
  gates: RoutingGatesConfig,
  evidenceDecay: RoutingReplayBenchmarkInput["corpus"]["evidenceDecay"],
): RoutingReplayCaseResult {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-routing-replay-"));
  let connection: SqliteConnection | null = null;
  try {
    connection = openSqliteConnection(join(directory, "replay.sqlite"));
    migrateSqliteSchema(connection, releaseSchemaMigrations);
    const { project } = resolveProjectIdentity(connection, {
      projectPath: join(directory, "synthetic-project"),
    });
    seedHistory(connection, project.id, benchmarkCase, now);

    const first = recommend(connection, benchmarkCase, now, gates, evidenceDecay);
    const second = recommend(connection, benchmarkCase, now, gates, evidenceDecay);
    const recommendedModel = first.recommendation === null ? null : identity(first.recommendation);
    const rejectedModels = first.rejections.map(rejectionIdentity);
    const quality = contributionFor(first, "quality");
    const expectedBackoff = benchmarkCase.expected.qualityBackoffLevel;

    return {
      id: benchmarkCase.id,
      recommendedModel,
      expectedRecommendedModel: benchmarkCase.expected.recommendedModel,
      knownDivergence: benchmarkCase.expected.knownDivergence ?? null,
      recommendationUtility: first.recommendation?.utility ?? null,
      currentModelUtility: first.currentModel?.utility ?? null,
      recommendationCorrect: sameIdentity(recommendedModel, benchmarkCase.expected.recommendedModel),
      isEvidenceBacked: first.isEvidenceBacked,
      expectedEvidenceBacked: benchmarkCase.expected.isEvidenceBacked,
      evidenceGateCorrect: first.isEvidenceBacked === benchmarkCase.expected.isEvidenceBacked,
      gates: first.gates,
      qualitySampleCount: quality?.sampleCount ?? 0,
      qualityBackoffLevel: quality?.score === null ? null : quality?.backoffLevel ?? null,
      qualityBackoffCorrect:
        expectedBackoff === undefined || expectedBackoff === (quality?.score === null ? null : quality?.backoffLevel ?? null),
      rejectedModels,
      rejections: first.rejections,
      hardConstraintsCorrect: sameIdentityList(rejectedModels, benchmarkCase.expected.rejectedModels),
      deterministic: JSON.stringify(first) === JSON.stringify(second),
    };
  } finally {
    try {
      connection?.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

/**
 * Replays versioned synthetic histories through the production routing chain.
 * The result is a measurement surface for choosing gates: it never changes
 * configuration or turns a benchmark expectation into an automatic policy.
 */
export function runRoutingReplayBenchmark(
  input: RoutingReplayBenchmarkInput,
): RoutingReplayBenchmarkResult {
  const gates = input.gates ?? input.corpus.gates;
  const now = new Date(input.corpus.now);
  const caseResults = input.corpus.cases.map((benchmarkCase) =>
    runCase(benchmarkCase, now, gates, input.corpus.evidenceDecay));
  const evidenceBacked = caseResults.filter((result) => result.isEvidenceBacked);
  const backoffResults = caseResults.filter(
    (_result, index) => input.corpus.cases[index]?.expected.qualityBackoffLevel !== undefined,
  );

  return {
    schemaVersion: ROUTING_REPLAY_BENCHMARK_SCHEMA_VERSION,
    gates,
    caseResults,
    aggregate: {
      recommendationAccuracy: fraction(
        caseResults.filter((result) => result.recommendationCorrect).length,
        caseResults.length,
      ),
      evidenceGateAccuracy: fraction(
        caseResults.filter((result) => result.evidenceGateCorrect).length,
        caseResults.length,
      ),
      evidenceBackedCoverage: fraction(evidenceBacked.length, caseResults.length),
      evidenceBackedPrecision: evidenceBacked.length === 0
        ? null
        : fraction(
            evidenceBacked.filter((result) => result.recommendationCorrect).length,
            evidenceBacked.length,
          ),
      hardConstraintCorrectness: fraction(
        caseResults.filter((result) => result.hardConstraintsCorrect).length,
        caseResults.length,
      ),
      profileBackoffCorrectness: fraction(
        backoffResults.filter((result) => result.qualityBackoffCorrect).length,
        backoffResults.length,
      ),
      deterministicOutputRate: fraction(
        caseResults.filter((result) => result.deterministic).length,
        caseResults.length,
      ),
    },
  };
}
