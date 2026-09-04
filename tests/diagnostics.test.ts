import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  LocalDiagnosticReadError,
  LocalDiagnosticWriteError,
  MAX_DIAGNOSTIC_RECORD_BYTES,
  MAX_LOCAL_DIAGNOSTICS,
  createHealthReport,
  readLocalDiagnostics,
  writeLocalDiagnostic,
} from "../src/core/diagnostics.js";
import { getOpenCodeCompatibilityHealth } from "../src/opencode/health.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function diagnosticFilePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-diagnostics-"));
  temporaryDirectories.push(directory);
  return join(directory, "diagnostics.jsonl");
}

test("writes only redacted diagnostics to an owner-only local file", async () => {
  const filePath = diagnosticFilePath();
  const credential = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
  const sourcePath = "/Users/person/secret-project/config.ts";

  const diagnostic = await writeLocalDiagnostic({
    component: "storage",
    code: "initialization-failed",
    severity: "error",
    summary: `Could not initialize with token ${credential}`,
    path: sourcePath,
  }, { filePath, now: () => new Date("2026-09-04T12:00:00.000Z") });

  const persisted = readFileSync(filePath, "utf8");
  expect(diagnostic.summary).toContain("[REDACTED]");
  expect(diagnostic.path).toBe("[REDACTED_PATH]");
  expect(persisted).not.toContain(credential);
  expect(persisted).not.toContain(sourcePath);
  expect(readLocalDiagnostics(filePath)).toEqual([diagnostic]);
  if (process.platform !== "win32") {
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  }
});

test("redacts embedded paths without leaking components containing spaces or Unicode", async () => {
  const filePath = diagnosticFilePath();
  const summary = "Failed at /Users/alice/secret project/src/main.ts, C:\\Users\\bob\\secret project\\src\\main.ts, project files/秘密/main.ts, ./src files/main.ts, \\\\server\\private share\\main.ts, and file:///Users/carol/secret project/main.ts";

  await writeLocalDiagnostic({
    component: "storage",
    code: "write-failed",
    severity: "error",
    summary,
  }, { filePath });

  const persisted = readFileSync(filePath, "utf8");
  for (const name of ["alice", "bob", "carol", "project", "秘密", "private"]) {
    expect(persisted).not.toContain(name);
  }
  expect(readLocalDiagnostics(filePath)[0]?.summary).toContain("[REDACTED_PATH]");
});

test("redacts complete recognized paths with punctuation, quotes, and Unicode", async () => {
  const filePath = diagnosticFilePath();
  const paths = [
    "/Users/alice/comma, semi; \"quoted\"/秘密 file.ts",
    "C:\\Users\\bob\\comma, semi; \"quoted\"\\秘密 file.ts",
    "\\\\server\\share, semi; \"quoted\"\\秘密 file.ts",
    "relative, directory; \"quoted\"/秘密 file.ts",
    "file:///Users/carol/comma, semi; \"quoted\"/秘密 file.ts",
  ];

  for (const [index, path] of paths.entries()) {
    await writeLocalDiagnostic({
      component: "storage",
      code: `path-${index}`,
      severity: "error",
      summary: `Could not read ${path} after an I/O failure`,
    }, { filePath });
  }

  const persisted = readFileSync(filePath, "utf8");
  for (const fragment of ["alice", "bob", "server", "carol", "relative", "comma", "quoted", "秘密", "I/O failure"]) {
    expect(persisted).not.toContain(fragment);
  }
});

test("bounds summaries after redaction, including replacement expansion", async () => {
  const filePath = diagnosticFilePath();
  const summary = `${"/x, ".repeat(1_000)}ghp_abcdefghijklmnopqrstuvwxyz1234567890`;

  const diagnostic = await writeLocalDiagnostic({
    component: "storage",
    code: "large-summary",
    severity: "warning",
    summary,
  }, { filePath });

  expect(Buffer.byteLength(diagnostic.summary, "utf8")).toBeLessThanOrEqual(2_048);
  expect(Buffer.byteLength(JSON.stringify(diagnostic), "utf8")).toBeLessThanOrEqual(MAX_DIAGNOSTIC_RECORD_BYTES);
  expect(diagnostic.summary).not.toContain("/x");
  expect(diagnostic.summary).not.toContain("ghp_");
});

test("rejects malformed diagnostic files instead of silently trusting them", () => {
  const filePath = diagnosticFilePath();
  writeFileSync(filePath, '{"summary":"partial"}\n');

  expect(() => readLocalDiagnostics(filePath)).toThrow(LocalDiagnosticReadError);
});

