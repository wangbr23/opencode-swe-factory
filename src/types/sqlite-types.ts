import type { Database } from "bun:sqlite";

export const SQLITE_BUSY_TIMEOUT_MS = 5_000;

export type SqliteConnection = Readonly<{
  database: Database;
  databasePath: string;
  readonly isClosed: boolean;
  close(): void;
}>;
