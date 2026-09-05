import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../src/cli/index.js";
import {
  migrateSqliteSchema,
  openSqliteConnection,
  proposeLessonCandidate,
  releaseSchemaMigrations,
  reviewLessonCandidate,
  type SecretScanResult,
  type SqliteConnection,
} from "../src/core/index.js";

const clearScan: SecretScanResult = {
  disposition: "clear",
  findings: [],
  redactedText: "",
};

function withTestDatabase(run: (databasePath: string, connection: SqliteConnection) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-cli-lesson-"));
  const databasePath = join(directory, "memory.sqlite");
  const connection = openSqliteConnection(databasePath);
  migrateSqliteSchema(connection, releaseSchemaMigrations);
  try {
    run(databasePath, connection);
  } finally {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
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

function insertApprovedLesson(
  connection: SqliteConnection,
  input: { title: string; body: string; scope: "project" | "global"; projectId: string | null },
) {
  if (input.projectId) {
    connection.database.run(
      "INSERT OR IGNORE INTO projects (id, path, created_at, updated_at) VALUES (?, ?, ?, ?)",
      [input.projectId, `/repos/${input.projectId}`, new Date().toISOString(), new Date().toISOString()],
    );
  }

  const candidate = proposeLessonCandidate(connection, {
    projectId: input.projectId,
    scope: input.scope,
    draft: {
      title: input.title,
      body: input.body,
      rationale: "Established rule.",
      applicability: {},
      provenance: {},
    },
    secretScan: clearScan,
    reviewWindowDays: 36500,
  });
  return reviewLessonCandidate(connection, { candidateId: candidate.id, decision: "approve" });
}

test("search returns matching lessons", () => {
  withTestDatabase((databasePath, connection) => {
    insertApprovedLesson(connection, {
      title: "Always run tests before committing",
      body: "Execute the full test suite before any git commit to catch regressions early",
      scope: "global",
      projectId: null,
    });
    connection.close();

    const console_ = captureConsole();
    try {
      expect(main(["search", "tests", "committing", "--database", databasePath])).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain("Found 1 lesson(s)");
      expect(output).toContain("Always run tests before committing");
      expect(output).toContain("global");
    } finally {
      console_.restore();
    }
  });
});

test("search shows empty message when no matches", () => {
  withTestDatabase((databasePath, connection) => {
    connection.close();

    const console_ = captureConsole();
    try {
      expect(main(["search", "nonexistent", "--database", databasePath])).toBe(0);
      expect(console_.logged.join("\n")).toContain("No matching lessons found");
    } finally {
      console_.restore();
    }
  });
});

test("search joins multi-word queries", () => {
  withTestDatabase((databasePath, connection) => {
    insertApprovedLesson(connection, {
      title: "Database migration strategy",
      body: "Always create reversible database migrations with up and down methods",
      scope: "global",
      projectId: null,
    });
    connection.close();

    const console_ = captureConsole();
    try {
      expect(main(["search", "database", "migration", "strategy", "--database", databasePath])).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain("Found 1 lesson(s)");
      expect(output).toContain("Database migration strategy");
    } finally {
      console_.restore();
    }
  });
});

test("search filters by --project", () => {
  withTestDatabase((databasePath, connection) => {
    insertApprovedLesson(connection, {
      title: "Use strict mode in TypeScript",
      body: "Enable strict mode in tsconfig for better type safety",
      scope: "project",
      projectId: "project-alpha",
    });
    insertApprovedLesson(connection, {
      title: "Use strict mode everywhere",
      body: "Enable strict mode in tsconfig for all projects",
      scope: "project",
      projectId: "project-beta",
    });
    connection.close();

    const console_ = captureConsole();
    try {
      expect(main(["search", "strict", "mode", "--project", "project-alpha", "--database", databasePath])).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain("project:project-alpha");
      expect(output).not.toContain("project-beta");
    } finally {
      console_.restore();
    }
  });
});

test("search fails without query argument", () => {
  withTestDatabase((databasePath, connection) => {
    connection.close();

    const console_ = captureConsole();
    try {
      expect(main(["search", "--database", databasePath])).toBe(1);
      expect(console_.errors.join("\n")).toContain("Usage: search <query>");
    } finally {
      console_.restore();
    }
  });
});

test("lesson inspects a confirmed lesson", () => {
  withTestDatabase((databasePath, connection) => {
    const outcome = insertApprovedLesson(connection, {
      title: "Pin dependency versions",
      body: "Always pin exact versions in package.json to avoid surprise breakage",
      scope: "global",
      projectId: null,
    });
    const lessonId = outcome.status === "approved" ? outcome.lesson.lessonId : "";
    connection.close();

    const console_ = captureConsole();
    try {
      expect(main(["lesson", lessonId, "--database", databasePath])).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain(`Lesson ${lessonId}`);
      expect(output).toContain("Scope:      global");
      expect(output).toContain("Versions:   1");
      expect(output).toContain("Active version (v1)");
      expect(output).toContain("Pin dependency versions");
      expect(output).toContain("Always pin exact versions");
    } finally {
      console_.restore();
    }
  });
});

test("lesson shows project scope with project ID", () => {
  withTestDatabase((databasePath, connection) => {
    const outcome = insertApprovedLesson(connection, {
      title: "Use Bun for testing",
      body: "Use bun:test as the test runner for this project",
      scope: "project",
      projectId: "my-project",
    });
    const lessonId = outcome.status === "approved" ? outcome.lesson.lessonId : "";
    connection.close();

    const console_ = captureConsole();
    try {
      expect(main(["lesson", lessonId, "--database", databasePath])).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain("Scope:      project (my-project)");
    } finally {
      console_.restore();
    }
  });
});

test("lesson fails for nonexistent ID", () => {
  withTestDatabase((databasePath, connection) => {
    connection.close();

    const console_ = captureConsole();
    try {
      expect(main(["lesson", "nonexistent-id", "--database", databasePath])).toBe(1);
      expect(console_.errors.join("\n")).toContain("not found");
    } finally {
      console_.restore();
    }
  });
});

test("lesson fails without ID argument", () => {
  withTestDatabase((databasePath, connection) => {
    connection.close();

    const console_ = captureConsole();
    try {
      expect(main(["lesson", "--database", databasePath])).toBe(1);
      expect(console_.errors.join("\n")).toContain("Usage: lesson <lesson-id>");
    } finally {
      console_.restore();
    }
  });
});

test("search displays version number for each result", () => {
  withTestDatabase((databasePath, connection) => {
    insertApprovedLesson(connection, {
      title: "Use semantic versioning",
      body: "Follow semver conventions for all package releases",
      scope: "global",
      projectId: null,
    });
    connection.close();

    const console_ = captureConsole();
    try {
      expect(main(["search", "semantic", "versioning", "--database", databasePath])).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain("v1");
    } finally {
      console_.restore();
    }
  });
});