test("rejects existing diagnostics that contain an unredacted path", () => {
  const filePath = diagnosticFilePath();
  writeFileSync(filePath, `${JSON.stringify({
    schemaVersion: 1,
    timestamp: "2026-09-04T11:00:00.000Z",
    component: "storage",
    code: "write-failed",
    severity: "error",
    summary: "Failed at /Users/alice/private-project/config.ts",
  })}\n`);

  expect(() => readLocalDiagnostics(filePath)).toThrow(LocalDiagnosticReadError);
});

test("treats a missing diagnostic file as empty but reports existing unreadable paths", () => {
  const filePath = diagnosticFilePath();
  expect(readLocalDiagnostics(filePath)).toEqual([]);

  mkdirSync(filePath);
  expect(() => readLocalDiagnostics(filePath)).toThrow(LocalDiagnosticReadError);
});

test("bounds persisted diagnostic records and retains only the newest records", async () => {
  const filePath = diagnosticFilePath();
  const oversizedPath = "/Users/alice/private-project/".repeat(200);
  const oversized = await writeLocalDiagnostic({
    component: "storage",
    code: "large-summary",
    severity: "warning",
    summary: `Could not write ${oversizedPath} ${"a".repeat(3_000)}`,
  }, { filePath });

  expect(Buffer.byteLength(JSON.stringify(oversized), "utf8")).toBeLessThanOrEqual(MAX_DIAGNOSTIC_RECORD_BYTES);
  expect(readFileSync(filePath, "utf8")).not.toContain("alice");

  for (let index = 0; index <= MAX_LOCAL_DIAGNOSTICS; index += 1) {
    await writeLocalDiagnostic({
      component: "storage",
      code: "retention-check",
      severity: "info",
      summary: `record-${index}`,
    }, { filePath, now: () => new Date(`2026-09-04T12:00:${String(index % 60).padStart(2, "0")}.000Z`) });
  }

  const diagnostics = readLocalDiagnostics(filePath);
  expect(diagnostics).toHaveLength(MAX_LOCAL_DIAGNOSTICS);
  expect(diagnostics[0]?.summary).toBe("record-1");
  expect(diagnostics.at(-1)?.summary).toBe(`record-${MAX_LOCAL_DIAGNOSTICS}`);
});

test("serializes concurrent diagnostic writers across processes without losing records", async () => {
  const filePath = diagnosticFilePath();
  const count = 12;
  const diagnosticsModuleUrl = pathToFileURL(join(import.meta.dir, "../src/core/diagnostics.ts")).href;

  const exits = await Promise.all(Array.from({ length: count }, async (_, index) => {
    const process = Bun.spawn(["bun", "-e", `
      import { writeLocalDiagnostic } from ${JSON.stringify(diagnosticsModuleUrl)};
      await writeLocalDiagnostic({
        component: "storage",
        code: "concurrent-write",
        severity: "info",
        summary: "record-${index}",
      }, { filePath: ${JSON.stringify(filePath)} });
    `]);
    return process.exited;
  }));

  expect(exits).toEqual(Array(count).fill(0));
  expect(readLocalDiagnostics(filePath).map((diagnostic) => diagnostic.summary).sort()).toEqual(
    Array.from({ length: count }, (_, index) => `record-${index}`).sort(),
  );
  expect(readdirSync(join(filePath, ".."))).not.toContain("diagnostics.jsonl.lock");
});

test("recovers diagnostics lock and temporary files after a writer subprocess crashes", async () => {
  const filePath = diagnosticFilePath();
  const directory = join(filePath, "..");
  const temporaryName = ".diagnostics.jsonl.${process.pid}.00000000-0000-0000-0000-000000000000.tmp";
  const activeTemporaryPath = join(directory, temporaryName);
  const unrelatedTemporaryPath = join(directory, ".diagnostics.jsonl.unrelated.tmp");
  writeFileSync(activeTemporaryPath, "active");
  writeFileSync(unrelatedTemporaryPath, "unrelated");

  const process = Bun.spawn(["bun", "-e", `
    import { writeFileSync } from "node:fs";
    const filePath = ${JSON.stringify(filePath)};
    writeFileSync(filePath + ".lock", JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), { mode: 0o600 });
    writeFileSync(${JSON.stringify(join(directory, ".diagnostics.jsonl."))} + process.pid + ".11111111-1111-1111-1111-111111111111.tmp", "orphan");
    process.kill(process.pid, "SIGKILL");
  `]);
  await process.exited;

  await writeLocalDiagnostic({
    component: "storage",
    code: "recovered-write",
    severity: "info",
    summary: "Recovered after writer crash",
  }, { filePath });

  expect(readLocalDiagnostics(filePath).map((diagnostic) => diagnostic.code)).toEqual(["recovered-write"]);
  expect(readdirSync(directory)).not.toContain("diagnostics.jsonl.lock");
  expect(readdirSync(directory).some((entry) => entry.endsWith(".11111111-1111-1111-1111-111111111111.tmp"))).toBeFalse();
  expect(readdirSync(directory)).toContain(temporaryName);
  expect(readdirSync(directory)).toContain(".diagnostics.jsonl.unrelated.tmp");
});

