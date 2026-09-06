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

const acknowledgmentScan: SecretScanResult = {
  disposition: "acknowledgment-required",
  findings: [
    {
      confidence: "low",
      kinds: ["hash"],
      region: { start: 0, end: 10 },
      scannerRuleIds: ["test-rule"],
    },
  ],
  redactedText: "[REDACTED] rest",
};

async function withTestDatabase(run: (databasePath: string, connection: SqliteConnection) => void | Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-cli-review-"));
  const databasePath = join(directory, "memory.sqlite");
  const connection = openSqliteConnection(databasePath);
  migrateSqliteSchema(connection, releaseSchemaMigrations);
  try {
    await run(databasePath, connection);
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

function insertCandidate(
  connection: SqliteConnection,
  overrides?: Partial<{
    title: string;
    body: string;
    scope: "project" | "global";
    projectId: string | null;
    secretScan: SecretScanResult;
  }>,
) {
  const projectId = overrides?.projectId ?? null;
  if (projectId) {
    connection.database.run(
      "INSERT OR IGNORE INTO projects (id, path, created_at, updated_at) VALUES (?, ?, ?, ?)",
      [projectId, `/repos/${projectId}`, new Date().toISOString(), new Date().toISOString()],
    );
  }

  return proposeLessonCandidate(connection, {
    projectId,
    scope: overrides?.scope ?? "global",
    draft: {
      title: overrides?.title ?? "Run tests before commits",
      body: overrides?.body ?? "Always run bun test before committing changes to the repository",
      rationale: "User corrected a commit without tests.",
      applicability: { taskTypes: ["commit"] },
      provenance: { source: "correction" },
    },
    secretScan: overrides?.secretScan ?? clearScan,
    reviewWindowDays: 36500,
  });
}

function insertApprovedLesson(
  connection: SqliteConnection,
  input: { title: string; body: string; scope: "project" | "global"; projectId: string | null },
) {
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

test("review lists pending candidates", async () => {
  await withTestDatabase(async (databasePath, connection) => {
    const candidate = insertCandidate(connection);
    connection.close();

    const console_ = captureConsole();
    try {
      expect(await main(["review", "--database", databasePath])).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain("Pending lesson candidates (1)");
      expect(output).toContain(candidate.id);
      expect(output).toContain("Run tests before commits");
    } finally {
      console_.restore();
    }
  });
});

test("review shows empty message when no candidates exist", async () => {
  await withTestDatabase(async (databasePath, connection) => {
    connection.close();

    const console_ = captureConsole();
    try {
      expect(await main(["review", "--database", databasePath])).toBe(0);
      expect(console_.logged.join("\n")).toContain("No pending lesson candidates");
    } finally {
      console_.restore();
    }
  });
});

test("review candidate shows details and processes approval", async () => {
  await withTestDatabase(async (databasePath, connection) => {
    const candidate = insertCandidate(connection);
    connection.close();

    const console_ = captureConsole();
    try {
      const result = await main(["review", candidate.id, "--database", databasePath], {
        readLine: () => "a",
      });
      expect(result).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain("Run tests before commits");
      expect(output).toContain("Always run bun test");
      expect(output).toContain("Scope:     global");
      expect(output).toContain("Secrets:   clear");
      expect(output).toContain("Approved as lesson");
    } finally {
      console_.restore();
    }
  });
});

test("review candidate processes rejection", async () => {
  await withTestDatabase(async (databasePath, connection) => {
    const candidate = insertCandidate(connection);
    connection.close();

    const console_ = captureConsole();
    try {
      expect(await main(["review", candidate.id, "--database", databasePath], {
        readLine: () => "r",
      })).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain("Rejected and deleted candidate");
      expect(output).toContain(candidate.id);
    } finally {
      console_.restore();
    }
  });
});

test("review candidate processes deferral", async () => {
  await withTestDatabase(async (databasePath, connection) => {
    const candidate = insertCandidate(connection);
    connection.close();

    const console_ = captureConsole();
    try {
      expect(await main(["review", candidate.id, "--database", databasePath], {
        readLine: () => "d",
      })).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain("Deferred candidate");
      expect(output).toContain(candidate.id);
    } finally {
      console_.restore();
    }
  });
});

test("review candidate handles quit without acting", async () => {
  await withTestDatabase(async (databasePath, connection) => {
    const candidate = insertCandidate(connection);
    connection.close();

    const console_ = captureConsole();
    try {
      expect(await main(["review", candidate.id, "--database", databasePath], {
        readLine: () => "q",
      })).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain("Skipped");
      expect(output).not.toContain("Approved");
      expect(output).not.toContain("Rejected");
    } finally {
      console_.restore();
    }
  });
});

test("review candidate shows overlapping lessons", async () => {
  await withTestDatabase(async (databasePath, connection) => {
    insertApprovedLesson(connection, {
      title: "Run tests before commits",
      body: "Always run bun test before committing changes to the repository",
      scope: "global",
      projectId: null,
    });

    const candidate = insertCandidate(connection, {
      title: "Run tests before commits",
      body: "Always run bun test before committing changes to the repository",
    });
    connection.close();

    const console_ = captureConsole();
    try {
      expect(await main(["review", candidate.id, "--database", databasePath], {
        readLine: () => "q",
      })).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain("Overlapping lessons (1)");
      expect(output).toContain("DUPLICATE");
    } finally {
      console_.restore();
    }
  });
});

test("review candidate shows no overlaps when none exist", async () => {
  await withTestDatabase(async (databasePath, connection) => {
    const candidate = insertCandidate(connection);
    connection.close();

    const console_ = captureConsole();
    try {
      expect(await main(["review", candidate.id, "--database", databasePath], {
        readLine: () => "q",
      })).toBe(0);
      expect(console_.logged.join("\n")).toContain("No overlapping lessons found");
    } finally {
      console_.restore();
    }
  });
});

test("review candidate warns about secret acknowledgment requirement", async () => {
  await withTestDatabase(async (databasePath, connection) => {
    const candidate = insertCandidate(connection, { secretScan: acknowledgmentScan });
    connection.close();

    const console_ = captureConsole();
    try {
      expect(await main(["review", candidate.id, "--database", databasePath], {
        readLine: () => "q",
      })).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain("Secrets:   acknowledgment-required");
      expect(output).toContain("--acknowledge-secret-risk");
    } finally {
      console_.restore();
    }
  });
});

test("review candidate approval with --acknowledge-secret-risk succeeds", async () => {
  await withTestDatabase(async (databasePath, connection) => {
    const candidate = insertCandidate(connection, { secretScan: acknowledgmentScan });
    connection.close();

    const console_ = captureConsole();
    try {
      expect(await main(
        ["review", candidate.id, "--database", databasePath, "--acknowledge-secret-risk"],
        { readLine: () => "a" },
      )).toBe(0);
      expect(console_.logged.join("\n")).toContain("Approved as lesson");
    } finally {
      console_.restore();
    }
  });
});

test("review candidate fails for nonexistent ID", async () => {
  await withTestDatabase(async (databasePath, connection) => {
    connection.close();

    const console_ = captureConsole();
    try {
      expect(await main(["review", "nonexistent-id", "--database", databasePath], {
        readLine: () => "a",
      })).toBe(1);
      expect(console_.errors.join("\n")).toContain("not found or expired");
    } finally {
      console_.restore();
    }
  });
});

test("review handles null readline as quit", async () => {
  await withTestDatabase(async (databasePath, connection) => {
    const candidate = insertCandidate(connection);
    connection.close();

    const console_ = captureConsole();
    try {
      expect(await main(["review", candidate.id, "--database", databasePath], {
        readLine: () => null,
      })).toBe(0);
      expect(console_.logged.join("\n")).toContain("Skipped");
    } finally {
      console_.restore();
    }
  });
});

test("review retries on invalid input before accepting valid decision", async () => {
  await withTestDatabase(async (databasePath, connection) => {
    const candidate = insertCandidate(connection);
    connection.close();

    const responses = ["invalid", "nope", "r"];
    let callIndex = 0;

    const console_ = captureConsole();
    try {
      expect(await main(["review", candidate.id, "--database", databasePath], {
        readLine: () => responses[callIndex++] ?? null,
      })).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain("Invalid choice");
      expect(output).toContain("Rejected and deleted candidate");
    } finally {
      console_.restore();
    }
  });
});
