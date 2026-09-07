import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  aggregateDecayedEvidence,
  createTask,
  migrateSqliteSchema,
  ModelRankingInputError,
  openSqliteConnection,
  persistTaskProfile,
  rankEligibleModels,
  recordExecutionProfile,
  recordOutcomeSignal,
  releaseSchemaMigrations,
  resolveProjectIdentity,
  type DecayedDimensionEstimate,
  type DecayedEvidenceSummary,
  type EligibleModelCandidate,
  type EvidenceBackoffLevel,
  type RankedModelCandidate,
  type SqliteConnection,
} from "../src/core/index.js";

const NOW = new Date("2026-09-06T12:00:00.000Z");

function makeEstimate(
  dimension: DecayedDimensionEstimate["dimension"],
  overrides?: Partial<DecayedDimensionEstimate>,
): DecayedDimensionEstimate {
  return {
    dimension,
    backoffLevel: 0,
    mean: null,
    effectiveSampleSize: 0,
    uncertainty: 0,
    sampleCount: 0,
    decayedWeight: 0,
    ...overrides,
  };
}

function makeSummary(
  candidate: EligibleModelCandidate,
  estimates: ReadonlyArray<DecayedDimensionEstimate>,
): DecayedEvidenceSummary {
  return {
    provider: candidate.provider,
    model: candidate.model,
    variant: candidate.variant,
    estimates,
    consideredSignalCount: estimates.reduce((sum, estimate) => sum + estimate.sampleCount, 0),
  };
}

function makeEligible(overrides?: Partial<EligibleModelCandidate>): EligibleModelCandidate {
  return {
    provider: "acme",
    model: "model-a",
    variant: "default",
    capabilities: ["agentic", "tools"],
    privacy: "remote",
    observedCostUsd: null,
    observedLatencyMs: null,
    ...overrides,
  };
}

/** Summary with only the given dimensions carrying evidence, at the given level. */
function partialSummary(
  candidate: EligibleModelCandidate,
  evidence: Partial<
    Record<DecayedDimensionEstimate["dimension"], { mean: number; backoffLevel?: EvidenceBackoffLevel }>
  >,
): DecayedEvidenceSummary {
  const estimates = (["quality", "reliability", "cost", "latency"] as const).map((dimension) => {
    const found = evidence[dimension];
    return makeEstimate(dimension, {
      mean: found?.mean ?? null,
      ...(found?.backoffLevel === undefined ? {} : { backoffLevel: found.backoffLevel }),
    });
  });
  return makeSummary(candidate, estimates);
}

function rankWithLoader(
  eligible: ReadonlyArray<EligibleModelCandidate>,
  summaries: ReadonlyArray<DecayedEvidenceSummary>,
  preset: Parameters<typeof rankEligibleModels>[1]["preset"] = "balanced",
  priors?: Parameters<typeof rankEligibleModels>[1]["priors"],
): ReadonlyArray<RankedModelCandidate> {
  const { ranked } = rankEligibleModels(undefined as never, {
    eligible,
    preset,
    now: NOW,
    ...(priors === undefined ? {} : { priors }),
    loadEvidence: (candidate) => {
      const summary = summaries.find(
        (entry) =>
          entry.provider === candidate.provider &&
          entry.model === candidate.model &&
          entry.variant === candidate.variant,
      );
      if (!summary) {
        throw new Error(`no summary prepared for ${candidate.model}`);
      }
      return summary;
    },
  });
  return ranked;
}

function contributionOf(
  candidate: RankedModelCandidate | undefined,
  dimension: string,
): RankedModelCandidate["contributions"][number] {
  const contribution = candidate?.contributions.find((entry) => entry.dimension === dimension);
  if (!contribution) {
    throw new Error(`missing ${dimension} contribution`);
  }
  return contribution;
}