test("reclaims only stale malformed locks and never removes a live writer lock", async () => {
  const filePath = diagnosticFilePath();
  const lockPath = `${filePath}.lock`;
  writeFileSync(lockPath, "incomplete", { mode: 0o600 });
  const staleTime = new Date(Date.now() - 31_000);
  utimesSync(lockPath, staleTime, staleTime);

  await writeLocalDiagnostic({
    component: "storage",
    code: "stale-lock-recovered",
    severity: "info",
    summary: "Recovered stale lock",
  }, { filePath });

  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), { mode: 0o600 });
  await expect(writeLocalDiagnostic({
    component: "storage",
    code: "live-lock",
    severity: "info",
    summary: "Must not remove the live lock",
  }, { filePath })).rejects.toBeInstanceOf(LocalDiagnosticWriteError);
  expect(readFileSync(lockPath, "utf8")).toContain(`"pid":${process.pid}`);
});

test("fails closed and cleans temporary state when a diagnostic write cannot publish", async () => {
  const filePath = diagnosticFilePath();
  mkdirSync(filePath);

  await expect(writeLocalDiagnostic({
    component: "storage",
    code: "write-failed",
    severity: "error",
    summary: "Could not write diagnostics",
  }, { filePath })).rejects.toBeInstanceOf(LocalDiagnosticWriteError);

  expect(readdirSync(join(filePath, "..")).sort()).toEqual(["diagnostics.jsonl"]);
});

test("reports structured local health and explicitly disables external telemetry", () => {
  const supported = getOpenCodeCompatibilityHealth("1.18.27");
  const unsupported = getOpenCodeCompatibilityHealth("not-a-version-with-a-secret");

  expect(supported).toEqual({ component: "opencode-compatibility", status: "healthy" });
  expect(unsupported).toEqual({
    component: "opencode-compatibility",
    status: "degraded",
    reason: "invalid-version",
  });
  expect(JSON.stringify(unsupported)).not.toContain("not-a-version-with-a-secret");
  expect(createHealthReport([unsupported], [{
    schemaVersion: 1,
    timestamp: "2026-09-04T11:00:00.000Z",
    component: "storage",
    code: "previous-failure",
    severity: "error",
    summary: "Historical failure",
  }], () => new Date("2026-09-04T12:00:00.000Z"))).toEqual({
    generatedAt: "2026-09-04T12:00:00.000Z",
    status: "degraded",
    externalTelemetry: false,
    checks: [unsupported],
    diagnostics: { info: 0, warning: 0, error: 1 },
  });
});

test("derives health only from current checks and rejects sensitive health labels", () => {
  const report = createHealthReport([{ component: "storage", status: "healthy" }], [{
    schemaVersion: 1,
    timestamp: "2026-09-04T11:00:00.000Z",
    component: "storage",
    code: "previous-failure",
    severity: "error",
    summary: "Historical failure",
  }]);

  expect(report.status).toBe("healthy");
  expect(() => createHealthReport([{ component: "/Users/alice/project", status: "healthy" }])).toThrow(TypeError);
  expect(() => createHealthReport([{ component: "storage", status: "degraded", reason: "failed at /Users/alice/project" }])).toThrow(TypeError);
  expect(() => createHealthReport([], [{ severity: "unexpected" } as never])).toThrow(TypeError);
  expect(() => createHealthReport([], [{
    schemaVersion: 1,
    timestamp: "2026-09-04T11:00:00.000Z",
    component: "storage",
    code: "unredacted-history",
    severity: "error",
    summary: "Failed at /Users/alice/private-project/config.ts",
  }])).toThrow(TypeError);
  expect(() => createHealthReport([], [{
    schemaVersion: 1,
    timestamp: "2026-09-04T11:00:00.000Z",
    component: "storage",
    code: "oversized-history",
    severity: "error",
    summary: "a".repeat(MAX_DIAGNOSTIC_RECORD_BYTES),
  }])).toThrow(TypeError);
});
