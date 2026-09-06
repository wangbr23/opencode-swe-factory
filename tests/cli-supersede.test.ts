import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  migrateSqliteSchema,
  openSqliteConnection,
  proposeLessonCandidate,
  releaseSchemaMigrations,
  reviewLessonCandidate,
  type SecretScanResult,
  type SqliteConnection,
} from "../src/core/index.js";
import { main } from "../src/cli/index.js";

function withTestDatabase(run: (dbPath: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-cli-supersede-"));
  const dbPath = join(directory, "memory.sqlite");
  const connection = openSqliteConnection(dbPath);
  migrateSqliteSchema(connection, releaseSchemaMigrations);
  connection.close();
  try {
    run(dbPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const clearScan: SecretScanResult = {
  disposition: "clear",
  findings: [],
  redactedText: "",
};

function createApprovedLesson(dbPath: string): string {
  const connection = openSqliteConnection(dbPath);
  try {
    migrateSqliteSchema(connection, releaseSchemaMigrations);
    const candidate = proposeLessonCandidate(connection, {
      projectId: null,
      scope: "global",
      draft: {
        title: "Original title",
        body: "Original body content",
        rationale: "Original rationale",
        applicability: { taskTypes: ["commit"] },
        provenance: { source: "correction" },
      },
      secretScan: clearScan,
    });
    const outcome = reviewLessonCandidate(connection, {
      candidateId: candidate.id,
      decision: "approve",
    });
    if (outcome.status !== "approved") throw new Error("Expected approval");
    return outcome.lesson.lessonId;
  } finally {
    connection.close();
  }
}

function captureConsole() {
  const logged: string[] = [];
  const errors: string[] = [];
  const log = spyOn(console, "log").mockImplementation((message: string) => {
    logged.push(message);
  });
  const error = spyOn(console, "error").mockImplementation((message: string) => {
    errors.push(message);
  });
  return {
    logged,
    errors,
    restore() {
      log.mockRestore();
      error.mockRestore();
    },
  };
}

test("supersede replaces active version with new content", () => {
  withTestDatabase((dbPath) => {
    const lessonId = createApprovedLesson(dbPath);
    const console_ = captureConsole();
    try {
      const code = main([
        "supersede", lessonId,
        "--title", "Updated title",
        "--body", "Updated body content",
        "--rationale", "Improved wording",
        "--database", dbPath,
      ]);
      expect(code).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain("Superseding lesson");
      expect(output).toContain("Current title: Original title");
      expect(output).toContain("New title:     Updated title");
      expect(output).toContain("Superseded v1 with v2");
      expect(output).toContain("Active version is now v2");
    } finally {
      console_.restore();
    }
  });
});

test("supersede updates the lesson so inspection shows new content", () => {
  withTestDatabase((dbPath) => {
    const lessonId = createApprovedLesson(dbPath);
    const c1 = captureConsole();
    try {
      main([
        "supersede", lessonId,
        "--title", "Updated title",
        "--body", "Updated body",
        "--rationale", "Better",
        "--database", dbPath,
      ]);
    } finally {
      c1.restore();
    }

    const c2 = captureConsole();
    try {
      expect(main(["lesson", lessonId, "--database", dbPath])).toBe(0);
      const output = c2.logged.join("\n");
      expect(output).toContain("Versions:   2");
      expect(output).toContain("Active version (v2)");
      expect(output).toContain("Title:     Updated title");
      expect(output).toContain("Body:      Updated body");
    } finally {
      c2.restore();
    }
  });
});

test("supersede fails for nonexistent lesson", () => {
  withTestDatabase((dbPath) => {
    const console_ = captureConsole();
    try {
      const code = main([
        "supersede", "nonexistent-id",
        "--title", "T",
        "--body", "B",
        "--rationale", "R",
        "--database", dbPath,
      ]);
      expect(code).toBe(1);
      expect(console_.errors.join("\n")).toContain("not found");
    } finally {
      console_.restore();
    }
  });
});

test("supersede fails without lesson id", () => {
  withTestDatabase((dbPath) => {
    const console_ = captureConsole();
    try {
      const code = main([
        "supersede",
        "--title", "T",
        "--body", "B",
        "--rationale", "R",
        "--database", dbPath,
      ]);
      expect(code).toBe(1);
      expect(console_.errors.join("\n")).toContain("Usage: supersede");
    } finally {
      console_.restore();
    }
  });
});

test("supersede fails without --title", () => {
  withTestDatabase((dbPath) => {
    const lessonId = createApprovedLesson(dbPath);
    const console_ = captureConsole();
    try {
      const code = main([
        "supersede", lessonId,
        "--body", "B",
        "--rationale", "R",
        "--database", dbPath,
      ]);
      expect(code).toBe(1);
      expect(console_.errors.join("\n")).toContain("--title, --body, and --rationale are required");
    } finally {
      console_.restore();
    }
  });
});

test("supersede fails without --body", () => {
  withTestDatabase((dbPath) => {
    const lessonId = createApprovedLesson(dbPath);
    const console_ = captureConsole();
    try {
      const code = main([
        "supersede", lessonId,
        "--title", "T",
        "--rationale", "R",
        "--database", dbPath,
      ]);
      expect(code).toBe(1);
      expect(console_.errors.join("\n")).toContain("--title, --body, and --rationale are required");
    } finally {
      console_.restore();
    }
  });
});

test("supersede fails without --rationale", () => {
  withTestDatabase((dbPath) => {
    const lessonId = createApprovedLesson(dbPath);
    const console_ = captureConsole();
    try {
      const code = main([
        "supersede", lessonId,
        "--title", "T",
        "--body", "B",
        "--database", dbPath,
      ]);
      expect(code).toBe(1);
      expect(console_.errors.join("\n")).toContain("--title, --body, and --rationale are required");
    } finally {
      console_.restore();
    }
  });
});

test("supersede can be applied multiple times", () => {
  withTestDatabase((dbPath) => {
    const lessonId = createApprovedLesson(dbPath);

    const c1 = captureConsole();
    try {
      expect(main([
        "supersede", lessonId,
        "--title", "V2",
        "--body", "Body v2",
        "--rationale", "First update",
        "--database", dbPath,
      ])).toBe(0);
    } finally {
      c1.restore();
    }

    const c2 = captureConsole();
    try {
      expect(main([
        "supersede", lessonId,
        "--title", "V3",
        "--body", "Body v3",
        "--rationale", "Second update",
        "--database", dbPath,
      ])).toBe(0);
      const output = c2.logged.join("\n");
      expect(output).toContain("Superseded v2 with v3");
      expect(output).toContain("Active version is now v3");
    } finally {
      c2.restore();
    }
  });
});

test("supersede preserves applicability and provenance from current version", () => {
  withTestDatabase((dbPath) => {
    const lessonId = createApprovedLesson(dbPath);

    const c1 = captureConsole();
    try {
      main([
        "supersede", lessonId,
        "--title", "New",
        "--body", "New body",
        "--rationale", "Update",
        "--database", dbPath,
      ]);
    } finally {
      c1.restore();
    }

    const c2 = captureConsole();
    try {
      expect(main(["lesson", lessonId, "--database", dbPath])).toBe(0);
      const output = c2.logged.join("\n");
      expect(output).toContain("Title:     New");
      expect(output).toContain("Body:      New body");
    } finally {
      c2.restore();
    }
  });
});