test("balanced utility is the quality-dominant weighted average of all known dimensions", () => {
  const strong = makeEligible({ model: "strong" });
  const weak = makeEligible({ model: "weak" });
  const ranked = rankWithLoader(
    [strong, weak],
    [
      partialSummary(strong, {
        quality: { mean: 0.9 },
        reliability: { mean: 1 },
        cost: { mean: 0.01 },
        latency: { mean: 1000 },
      }),
      partialSummary(weak, {
        quality: { mean: 0.5 },
        reliability: { mean: 0.5 },
        cost: { mean: 0.03 },
        latency: { mean: 3000 },
      }),
    ],
  );

  // Cost/latency scores are relative across the set: strong is cheapest and
  // fastest (1), weak is the most expensive and slowest (0).
  expect(ranked[0]?.model).toBe("strong");
  expect(ranked[0]?.utility).toBeCloseTo(0.5 * 0.9 + 0.2 * 1 + 0.15 * 1 + 0.15 * 1, 10);
  expect(ranked[1]?.model).toBe("weak");
  expect(ranked[1]?.utility).toBeCloseTo(0.5 * 0.5 + 0.2 * 0.5, 10);
});

test("presets alter weights, not safety floors: economy flips a quality/cost tradeoff", () => {
  const premium = makeEligible({ model: "premium" });
  const budget = makeEligible({ model: "budget" });
  const summaries = [
    partialSummary(premium, {
      quality: { mean: 1 },
      reliability: { mean: 1 },
      cost: { mean: 0.03 },
      latency: { mean: 3000 },
    }),
    partialSummary(budget, {
      quality: { mean: 0.6 },
      reliability: { mean: 0.6 },
      cost: { mean: 0.01 },
      latency: { mean: 1000 },
    }),
  ];

  const byQuality = rankWithLoader([premium, budget], summaries, "quality");
  expect(byQuality[0]?.model).toBe("premium");

  const byEconomy = rankWithLoader([premium, budget], summaries, "economy");
  expect(byEconomy[0]?.model).toBe("budget");
});

test("coarse-profile evidence is discounted through backoff-level weights", () => {
  const exact = makeEligible({ model: "exact" });
  const coarse = makeEligible({ model: "coarse" });
  const ranked = rankWithLoader(
    [exact, coarse],
    [
      partialSummary(exact, { quality: { mean: 0.8 }, cost: { mean: 0.02 } }),
      partialSummary(coarse, {
        quality: { mean: 0.8 },
        cost: { mean: 0.02, backoffLevel: 3 },
      }),
    ],
  );

  expect(ranked[0]?.model).toBe("exact");
  const exactCost = contributionOf(ranked[0], "cost");
  expect(exactCost.effectiveWeight).toBeCloseTo(0.15, 10);
  const coarseCost = contributionOf(ranked[1], "cost");
  expect(coarseCost.backoffLevel).toBe(3);
  expect(coarseCost.effectiveWeight).toBeCloseTo(0.15 * 0.25, 10);
  expect(ranked[1]?.utility).toBeLessThan(ranked[0]?.utility ?? 0);
});

test("evidence-free dimensions are dropped and the remaining weights renormalize", () => {
  const only = makeEligible({ model: "only-quality" });
  const [ranked] = rankWithLoader(
    [only],
    [partialSummary(only, { quality: { mean: 0.7 } })],
  );

  expect(ranked?.utility).toBe(0.7);
  expect(contributionOf(ranked, "quality").normalizedWeight).toBe(1);
  expect(contributionOf(ranked, "reliability").score).toBeNull();
  expect(contributionOf(ranked, "reliability").normalizedWeight).toBeNull();
  expect(contributionOf(ranked, "cost").score).toBeNull();
  expect(contributionOf(ranked, "latency").score).toBeNull();
});

