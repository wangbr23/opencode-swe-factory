import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migrateSqliteSchema, openSqliteConnection, releaseSchemaMigrations } from "../src/core/index.js";
import { EMBEDDING_VECTOR_BYTE_LENGTH, EMBEDDING_VECTOR_DIMENSIONS } from "../src/types/embedding-types.js";

const NOW = "2026-09-04T00:00:00.000Z";

function withTemporaryDatabase(run: (database: Database) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-retrieval-schema-"));
  const connection = openSqliteConnection(join(directory, "memory.sqlite"));
  migrateSqliteSchema(connection, releaseSchemaMigrations);
  try {
    run(connection.database);
  } finally {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function insertProject(database: Database, id: string): void {
  database.run("INSERT INTO projects (id, path, created_at, updated_at) VALUES (?, ?, ?, ?)", [
    id,
    `/repos/${id}`,
    NOW,
    NOW,
  ]);
}

function insertDocumentSource(database: Database): void {
  database.run(
    "INSERT INTO document_sources (id, project_id, scope, source_type, path, content_hash, indexed_at, created_at, updated_at) VALUES (?, ?, 'project', ?, ?, ?, ?, ?, ?)",
    ["source-1", "project-1", "decision", "/repos/project-1/docs/decisions.md", "source-hash", NOW, NOW, NOW],
  );
}

function insertDocumentChunk(database: Database): void {
  database.run(
    "INSERT INTO document_chunks (id, source_id, project_id, scope, source_type, source_path, heading_path, start_line, end_line, content_hash, text, created_at, updated_at) VALUES (?, ?, ?, 'project', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      "chunk-1",
      "source-1",
      "project-1",
      "decision",
      "/repos/project-1/docs/decisions.md",
      "Storage > Transactions",
      12,
      18,
      "chunk-hash",
      "Use transactional replacement before swapping databases.",
      NOW,
      NOW,
    ],
  );
}

function insertLessonVersion(database: Database): void {
  database.run(
    "INSERT INTO lessons (id, project_id, scope, active_version, created_at, updated_at) VALUES (?, NULL, 'global', 1, ?, ?)",
    ["lesson-1", NOW, NOW],
  );
  database.run(
    "INSERT INTO lesson_versions (lesson_id, version, title, body, rationale, applicability_json, provenance_json, created_at) VALUES (?, 1, ?, ?, ?, '{}', '{}', ?)",
    ["lesson-1", "Run rollback checks", "Verify transactional rollback before release.", "Confirmed correction.", NOW],
  );
}

test("upgrades version 2 with retrieval tables and indexes existing lessons", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-retrieval-upgrade-"));
  const connection = openSqliteConnection(join(directory, "memory.sqlite"));
  try {
    migrateSqliteSchema(connection, releaseSchemaMigrations.slice(0, 2));
    insertLessonVersion(connection.database);

    expect(migrateSqliteSchema(connection, releaseSchemaMigrations)).toEqual({
      status: "ready",
      schemaVersion: 3,
      appliedVersions: [3],
    });

    const names = connection.database
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE name IN ('document_sources', 'document_chunks', 'document_chunks_fts', 'lesson_versions_fts', 'document_chunk_embeddings', 'lesson_version_embeddings') ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    expect(names).toEqual([
      "document_chunk_embeddings",
      "document_chunks",
      "document_chunks_fts",
      "document_sources",
      "lesson_version_embeddings",
      "lesson_versions_fts",
    ]);
    expect(
      connection.database
        .query<{ title: string }, []>("SELECT title FROM lesson_versions_fts WHERE lesson_versions_fts MATCH 'rollback'")
        .get(),
    ).toEqual({ title: "Run rollback checks" });
  } finally {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stores citation-ready chunks and synchronizes full-text search", () => {
  withTemporaryDatabase((database) => {
    insertProject(database, "project-1");
    insertDocumentSource(database);
    insertDocumentChunk(database);

    expect(
      database
        .query<
          { source_path: string; heading_path: string; start_line: number; end_line: number },
          []
        >("SELECT source_path, heading_path, start_line, end_line FROM document_chunks")
        .get(),
    ).toEqual({
      source_path: "/repos/project-1/docs/decisions.md",
      heading_path: "Storage > Transactions",
      start_line: 12,
      end_line: 18,
    });
    expect(
      database
        .query<{ chunk_id: string; heading_path: string }, []>(
          "SELECT chunk_id, heading_path FROM document_chunks_fts WHERE document_chunks_fts MATCH 'transactional'",
        )
        .get(),
    ).toEqual({ chunk_id: "chunk-1", heading_path: "Storage > Transactions" });

    database.run("UPDATE document_chunks SET text = ?, updated_at = ? WHERE id = ?", [
      "Use an atomic replacement before swapping databases.",
      NOW,
      "chunk-1",
    ]);
    expect(
      database.query<{ count: number }, []>(
        "SELECT count(*) AS count FROM document_chunks_fts WHERE document_chunks_fts MATCH 'transactional'",
      ).get(),
    ).toEqual({ count: 0 });
    expect(
      database.query<{ count: number }, []>(
        "SELECT count(*) AS count FROM document_chunks_fts WHERE document_chunks_fts MATCH 'atomic'",
      ).get(),
    ).toEqual({ count: 1 });

    database.run("VACUUM");
    expect(
      database
        .query<{ chunk_id: string }, []>(
          "SELECT chunk_id FROM document_chunks_fts WHERE document_chunks_fts MATCH 'atomic'",
        )
        .get(),
    ).toEqual({ chunk_id: "chunk-1" });

    database.run("DELETE FROM document_sources WHERE id = 'source-1'");
    expect(
      database.query<{ count: number }, []>(
        "SELECT count(*) AS count FROM document_chunks_fts WHERE document_chunks_fts MATCH 'atomic'",
      ).get(),
    ).toEqual({ count: 0 });
  });
});

test("enforces source scope, chunk metadata, and line-range invariants", () => {
  withTemporaryDatabase((database) => {
    insertProject(database, "project-1");
    insertProject(database, "project-2");

    expect(() =>
      database.run(
        "INSERT INTO document_sources (id, project_id, scope, source_type, path, content_hash, indexed_at, created_at, updated_at) VALUES (?, NULL, 'project', ?, ?, ?, ?, ?, ?)",
        ["bad-project-source", "decision", "/repos/project-1/docs/decisions.md", "hash", NOW, NOW, NOW],
      ),
    ).toThrow(/CHECK/);
    expect(() =>
      database.run(
        "INSERT INTO document_sources (id, project_id, scope, source_type, path, content_hash, indexed_at, created_at, updated_at) VALUES (?, ?, 'global', ?, ?, ?, ?, ?, ?)",
        ["bad-global-source", "project-1", "decision", "/global/decisions.md", "hash", NOW, NOW, NOW],
      ),
    ).toThrow(/CHECK/);

    insertDocumentSource(database);
    expect(() =>
      database.run(
        "INSERT INTO document_chunks (id, source_id, project_id, scope, source_type, source_path, heading_path, start_line, end_line, content_hash, text, created_at, updated_at) VALUES (?, ?, ?, 'project', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          "wrong-project",
          "source-1",
          "project-2",
          "decision",
          "/repos/project-1/docs/decisions.md",
          "Storage",
          12,
          18,
          "hash",
          "Mismatched project",
          NOW,
          NOW,
        ],
      ),
    ).toThrow(/metadata does not match source/);
    expect(() =>
      database.run(
        "INSERT INTO document_chunks (id, source_id, project_id, scope, source_type, source_path, heading_path, start_line, end_line, content_hash, text, created_at, updated_at) VALUES (?, ?, ?, 'project', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          "bad-lines",
          "source-1",
          "project-1",
          "decision",
          "/repos/project-1/docs/decisions.md",
          "Storage",
          18,
          12,
          "hash",
          "Invalid range",
          NOW,
          NOW,
        ],
      ),
    ).toThrow(/CHECK/);

    insertDocumentChunk(database);
    expect(() =>
      database.run("UPDATE document_sources SET path = ? WHERE id = ?", [
        "/repos/project-1/docs/moved-decisions.md",
        "source-1",
      ]),
    ).toThrow(/cannot change indexed document source metadata/);
  });
});

