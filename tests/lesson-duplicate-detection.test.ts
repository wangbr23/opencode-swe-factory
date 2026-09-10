import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EMBEDDING_VECTOR_DIMENSIONS } from "../src/types/embedding-types.js";
import {
  DUPLICATE_BODY_THRESHOLD,
  MINIMUM_OVERLAP_THRESHOLD,
  RELATED_SEMANTIC_SIMILARITY_CUTOFF,
  detectLessonDuplicatesAndConflicts,
  indexConfirmedLessonEmbeddings,
  migrateSqliteSchema,
  openSqliteConnection,
  releaseSchemaMigrations,
  type LessonCandidateDraft,
  type LessonScope,
  type SqliteConnection,
} from "../src/core/index.js";

const NOW = "2026-09-05T00:00:00.000Z";

async function withDatabase(run: (connection: SqliteConnection) => void | Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-dup-detection-"));
  const connection = openSqliteConnection(join(directory, "memory.sqlite"));
  migrateSqliteSchema(connection, releaseSchemaMigrations);
  try {
    await run(connection);
  } finally {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function insertProject(connection: SqliteConnection, projectId: string): void {
  connection.database.run("INSERT INTO projects (id, path, created_at, updated_at) VALUES (?, ?, ?, ?)", [
    projectId,
    `/repos/${projectId}`,
    NOW,
    NOW,
  ]);
}

function insertLesson(
  connection: SqliteConnection,
  input: Readonly<{
    id: string;
    scope: LessonScope;
    projectId: string | null;
    title: string;
    body: string;
    activeVersion?: number | null;
  }>,
): void {
  const activeVersion = input.activeVersion === undefined ? 1 : input.activeVersion;
  connection.database.run(
    "INSERT INTO lessons (id, project_id, scope, active_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    [input.id, input.projectId, input.scope, activeVersion, NOW, NOW],
  );
  connection.database.run(
    "INSERT INTO lesson_versions (lesson_id, version, title, body, rationale, applicability_json, provenance_json, created_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?)",
    [
      input.id,
      input.title,
      input.body,
      `Rationale for ${input.id}`,
      JSON.stringify({ activity: "test" }),
      JSON.stringify({ source: "correction" }),
      NOW,
    ],
  );
}

function makeDraft(title: string, body: string): LessonCandidateDraft {
  return {
    title,
    body,
    rationale: "Test rationale",
    applicability: {},
    provenance: {},
  };
}

test("classifies a near-duplicate when body terms overlap substantially", async () => {
  withDatabase(async (connection) => {
    insertProject(connection, "project-a");
    insertLesson(connection, {
      id: "existing-lesson",
      scope: "project",
      projectId: "project-a",
      title: "Run migration tests",
      body: "Always run database migration tests before deploying changes to production",
    });

    const result = await detectLessonDuplicatesAndConflicts(connection, {
      draft: makeDraft(
        "Run migration tests",
        "Run database migration tests before deploying any changes to production",
      ),
      projectId: "project-a",
    });

    expect(result.matches).toHaveLength(1);
    const match = result.matches[0]!;
    expect(match.lessonId).toBe("existing-lesson");
    expect(match.relation).toBe("duplicate");
    expect(match.bodyOverlap).toBeGreaterThanOrEqual(DUPLICATE_BODY_THRESHOLD);
    expect(match.titleOverlap).toBe(1);
  });
});

test("classifies related lessons with different body content as potential conflicts", async () => {
  withDatabase(async (connection) => {
    insertProject(connection, "project-a");
    insertLesson(connection, {
      id: "existing-lesson",
      scope: "project",
      projectId: "project-a",
      title: "Database testing approach",
      body: "Always run database migration tests before deploying to production",
    });

    const result = await detectLessonDuplicatesAndConflicts(connection, {
      draft: makeDraft(
        "Database testing policy",
        "Skip database migration tests in development environments for faster iteration",
      ),
      projectId: "project-a",
    });

    expect(result.matches).toHaveLength(1);
    const match = result.matches[0]!;
    expect(match.lessonId).toBe("existing-lesson");
    expect(match.relation).toBe("potential-conflict");
    expect(match.bodyOverlap).toBeLessThan(DUPLICATE_BODY_THRESHOLD);
    expect(match.bodyOverlap).toBeGreaterThanOrEqual(MINIMUM_OVERLAP_THRESHOLD);
  });
});

test("returns empty when candidate has no lexical overlap with existing lessons", async () => {
  withDatabase(async (connection) => {
    insertProject(connection, "project-a");
    insertLesson(connection, {
      id: "unrelated-lesson",
      scope: "project",
      projectId: "project-a",
      title: "Rollback procedure",
      body: "Use the rollback fixture to verify database reversibility",
    });

    const result = await detectLessonDuplicatesAndConflicts(connection, {
      draft: makeDraft(
        "Code review checklist",
        "Check for memory leaks and race conditions during code reviews",
      ),
      projectId: "project-a",
    });

    expect(result.matches).toEqual([]);
  });
});

test("excludes specified lesson IDs from detection results", async () => {
  withDatabase(async (connection) => {
    insertProject(connection, "project-a");
    insertLesson(connection, {
      id: "keep-this",
      scope: "project",
      projectId: "project-a",
      title: "Run migration tests",
      body: "Always run database migration tests before deploying changes",
    });
    insertLesson(connection, {
      id: "exclude-this",
      scope: "project",
      projectId: "project-a",
      title: "Run migration tests",
      body: "Always run database migration tests before deploying changes",
    });

    const result = await detectLessonDuplicatesAndConflicts(connection, {
      draft: makeDraft(
        "Run migration tests",
        "Always run database migration tests before deploying changes",
      ),
      projectId: "project-a",
      excludeLessonIds: ["exclude-this"],
    });

    expect(result.matches.map((m) => m.lessonId)).toEqual(["keep-this"]);
  });
});

test("filters matches below the minimum overlap threshold", async () => {
  withDatabase(async (connection) => {
    insertProject(connection, "project-a");
    insertLesson(connection, {
      id: "weak-match",
      scope: "global",
      projectId: null,
      title: "Git workflow",
      body: "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey",
    });

    const result = await detectLessonDuplicatesAndConflicts(connection, {
      draft: makeDraft(
        "Deployment checklist",
        "alpha xray yankee zulu one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty",
      ),
      projectId: "project-a",
    });

    expect(result.matches).toEqual([]);
  });
});

test("orders matches by body overlap descending with deterministic tiebreaker", async () => {
  withDatabase(async (connection) => {
    insertProject(connection, "project-a");
    insertLesson(connection, {
      id: "low-overlap",
      scope: "project",
      projectId: "project-a",
      title: "Database testing policy",
      body: "Skip database migration tests in development environments for faster local iteration cycles",
    });
    insertLesson(connection, {
      id: "high-overlap",
      scope: "project",
      projectId: "project-a",
      title: "Run migration tests",
      body: "Always run database migration tests before deploying changes to production environments",
    });

    const result = await detectLessonDuplicatesAndConflicts(connection, {
      draft: makeDraft(
        "Run migration tests",
        "Run database migration tests before deploying any changes to production environments",
      ),
      projectId: "project-a",
    });

    expect(result.matches.length).toBeGreaterThanOrEqual(2);
    expect(result.matches[0]!.lessonId).toBe("high-overlap");
    expect(result.matches[0]!.bodyOverlap).toBeGreaterThan(result.matches[1]!.bodyOverlap);
  });
});

test("respects project scope isolation from underlying retrieval", async () => {
  withDatabase(async (connection) => {
    insertProject(connection, "project-a");
    insertProject(connection, "project-b");
    insertLesson(connection, {
      id: "project-b-lesson",
      scope: "project",
      projectId: "project-b",
      title: "Run migration tests",
      body: "Run database migration tests before deploying changes",
    });

    const result = await detectLessonDuplicatesAndConflicts(connection, {
      draft: makeDraft(
        "Run migration tests",
        "Run database migration tests before deploying changes",
      ),
      projectId: "project-a",
    });

    expect(result.matches).toEqual([]);
  });
});

test("detects duplicates across global and project scopes", async () => {
  withDatabase(async (connection) => {
    insertProject(connection, "project-a");
    insertLesson(connection, {
      id: "global-lesson",
      scope: "global",
      projectId: null,
      title: "Run migration tests",
      body: "Run database migration tests before deploying changes to production",
    });

    const result = await detectLessonDuplicatesAndConflicts(connection, {
      draft: makeDraft(
        "Run migration tests",
        "Run database migration tests before deploying any changes to production",
      ),
      projectId: "project-a",
    });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.lessonId).toBe("global-lesson");
    expect(result.matches[0]!.scope).toBe("global");
    expect(result.matches[0]!.relation).toBe("duplicate");
  });
});

test("returns empty for punctuation-only candidate content", async () => {
  withDatabase(async (connection) => {
    insertProject(connection, "project-a");
    insertLesson(connection, {
      id: "some-lesson",
      scope: "global",
      projectId: null,
      title: "Run migration tests",
      body: "Run database migration tests.",
    });

    const result = await detectLessonDuplicatesAndConflicts(connection, {
      draft: makeDraft("!?---", "...:::"),
      projectId: "project-a",
    });

    expect(result.matches).toEqual([]);
  });
});

test("classifies an exact content duplicate with overlap of 1", async () => {
  withDatabase(async (connection) => {
    insertProject(connection, "project-a");
    insertLesson(connection, {
      id: "original",
      scope: "project",
      projectId: "project-a",
      title: "Run migration tests",
      body: "Always run database migration tests before deploying changes",
    });

    const result = await detectLessonDuplicatesAndConflicts(connection, {
      draft: makeDraft(
        "Run migration tests",
        "Always run database migration tests before deploying changes",
      ),
      projectId: "project-a",
    });

    expect(result.matches).toHaveLength(1);
    const match = result.matches[0]!;
    expect(match.relation).toBe("duplicate");
    expect(match.titleOverlap).toBe(1);
    expect(match.bodyOverlap).toBe(1);
  });
});

test("skips lessons with no active version", async () => {
  await withDatabase(async (connection) => {
    insertProject(connection, "project-a");
    insertLesson(connection, {
      id: "inactive",
      scope: "project",
      projectId: "project-a",
      title: "Run migration tests",
      body: "Run database migration tests before deploying changes",
      activeVersion: null,
    });

    const result = await detectLessonDuplicatesAndConflicts(connection, {
      draft: makeDraft(
        "Run migration tests",
        "Run database migration tests before deploying changes",
      ),
      projectId: "project-a",
    });

    expect(result.matches).toEqual([]);
  });
});

// --- semantic pass ---

/**
 * Deterministic stub embedder with the pinned vector dimensions: database/
 * migration/upgrade texts live on axis 0, code-review texts on axis 1,
 * everything else on axis 2. Same-axis texts have similarity 1.
 */
function embedAxis(text: string): Promise<Float32Array> {
  const lower = text.toLowerCase();
  const vector = new Float32Array(EMBEDDING_VECTOR_DIMENSIONS);
  if (lower.includes("migration") || lower.includes("database") || lower.includes("upgrade")) {
    vector[0] = 1;
  } else if (lower.includes("code") || lower.includes("review")) {
    vector[1] = 1;
  } else {
    vector[2] = 1;
  }
  return Promise.resolve(vector);
}

test("semantic-only hit surfaces as related with zero lexical overlap", async () => {
  await withDatabase(async (connection) => {
    insertProject(connection, "project-a");
    insertLesson(connection, {
      id: "phrased-differently",
      scope: "project",
      projectId: "project-a",
      title: "Schema upgrade verification",
      body: "database migration testing before production deployment",
    });
    await indexConfirmedLessonEmbeddings(connection, { embed: embedAxis, now: new Date(NOW) });

    const result = await detectLessonDuplicatesAndConflicts(connection, {
      draft: makeDraft(
        "Db checks",
        "db upgrade verification ahead of live rollout",
      ),
      projectId: "project-a",
      embed: embedAxis,
    });

    expect(result.matches).toHaveLength(1);
    const match = result.matches[0]!;
    expect(match.lessonId).toBe("phrased-differently");
    expect(match.relation).toBe("related");
    expect(match.titleOverlap).toBe(0);
    expect(match.bodyOverlap).toBe(0);
    expect(match.semanticSimilarity).toBeGreaterThanOrEqual(RELATED_SEMANTIC_SIMILARITY_CUTOFF);
  });
});

test("embedder failure degrades to lexical-only detection", async () => {
  await withDatabase(async (connection) => {
    insertProject(connection, "project-a");
    insertLesson(connection, {
      id: "lexical-match",
      scope: "project",
      projectId: "project-a",
      title: "Run migration tests",
      body: "Always run database migration tests before deploying changes",
    });
    await indexConfirmedLessonEmbeddings(connection, { embed: embedAxis, now: new Date(NOW) });

    const failingEmbed = () => Promise.reject(new Error("Embedder unavailable."));
    const result = await detectLessonDuplicatesAndConflicts(connection, {
      draft: makeDraft(
        "Run migration tests",
        "Always run database migration tests before deploying changes",
      ),
      projectId: "project-a",
      embed: failingEmbed,
    });

    expect(result.matches).toHaveLength(1);
    const match = result.matches[0]!;
    expect(match.relation).toBe("duplicate");
    expect(match.semanticSimilarity).toBeUndefined();
  });
});

test("dedupe keeps lexical metadata when a lesson matches both passes", async () => {
  await withDatabase(async (connection) => {
    insertProject(connection, "project-a");
    insertLesson(connection, {
      id: "both-passes",
      scope: "project",
      projectId: "project-a",
      title: "Run migration tests",
      body: "Always run database migration tests before deploying changes",
    });
    await indexConfirmedLessonEmbeddings(connection, { embed: embedAxis, now: new Date(NOW) });

    const result = await detectLessonDuplicatesAndConflicts(connection, {
      draft: makeDraft(
        "Run migration tests",
        "Always run database migration tests before deploying changes",
      ),
      projectId: "project-a",
      embed: embedAxis,
    });

    expect(result.matches).toHaveLength(1);
    const match = result.matches[0]!;
    expect(match.relation).toBe("duplicate");
    expect(match.bodyOverlap).toBe(1);
    expect(match.lexicalRank).toBeGreaterThan(0);
    expect(match.semanticSimilarity).toBeUndefined();
  });
});

test("semantic hits below the related cutoff are not surfaced", async () => {
  await withDatabase(async (connection) => {
    insertProject(connection, "project-a");
    insertLesson(connection, {
      id: "weak-semantic",
      scope: "project",
      projectId: "project-a",
      title: "Code review checklist",
      body: "Check for memory leaks during code reviews",
    });
    await indexConfirmedLessonEmbeddings(connection, { embed: embedAxis, now: new Date(NOW) });

    const result = await detectLessonDuplicatesAndConflicts(connection, {
      draft: makeDraft(
        "Run migration tests",
        "Always run database migration tests before deploying changes",
      ),
      projectId: "project-a",
      embed: embedAxis,
    });

    expect(result.matches).toEqual([]);
  });
});