test("cost scores are relative to the eligible set: cheapest 1, dearest 0, middle 0.5", () => {
  const cheap = makeEligible({ model: "cheap" });
  const middle = makeEligible({ model: "middle" });
  const dear = makeEligible({ model: "dear" });
  const ranked = rankWithLoader(
    [cheap, middle, dear],
    [
      partialSummary(cheap, { quality: { mean: 0.5 }, cost: { mean: 0.01 } }),
      partialSummary(middle, { quality: { mean: 0.5 }, cost: { mean: 0.02 } }),
      partialSummary(dear, { quality: { mean: 0.5 }, cost: { mean: 0.03 } }),
    ],
  );

  expect(contributionOf(ranked[0], "cost").score).toBe(1);
  expect(contributionOf(ranked[1], "cost").score).toBeCloseTo(0.5, 10);
  expect(contributionOf(ranked[2], "cost").score).toBe(0);
});

test("a single candidate or equal costs give every known cost a score of 1", () => {
  const solo = makeEligible({ model: "solo" });
  const [soloRanked] = rankWithLoader(
    [solo],
    [partialSummary(solo, { quality: { mean: 0.5 }, cost: { mean: 0.05 } })],
  );
  expect(contributionOf(soloRanked, "cost").score).toBe(1);
  expect(soloRanked?.utility).toBeCloseTo((0.5 * 0.5 + 0.15 * 1) / 0.65, 10);

  const first = makeEligible({ model: "first" });
  const second = makeEligible({ model: "second" });
  const tied = rankWithLoader(
    [first, second],
    [
      partialSummary(first, { quality: { mean: 0.9 }, cost: { mean: 0.02 } }),
      partialSummary(second, { quality: { mean: 0.1 }, cost: { mean: 0.02 } }),
    ],
  );
  expect(contributionOf(tied[0], "cost").score).toBe(1);
  expect(contributionOf(tied[1], "cost").score).toBe(1);
});

test("candidates without any evidence score 0 and keep their input order", () => {
  const first = makeEligible({ model: "first" });
  const second = makeEligible({ model: "second" });
  const ranked = rankWithLoader(
    [first, second],
    [partialSummary(first, {}), partialSummary(second, {})],
  );

  expect(ranked.map((candidate) => candidate.model)).toEqual(["first", "second"]);
  for (const candidate of ranked) {
    expect(candidate.utility).toBe(0);
    for (const contribution of candidate.contributions) {
      expect(contribution.score).toBeNull();
      expect(contribution.normalizedWeight).toBeNull();
    }
  }
});

test("cold-start priors fill evidence-free dimensions at the coarsest backoff weight", () => {
  const priorBacked = makeEligible({ model: "prior-backed" });
  const unknown = makeEligible({ model: "unknown" });
  const ranked = rankWithLoader(
    [priorBacked, unknown],
    [partialSummary(priorBacked, {}), partialSummary(unknown, {})],
    "balanced",
    [{ provider: "acme", model: "prior-backed", variant: "default", estimates: { quality: 0.9, cost: 0.01 } }],
  );

  expect(ranked[0]?.model).toBe("prior-backed");
  // Renormalization cancels the coarse-level discount when every contributing
  // dimension shares it: utility is the plain preset-weighted prior average.
  expect(ranked[0]?.utility).toBeCloseTo((0.5 * 0.9 + 0.15 * 1) / 0.65, 10);
  const priorQuality = contributionOf(ranked[0], "quality");
  expect(priorQuality.backoffLevel).toBe(3);
  expect(priorQuality.sampleCount).toBe(0);
  expect(priorQuality.effectiveWeight).toBeCloseTo(0.5 * 0.25, 10);
  expect(ranked[1]?.model).toBe("unknown");
  expect(ranked[1]?.utility).toBe(0);
});

test("recorded evidence overrides priors dimension by dimension", () => {
  const hybrid = makeEligible({ model: "hybrid" });
  const summary = makeSummary(hybrid, [
    makeEstimate("quality", { mean: 0.2, sampleCount: 2, effectiveSampleSize: 2 }),
    makeEstimate("reliability"),
  ]);
  const ranked = rankWithLoader(
    [hybrid],
    [summary],
    "balanced",
    [{ provider: "acme", model: "hybrid", variant: "default", estimates: { quality: 0.9, reliability: 1 } }],
  );

  const quality = contributionOf(ranked[0], "quality");
  expect(quality.score).toBe(0.2);
  expect(quality.sampleCount).toBe(2);
  expect(quality.backoffLevel).toBe(0);
  const reliability = contributionOf(ranked[0], "reliability");
  expect(reliability.score).toBe(1);
  expect(reliability.sampleCount).toBe(0);
  expect(reliability.backoffLevel).toBe(3);
});

