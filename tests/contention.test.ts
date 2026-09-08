import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  migrateSqliteSchema,
  openSqliteConnection,
  releaseSchemaMigrations,
} from "../src/core/index.js";

const WORKER_FIXTURE = join(import.meta.dir, "fixtures", "wal-worker.ts");
const WORKER_TIMEOUT_MS = 30_000;
const ITERATIONS_PER_WORKER = 30;

type WorkerResult = Readonly<{
  status: "ok" | "failed";
  appliedVersions?: ReadonlyArray<number>;
  writes?: number;
  error?: string;
}>;

function withTemporaryDatabase(run: (databasePath: string) => void | Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-contention-"));
  return Promise.resolve(run(join(directory, "memory.sqlite"))).finally(() => {
    rmSync(directory, { recursive: true, force: true });
  });
}

async function runWorker(
  mode: "migrate" | "write",
  databasePath: string,
  workerId: string,
  iterations: number,
): Promise<WorkerResult> {
  const child = Bun.spawn({
    cmd: [process.execPath, WORKER_FIXTURE, mode, databasePath, workerId, String(iterations)],
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), WORKER_TIMEOUT_MS);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) {
      throw new Error(`Contention worker ${workerId} exited with ${exitCode}: ${stderr}`);
    }
    const line = stdout.trim().split("\n").at(-1);
    return JSON.parse(line ?? "") as WorkerResult;
  } finally {
    clearTimeout(timeout);
  }
}

function inspectDatabase(databasePath: string): {
  userVersion: number;
  projectCount: number;
  integrity: string;
} {
  const connection = openSqliteConnection(databasePath);
  try {
    return {
      userVersion: connection.database.query<{ user_version: number }, []>("PRAGMA user_version").get()!
        .user_version,
      projectCount: connection.database.query<{ count: number }, []>(
        "SELECT count(*) AS count FROM projects",
      ).get()!.count,
      integrity: connection.database
        .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
        .all()
        .map((row) => row.integrity_check)
        .join(";"),
    };
  } finally {
    connection.close();
  }
}

test("first-time migration is serialized across concurrent processes", async () => {
  await withTemporaryDatabase(async (databasePath) => {
    const workerIds = ["alpha", "beta", "gamma", "delta"];
    const workers = await Promise.all(
      workerIds.map((workerId) => runWorker("migrate", databasePath, workerId, 3)),
    );

    for (const [index, worker] of workers.entries()) {
      expect(worker.status, `worker ${workerIds[index]} failed: ${worker.error ?? ""}`).toBe("ok");
    }
    const appliers = workers.filter((worker) => (worker.appliedVersions ?? []).length > 0);
    expect(appliers).toHaveLength(1);
    expect(appliers[0]!.appliedVersions).toEqual(releaseSchemaMigrations.map((migration) => migration.version));

    const state = inspectDatabase(databasePath);
    expect(state.userVersion).toBe(releaseSchemaMigrations.length);
    expect(state.projectCount).toBe(workerIds.length * 3);
    expect(state.integrity).toBe("ok");
  });
});

test("concurrent writers under WAL persist every committed row", async () => {
  await withTemporaryDatabase(async (databasePath) => {
    const setup = openSqliteConnection(databasePath);
    try {
      migrateSqliteSchema(setup, releaseSchemaMigrations);
    } finally {
      setup.close();
    }

    const workerIds = ["w1", "w2", "w3", "w4"];
    const workers = await Promise.all(
      workerIds.map((workerId) => runWorker("write", databasePath, workerId, ITERATIONS_PER_WORKER)),
    );

    for (const [index, worker] of workers.entries()) {
      expect(worker.status, `worker ${workerIds[index]} failed: ${worker.error ?? ""}`).toBe("ok");
      expect(worker.writes).toBe(ITERATIONS_PER_WORKER);
    }

    const state = inspectDatabase(databasePath);
    expect(state.projectCount).toBe(workerIds.length * ITERATIONS_PER_WORKER);
    expect(state.userVersion).toBe(releaseSchemaMigrations.length);
    expect(state.integrity).toBe("ok");
  });
});

test("a writer waits out a briefly-held competing lock within the busy timeout", async () => {
  await withTemporaryDatabase(async (databasePath) => {
    const holder = openSqliteConnection(databasePath);
    try {
      migrateSqliteSchema(holder, releaseSchemaMigrations);
      holder.database.run("BEGIN IMMEDIATE");

      const workerPromise = runWorker("write", databasePath, "contender", 1);
      await Bun.sleep(300);
      holder.database.run("COMMIT");

      const worker = await workerPromise;
      expect(worker.status, `contender failed: ${worker.error ?? ""}`).toBe("ok");
    } finally {
      holder.close();
    }
  });
});
