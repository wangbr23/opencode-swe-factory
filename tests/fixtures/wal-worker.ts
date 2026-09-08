import { openSqliteConnection, releaseSchemaMigrations, migrateSqliteSchema } from "../../src/core/index.js";

const mode = process.argv[2];
const databasePath = process.argv[3];
const workerId = process.argv[4];
const iterations = Number(process.argv[5] ?? "30");

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function openWithRetry(): ReturnType<typeof openSqliteConnection> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      return openSqliteConnection(databasePath!);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/database is locked|database is busy|busy/i.test(message)) {
        throw error;
      }
      Bun.sleepSync(50);
    }
  }
  throw lastError;
}

try {
  const connection = openWithRetry();
  try {
    let appliedVersions: ReadonlyArray<number> = [];
    if (mode === "migrate") {
      appliedVersions = migrateSqliteSchema(connection, releaseSchemaMigrations).appliedVersions;
    }

    const insert = connection.database.query(
      "INSERT INTO projects (id, path, created_at, updated_at) VALUES (?, ?, ?, ?)",
    );
    const timestamp = "2026-09-07T00:00:00.000Z";
    for (let index = 0; index < iterations; index++) {
      connection.database.run("BEGIN IMMEDIATE");
      try {
        insert.run(`${workerId}-${index}`, `/repos/${workerId}-${index}`, timestamp, timestamp);
        connection.database.run("COMMIT");
      } catch (error) {
        connection.database.run("ROLLBACK");
        throw error;
      }
    }
    emit({ status: "ok", appliedVersions, writes: iterations });
  } finally {
    connection.close();
  }
} catch (error) {
  emit({ status: "failed", error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