test("rankEligibleModels validates priors", () => {
  const eligible = [makeEligible()];
  const first = eligible[0];
  if (!first) {
    throw new Error("fixture eligible list is empty");
  }
  const base = { eligible, preset: "balanced" as const, now: NOW, loadEvidence: () => partialSummary(first, {}) };
  expect(() =>
    rankEligibleModels(undefined as never, {
      ...base,
      priors: [{ provider: "acme", model: "model-a", variant: "default", estimates: { charm: 1 } as never }],
    }),
  ).toThrow(ModelRankingInputError);
  expect(() =>
    rankEligibleModels(undefined as never, {
      ...base,
      priors: [{ provider: "acme", model: "model-a", variant: "default", estimates: { quality: 1.5 } }],
    }),
  ).toThrow(ModelRankingInputError);
  expect(() =>
    rankEligibleModels(undefined as never, {
      ...base,
      priors: [{ provider: "acme", model: "model-a", variant: "default", estimates: { cost: -1 } }],
    }),
  ).toThrow(ModelRankingInputError);
  expect(() =>
    rankEligibleModels(undefined as never, {
      ...base,
      priors: [
        { provider: "acme", model: "model-a", variant: "default", estimates: {} },
        { provider: "acme", model: "model-a", variant: "default", estimates: { quality: 0.5 } },
      ],
    }),
  ).toThrow(ModelRankingInputError);
  expect(() =>
    rankEligibleModels(undefined as never, {
      ...base,
      priors: [{ provider: "acme", model: "model-a", estimates: {} } as never],
    }),
  ).toThrow(ModelRankingInputError);
});

test("ranking is utility-descending and exact ties preserve input order", () => {
  const first = makeEligible({ model: "first" });
  const second = makeEligible({ model: "second" });
  const third = makeEligible({ model: "third", provider: "other" });
  const ranked = rankWithLoader(
    [first, second, third],
    [
      partialSummary(first, { quality: { mean: 0.5 } }),
      partialSummary(second, { quality: { mean: 0.9 } }),
      partialSummary(third, { quality: { mean: 0.5 } }),
    ],
  );

  expect(ranked.map((candidate) => `${candidate.provider}/${candidate.model}`)).toEqual([
    "acme/second",
    "acme/first",
    "other/third",
  ]);
  expect(ranked[1]?.utility).toBe(ranked[2]?.utility);
});

test("an empty eligible list ranks to an empty list", () => {
  const { ranked } = rankEligibleModels(undefined as never, {
    eligible: [],
    preset: "balanced",
    now: NOW,
  });
  expect(ranked).toEqual([]);
});

test("rankEligibleModels validates its input", () => {
  const eligible = [makeEligible()];
  expect(() =>
    rankEligibleModels(undefined as never, {
      eligible,
      preset: "fastest" as never,
      now: NOW,
    }),
  ).toThrow(ModelRankingInputError);
  expect(() =>
    rankEligibleModels(undefined as never, {
      eligible,
      preset: "balanced",
      now: new Date("not-a-date"),
    }),
  ).toThrow(ModelRankingInputError);
  expect(() =>
    rankEligibleModels(undefined as never, {
      eligible: [makeEligible({ model: "" })],
      preset: "balanced",
      now: NOW,
    }),
  ).toThrow(ModelRankingInputError);
  expect(() =>
    rankEligibleModels(undefined as never, {
      eligible,
      preset: "balanced",
      now: NOW,
      halfLifeDays: 0,
    }),
  ).toThrow(ModelRankingInputError);
  expect(() =>
    rankEligibleModels(undefined as never, {
      eligible,
      preset: "balanced",
      now: NOW,
      maxAgeDays: -5,
    }),
  ).toThrow(ModelRankingInputError);
  expect(() =>
    rankEligibleModels(undefined as never, {
      eligible,
      preset: "balanced",
      now: NOW,
      loadEvidence: 42 as never,
    }),
  ).toThrow(ModelRankingInputError);
  expect(() =>
    rankEligibleModels(undefined as never, {
      eligible: "nope" as never,
      preset: "balanced",
      now: NOW,
    }),
  ).toThrow(ModelRankingInputError);
});

