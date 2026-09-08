import { expect, test } from "bun:test";

import {
  createShellVersionProbe,
  parseProbedVersion,
  resolveRuntimeOpenCodeVersion,
  type ShellVersionRunner,
} from "../../src/opencode/runtime-version.js";
import type { VersionProbeFn } from "../../src/opencode/runtime-version.js";

test("parseProbedVersion extracts a semantic version from probe output", () => {
  expect(parseProbedVersion("1.18.29\n")).toBe("1.18.29");
  expect(parseProbedVersion("opencode 1.18.29 (bun)")).toBe("1.18.29");
  expect(parseProbedVersion("")).toBeUndefined();
  expect(parseProbedVersion("command not found")).toBeUndefined();
  expect(parseProbedVersion("1.18")).toBeUndefined();
});

function fakeShell(output: string | Error): ShellVersionRunner {
  const run = () => ({
    nothrow() {
      return {
        text: async () => {
          if (output instanceof Error) throw output;
          return output;
        },
      };
    },
  });
  return run as unknown as ShellVersionRunner;
}

test("createShellVersionProbe parses stdout and fails safe on any error", async () => {
  expect(await createShellVersionProbe(fakeShell("1.18.29\n"))()).toBe("1.18.29");
  expect(await createShellVersionProbe(fakeShell(new Error("not found")))()).toBeUndefined();
  expect(await createShellVersionProbe(undefined)()).toBeUndefined();
});

function probeThrowing(error: Error): VersionProbeFn {
  return async () => {
    throw error;
  };
}

test("resolveRuntimeOpenCodeVersion prefers the explicit options version", async () => {
  expect(await resolveRuntimeOpenCodeVersion("1.18.27", probeThrowing(new Error("boom")))).toBe("1.18.27");
  expect(await resolveRuntimeOpenCodeVersion("  1.18.27  ", async () => "1.18.29")).toBe("  1.18.27  ");
});

test("resolveRuntimeOpenCodeVersion falls back to the probe", async () => {
  expect(await resolveRuntimeOpenCodeVersion(undefined, async () => "1.18.29")).toBe("1.18.29");
});

test("resolveRuntimeOpenCodeVersion stays undefined when the probe fails", async () => {
  expect(await resolveRuntimeOpenCodeVersion(undefined, probeThrowing(new Error("boom")))).toBeUndefined();
  expect(await resolveRuntimeOpenCodeVersion(42, async () => undefined)).toBeUndefined();
});
