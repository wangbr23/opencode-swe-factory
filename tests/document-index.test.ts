import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DocumentIndexError,
  indexDocumentSources,
  migrateSqliteSchema,
  openSqliteConnection,
  releaseSchemaMigrations,
  type IndexableDocumentSource,
  type SqliteConnection,
} from "../src/core/index.js";

const NOW = new Date("2026-09-06T00:00:00.000Z");
const NOW_ISO = NOW.toISOString();

async function withDatabase(run: (connection: SqliteConnection) => Promise<void> | void): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-document-index-"));
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
    NOW_ISO,
    NOW_ISO,
  ]);
}

function projectSource(overrides: Partial<IndexableDocumentSource> = {}): IndexableDocumentSource {
  return {
    projectId: "proj-1",
    scope: "project",
    path: "/repos/proj-1/docs/design.md",
    sourceType: "design",
    content: "# Design\n\nThe router resolves project identity.\n",
    contentHash: "hash-1",
    ...overrides,
  };
}

function countChunks(connection: SqliteConnection, sourcePath: string): number {
  return connection.database
    .query<Readonly<{ n: number }>, [string]>("SELECT COUNT(*) AS n FROM document_chunks WHERE source_path = ?")
    .get(sourcePath)!.n;
}

function ftsMatches(connection: SqliteConnection, term: string): number {
  return connection.database
    .query<Readonly<{ chunk_id: string }>, [string]>(
      "SELECT chunk_id FROM document_chunks_fts WHERE document_chunks_fts MATCH ?",
    )
    .all(term).length;
}

test("indexes new sources with chunks searchable through FTS", async () => {
  await withDatabase((connection) => {
    insertProject(connection, "proj-1");
    const result = indexDocumentSources(connection, {
      sources: [projectSource()],
      now: NOW,
    });

    expect(result).toEqual({
      indexedSourceCount: 1,
      indexedChunkCount: 1,
      unchangedSourceCount: 0,
      removedSourceCount: 0,
      removedChunkCount: 0,
    });
    expect(countChunks(connection, "/repos/proj-1/docs/design.md")).toBe(1);
    expect(ftsMatches(connection, "router")).toBe(1);
    expect(ftsMatches(connection, "identity")).toBe(1);

    const source = connection.database
      .query<Readonly<{ content_hash: string; scope: string; project_id: string }>, []>(
        "SELECT content_hash, scope, project_id FROM document_sources",
      )
      .get()!;
    expect(source.content_hash).toBe("hash-1");
    expect(source.scope).toBe("project");
    expect(source.project_id).toBe("proj-1");
  });
});

test("skips sources whose content hash is unchanged", async () => {
  await withDatabase((connection) => {
    insertProject(connection, "proj-1");
    indexDocumentSources(connection, { sources: [projectSource()], now: NOW });

    const later = new Date("2026-09-06T01:00:00.000Z");
    const result = indexDocumentSources(connection, { sources: [projectSource()], now: later });

    expect(result.unchangedSourceCount).toBe(1);
    expect(result.indexedSourceCount).toBe(0);
    expect(result.indexedChunkCount).toBe(0);

    const indexedAt = connection.database
      .query<Readonly<{ indexed_at: string }>, []>("SELECT indexed_at FROM document_sources")
      .get()!.indexed_at;
    expect(indexedAt).toBe(NOW_ISO);
  });
});

test("re-chunks changed sources and replaces their FTS entries", async () => {
  await withDatabase((connection) => {
    insertProject(connection, "proj-1");
    indexDocumentSources(connection, { sources: [projectSource()], now: NOW });

    const result = indexDocumentSources(connection, {
      sources: [
        projectSource({
          contentHash: "hash-2",
          content: "# Design\n\nThe router resolves project identity.\n\n# Retrieval\n\nLexical retrieval uses FTS5.\n",
        }),
      ],
      now: new Date("2026-09-06T01:00:00.000Z"),
    });

    expect(result.indexedSourceCount).toBe(1);
    expect(result.indexedChunkCount).toBe(2);
    expect(result.removedChunkCount).toBe(1);
    expect(result.unchangedSourceCount).toBe(0);

    expect(countChunks(connection, "/repos/proj-1/docs/design.md")).toBe(2);
    expect(ftsMatches(connection, "FTS5")).toBe(1);

    const chunkRows = connection.database
      .query<Readonly<{ heading_path: string; start_line: number; end_line: number }>, []>(
        "SELECT heading_path, start_line, end_line FROM document_chunks ORDER BY start_line",
      )
      .all();
    expect(chunkRows.map((row) => row.heading_path)).toEqual(["Design", "Retrieval"]);
    expect(chunkRows.map((row) => [row.start_line, row.end_line])).toEqual([
      [1, 4],
      [5, 8],
    ]);
  });
});