function withTestDatabase(run: (connection: SqliteConnection, projectId: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-model-ranking-"));
  const connection = openSqliteConnection(join(directory, "memory.sqlite"));
  migrateSqliteSchema(connection, releaseSchemaMigrations);
  const { project } = resolveProjectIdentity(connection, { projectPath: "/repos/test-project" });
  try {
    run(connection, project.id);
  } finally {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function recordQualityEvidence(
  connection: SqliteConnection,
  projectId: string,
  sessionId: string,
  provider: string,
  model: string,
  value: number,
): void {
  const task = createTask(connection, { projectId, sessionId, boundary: "top-level", now: NOW });
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
      summary: "Ranking fixture task.",
    },
    now: NOW,
  });
  const execution = recordExecutionProfile(connection, {
    taskId: task.taskId,
    provider,
    model,
    variant: "default",
    agent: "build",
    selectionSource: "host",
    startedAt: NOW,
    completedAt: new Date(NOW.getTime() + 5_000),
    latencyMs: 5000,
    tokens: { input: 100, output: 50, reasoning: 10, cacheRead: 20, cacheWrite: 5 },
    costUsd: 0.01,
    finishState: "stop",
  });
  recordOutcomeSignal(connection, {
    taskId: task.taskId,
    executionId: execution.executionId,
    dimension: "quality",
    kind: "test-kind",
    source: "test-source",
    confidence: 1,
    value,
    observedAt: NOW,
    now: NOW,
  });
}

test("ranking integrates with decayed aggregation over the live database", () => {
  withTestDatabase((connection, projectId) => {
    recordQualityEvidence(connection, projectId, "session-1", "acme", "big", 1);
    recordQualityEvidence(connection, projectId, "session-2", "acme", "big", 1);
    recordQualityEvidence(connection, projectId, "session-3", "acme", "small", 0);
    recordQualityEvidence(connection, projectId, "session-4", "acme", "small", 0);

    const { preset, ranked } = rankEligibleModels(connection, {
      eligible: [
        makeEligible({ model: "small" }),
        makeEligible({ model: "big" }),
      ],
      preset: "balanced",
      now: NOW,
      targetProfile: { activity: "implement", domain: "backend", complexity: "medium" },
    });

    expect(preset).toBe("balanced");
    expect(ranked.map((candidate) => candidate.model)).toEqual(["big", "small"]);
    expect(ranked[0]?.utility).toBe(1);
    expect(ranked[1]?.utility).toBe(0);

    const bigQuality = contributionOf(ranked[0], "quality");
    expect(bigQuality.backoffLevel).toBe(0);
    expect(bigQuality.mean).toBe(1);
    expect(bigQuality.sampleCount).toBe(2);
    expect(bigQuality.normalizedWeight).toBe(1);
  });
});

