import { expect, test } from "bun:test";

import {
  TASK_ACTIVITY_VALUES,
  TASK_BOUNDARY_VALUES,
  TASK_COMPLEXITY_VALUES,
  TASK_DOMAIN_VALUES,
  TASK_PROFILE_SIGNAL_VALUES,
  TASK_RISK_VALUES,
  TASK_TAXONOMY_VERSION,
  profileTask,
  type ProfileTaskInput,
  type TaskProfile,
} from "../src/core/index.js";

async function profile(overrides: Partial<ProfileTaskInput> = {}): Promise<TaskProfile> {
  return profileTask({
    taskText: overrides.taskText ?? "Add a retry loop to the CLI backup command.",
    boundary: overrides.boundary ?? "top-level",
    ...(overrides.declaredStack === undefined ? {} : { declaredStack: overrides.declaredStack }),
  });
}

test("taxonomy values are unique, non-empty, and versioned", () => {
  for (const values of [
    TASK_ACTIVITY_VALUES,
    TASK_BOUNDARY_VALUES,
    TASK_COMPLEXITY_VALUES,
    TASK_DOMAIN_VALUES,
    TASK_PROFILE_SIGNAL_VALUES,
    TASK_RISK_VALUES,
  ]) {
    expect(new Set(values).size).toBe(values.length);
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(value.length).toBeGreaterThan(0);
    }
  }
  expect(TASK_TAXONOMY_VERSION).toBe(1);
});

test("profiles are deterministic: identical inputs produce identical profiles", async () => {
  const input: ProfileTaskInput = {
    taskText: "Fix the failing migration test and update the sqlite schema.",
    boundary: "subtask",
    declaredStack: ["Bun"],
  };
  expect(await profileTask(input)).toEqual(await profileTask({ ...input }));
  expect(await profileTask({ ...input, declaredStack: ["bun"] })).toEqual(
    await profileTask({ ...input, declaredStack: ["BUN"] }),
  );
});

test("classifies activity from lexical features", async () => {
  expect((await profile({ taskText: "Fix the broken build." })).activity).toBe("fix");
  expect((await profile({ taskText: "Write tests for the backup manager." })).activity).toBe("test");
  expect((await profile({ taskText: "Refactor the config loader." })).activity).toBe("refactor");
  expect((await profile({ taskText: "Update the README documentation." })).activity).toBe("document");
  expect((await profile({ taskText: "Investigate why tests fail." })).activity).toBe("investigate");
  expect((await profile({ taskText: "Add dark mode support." })).activity).toBe("implement");
  expect((await profile({ taskText: "🎉" })).activity).toBeNull();
});

test("classifies domain and stack signals", async () => {
  const security = await profile({ taskText: "Rotate the auth token permissions." });
  expect(security.domain).toBe("security");
  expect(security.risk).toBe("high");

  const frontend = await profile({ taskText: "Style the component for the browser." });
  expect(frontend.domain).toBe("frontend");

  const stacked = await profile({
    taskText: "Migrate the sqlite schema for the api.",
    declaredStack: ["Bun"],
  });
  expect(stacked.stack).toEqual(["bun", "sqlite"]);
  expect(stacked.signals).toContain("declared-stack");
  expect(stacked.signals).toContain("stack-lexical");
});

test("grades complexity from scope and length signals", async () => {
  expect((await profile({ taskText: "Fix typo." })).complexity).toBe("low");
  expect(
    (
      await profile({
        taskText:
          "Add a retry loop to the CLI backup command so transient SQLite locks do not fail the snapshot; wire the interval from config.",
      })
    ).complexity,
  ).toBe("medium");
  expect((await profile({ taskText: "Redesign the migration architecture across systems." })).complexity).toBe("high");
  expect((await profile({ taskText: "x".repeat(601) })).complexity).toBe("high");
});

test("marks destructive or secret-adjacent requests high risk", async () => {
  expect((await profile({ taskText: "Purge the production database rows." })).risk).toBe("high");
  expect((await profile({ taskText: "Delete stale backups." })).risk).toBe("high");
  expect((await profile({ taskText: "Write documentation for the release." })).risk).toBe("low");
  expect((await profile({ taskText: "Refactor the backup manager." })).risk).toBe("medium");
});

test("builds a bounded single-line summary", async () => {
  expect((await profile({ taskText: "line one\nline two\ttabbed" })).summary).toBe("line one line two tabbed");

  const longText = `${"word ".repeat(100)}tail`;
  const summary = (await profile({ taskText: longText })).summary;
  expect(summary.length).toBeLessThanOrEqual(201);
  expect(summary.endsWith("…")).toBe(true);
});

test("validates the boundary and stack at the boundary", async () => {
  await expect(profileTask({ taskText: "x", boundary: "weird" as never })).rejects.toThrow(/boundary/);
  await expect(profileTask({ taskText: "x", boundary: "top-level", declaredStack: [""] })).rejects.toThrow(
    /declaredStack/,
  );
  await expect(profileTask({ taskText: 42 as unknown as string, boundary: "top-level" })).rejects.toThrow(/taskText/);
});

test("profiles never retain raw classifier input beyond the bounded redacted summary", async () => {
  const secret = "api_key = \"aB3dE6hI9jL2mN5pQ8rT0uW3xY6zA9b\"";
  const result = await profile({ taskText: `Fix the login bug using ${secret} please.` });

  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain("aB3dE6hI9jL2mN5pQ8rT0uW3xY6zA9b");
  expect(result.summary).toContain("[REDACTED]");
  expect(result.summary.length).toBeLessThanOrEqual(201);
});