test("versions fixed-size embeddings and removes them with source records", () => {
  withTemporaryDatabase((database) => {
    insertProject(database, "project-1");
    insertDocumentSource(database);
    insertDocumentChunk(database);
    insertLessonVersion(database);
    const vector = new Uint8Array(EMBEDDING_VECTOR_BYTE_LENGTH);

    database.run(
      "INSERT INTO document_chunk_embeddings (chunk_id, model, revision, dimensions, vector, created_at) VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)",
      [
        "chunk-1",
        "Xenova/all-MiniLM-L6-v2",
        "rev-1",
        EMBEDDING_VECTOR_DIMENSIONS,
        vector,
        NOW,
        "chunk-1",
        "Xenova/all-MiniLM-L6-v2",
        "rev-2",
        EMBEDDING_VECTOR_DIMENSIONS,
        vector,
        NOW,
      ],
    );
    database.run(
      "INSERT INTO lesson_version_embeddings (lesson_id, lesson_version, model, revision, dimensions, vector, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["lesson-1", 1, "Xenova/all-MiniLM-L6-v2", "rev-1", EMBEDDING_VECTOR_DIMENSIONS, vector, NOW],
    );

    expect(database.query<{ count: number }, []>("SELECT count(*) AS count FROM document_chunk_embeddings").get()).toEqual({
      count: 2,
    });
    expect(
      database.query<{ count: number }, []>(
        "SELECT count(*) AS count FROM lesson_versions_fts WHERE lesson_versions_fts MATCH 'rollback'",
      ).get(),
    ).toEqual({ count: 1 });
    expect(() =>
      database.run(
        "INSERT INTO document_chunk_embeddings (chunk_id, model, revision, dimensions, vector, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        ["chunk-1", "Xenova/all-MiniLM-L6-v2", "bad-size", EMBEDDING_VECTOR_DIMENSIONS, new Uint8Array(8), NOW],
      ),
    ).toThrow(/CHECK/);

    database.run("DELETE FROM document_sources WHERE id = 'source-1'");
    database.run("DELETE FROM lessons WHERE id = 'lesson-1'");
    expect(database.query<{ count: number }, []>("SELECT count(*) AS count FROM document_chunk_embeddings").get()).toEqual({
      count: 0,
    });
    expect(database.query<{ count: number }, []>("SELECT count(*) AS count FROM lesson_version_embeddings").get()).toEqual({
      count: 0,
    });
    expect(
      database.query<{ count: number }, []>(
        "SELECT count(*) AS count FROM lesson_versions_fts WHERE lesson_versions_fts MATCH 'rollback'",
      ).get(),
    ).toEqual({ count: 0 });
  });
});