test("the default loader aggregates per exact model and variant", () => {
  withTestDatabase((connection, projectId) => {
    recordQualityEvidence(connection, projectId, "session-1", "acme", "big", 1);
    const thinkingTask = createTask(connection, {
      projectId,
      sessionId: "session-2",
      boundary: "top-level",
      now: NOW,
    });
    persistTaskProfile(connection, {
      taskId: thinkingTask.taskId,
      profile: {
        taxonomyVersion: 1,
        activity: "implement",
        domain: "backend",
        complexity: "medium",
        risk: "low",
        stack: ["typescript"],
        signals: ["activity-lexical"],
        summary: "Ranking fixture task.",
      },
      now: NOW,
    });
    const thinkingExecution = recordExecutionProfile(connection, {
      taskId: thinkingTask.taskId,
      provider: "acme",
      model: "big",
      variant: "thinking",
      agent: "build",
      selectionSource: "host",
      startedAt: NOW,
      completedAt: new Date(NOW.getTime() + 5_000),
      latencyMs: 5000,
      tokens: { input: 100, output: 50, reasoning: 10, cacheRead: 20, cacheWrite: 5 },
      costUsd: 0.01,
      finishState: "stop",
    });
    recordOutcomeSignal(connection, {
      taskId: thinkingTask.taskId,
      executionId: thinkingExecution.executionId,
      dimension: "quality",
      kind: "test-kind",
      source: "test-source",
      confidence: 1,
      value: 0,
      observedAt: NOW,
      now: NOW,
    });

    const { ranked } = rankEligibleModels(connection, {
      eligible: [
        makeEligible({ model: "unheard-of" }),
        makeEligible({ model: "big", variant: "default" }),
        makeEligible({ model: "big", variant: "thinking" }),
      ],
      preset: "balanced",
      now: NOW,
    });

    expect(ranked[0]?.model).toBe("big");
    expect(ranked[0]?.variant).toBe("default");
    expect(ranked[0]?.utility).toBe(1);
    const unheardOf = ranked.find((candidate) => candidate.model === "unheard-of");
    const thinking = ranked.find(
      (candidate) => candidate.model === "big" && candidate.variant === "thinking",
    );
    expect(unheardOf?.utility).toBe(0);
    expect(
      unheardOf?.contributions.every((contribution) => contribution.score === null),
    ).toBe(true);
    expect(thinking?.utility).toBe(0);
    // The thinking variant keeps only its own evidence — the default variant's
    // quality-1 signals do not leak across variants.
    expect(contributionOf(thinking, "quality").score).toBe(0);
    expect(contributionOf(thinking, "quality").sampleCount).toBe(1);
  });
});

test("injected evidence overrides the database without touching it", () => {
  withTestDatabase((connection, projectId) => {
    recordQualityEvidence(connection, projectId, "session-1", "acme", "db-model", 1);

    const winner = makeEligible({ model: "injected-winner" });
    const loser = makeEligible({ model: "injected-loser" });
    const { ranked } = rankEligibleModels(connection, {
      eligible: [loser, winner],
      preset: "balanced",
      now: NOW,
      loadEvidence: (candidate) =>
        candidate.model === "injected-winner"
          ? partialSummary(candidate, { quality: { mean: 1 } })
          : partialSummary(candidate, { quality: { mean: 0 } }),
    });

    expect(ranked.map((candidate) => candidate.model)).toEqual(["injected-winner", "injected-loser"]);
  });
});

test("summaries agree with direct aggregation for the same evidence", () => {
  withTestDatabase((connection, projectId) => {
    recordQualityEvidence(connection, projectId, "session-1", "acme", "big", 1);
    const summary = aggregateDecayedEvidence(connection, {
      provider: "acme",
      model: "big",
      variant: "default",
      now: NOW,
      targetProfile: { activity: "implement", domain: "backend", complexity: "medium" },
    });
    const ranked = rankEligibleModels(connection, {
      eligible: [makeEligible({ model: "big" })],
      preset: "balanced",
      now: NOW,
      targetProfile: { activity: "implement", domain: "backend", complexity: "medium" },
    });
    const direct = summary.estimates.find((estimate) => estimate.dimension === "quality");
    if (!direct) {
      throw new Error("aggregation did not return a quality estimate");
    }
    const viaRanking = contributionOf(ranked.ranked[0], "quality");
    expect(viaRanking.mean).toBe(direct.mean);
    expect(viaRanking.sampleCount).toBe(direct.sampleCount);
    expect(viaRanking.backoffLevel).toBe(direct.backoffLevel);
    expect(summary.consideredSignalCount).toBe(viaRanking.sampleCount);
  });
});