test("removes stale sources together with their chunks and FTS entries", async () => {
  await withDatabase((connection) => {
    insertProject(connection, "proj-1");
    indexDocumentSources(connection, {
      sources: [
        projectSource(),
        projectSource({ path: "/repos/proj-1/docs/old.md", content: "# Old\n\nDeprecated material.\n" }),
      ],
      now: NOW,
    });

    const result = indexDocumentSources(connection, {
      sources: [projectSource()],
      now: new Date("2026-09-06T01:00:00.000Z"),
    });

    expect(result.removedSourceCount).toBe(1);
    expect(result.removedChunkCount).toBe(1);
    expect(countChunks(connection, "/repos/proj-1/docs/old.md")).toBe(0);
    expect(ftsMatches(connection, "Deprecated")).toBe(0);
    expect(ftsMatches(connection, "router")).toBe(1);

    const remaining = connection.database
      .query<Readonly<{ path: string }>, []>("SELECT path FROM document_sources")
      .all();
    expect(remaining.map((row) => row.path)).toEqual(["/repos/proj-1/docs/design.md"]);
  });
});

test("indexes global sources with a null project", async () => {
  await withDatabase((connection) => {
    const result = indexDocumentSources(connection, {
      sources: [
        projectSource({
          projectId: null,
          scope: "global",
          path: "/shared/docs/guide.md",
          content: "# Guide\n\nGlobal documentation.\n",
        }),
      ],
      now: NOW,
    });

    expect(result.indexedSourceCount).toBe(1);
    expect(ftsMatches(connection, "documentation")).toBe(1);

    const source = connection.database
      .query<Readonly<{ project_id: string | null; scope: string }>, []>(
        "SELECT project_id, scope FROM document_sources",
      )
      .get()!;
    expect(source.project_id).toBeNull();
    expect(source.scope).toBe("global");
  });
});

test("keeps different projects' indexes separate", async () => {
  await withDatabase((connection) => {
    insertProject(connection, "proj-1");
    insertProject(connection, "proj-2");
    indexDocumentSources(connection, {
      sources: [
        projectSource(),
        projectSource({ projectId: "proj-2", path: "/repos/proj-2/docs/design.md", contentHash: "hash-p2" }),
      ],
      now: NOW,
    });

    const result = indexDocumentSources(connection, {
      sources: [projectSource({ projectId: "proj-2", path: "/repos/proj-2/docs/design.md", contentHash: "hash-p2" })],
      now: NOW,
    });

    expect(result.unchangedSourceCount).toBe(1);
    expect(result.removedSourceCount).toBe(0);
    expect(connection.database.query<Readonly<{ n: number }>, []>("SELECT COUNT(*) AS n FROM document_sources").get()!.n).toBe(2);
  });
});

test("rejects invalid and duplicate source input", async () => {
  await withDatabase((connection) => {
    expect(() =>
      indexDocumentSources(connection, { sources: [projectSource({ projectId: null })] }),
    ).toThrow(DocumentIndexError);
    expect(() =>
      indexDocumentSources(connection, {
        sources: [projectSource({ scope: "global" })],
      }),
    ).toThrow(/must be null for global scope/);
    expect(() =>
      indexDocumentSources(connection, {
        sources: [
          projectSource(),
          projectSource({ path: "/repos/proj-1/docs/design.md" }),
        ],
      }),
    ).toThrow(/indexed more than once/);
  });
});

test("indexes chunk contents exactly and hashes each chunk", async () => {
  await withDatabase((connection) => {
    insertProject(connection, "proj-1");
    const content = "# Setup\n\nInstall with bun install.\n";
    indexDocumentSources(connection, { sources: [projectSource({ content })], now: NOW });

    const chunk = connection.database
      .query<Readonly<{ text: string; content_hash: string; source_type: string }>, []>(
        "SELECT text, content_hash, source_type FROM document_chunks",
      )
      .get()!;
    expect(chunk.text).toBe("# Setup\n\nInstall with bun install.\n");
    expect(chunk.source_type).toBe("design");
    expect(chunk.content_hash).toHaveLength(64);
  });
});
