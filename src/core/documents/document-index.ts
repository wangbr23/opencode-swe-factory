import { createHash, randomUUID } from "node:crypto";

import type {
  DocumentIndexResult,
  IndexDocumentSourcesInput,
  IndexableDocumentSource,
} from "../../types/document-index-types.js";
import type { SqliteConnection } from "../db/sqlite.js";
import { chunkMarkdown } from "./markdown-chunking.js";

export type {
  DocumentIndexResult,
  IndexDocumentSourcesInput,
  IndexableDocumentSource,
} from "../../types/document-index-types.js";

export class DocumentIndexError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "DocumentIndexError";
  }
}

type ExistingSourceRow = Readonly<{
  id: string;
  path: string;
  content_hash: string;
}>;

const SELECT_EXISTING_SOURCES = `
SELECT id, path, content_hash
FROM document_sources
WHERE scope = ? AND project_id IS ?
`;

const INSERT_SOURCE = `
INSERT INTO document_sources (id, project_id, scope, source_type, path, content_hash, indexed_at, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const UPDATE_SOURCE_CONTENT = `
UPDATE document_sources
SET content_hash = ?, indexed_at = ?, updated_at = ?
WHERE id = ?
`;

const DELETE_SOURCE = `
DELETE FROM document_sources
WHERE id = ?
`;

const COUNT_CHUNKS_FOR_SOURCE = `
SELECT COUNT(*) AS chunk_count
FROM document_chunks
WHERE source_id = ?
`;

const DELETE_CHUNKS_FOR_SOURCE = `
DELETE FROM document_chunks
WHERE source_id = ?
`;

const INSERT_CHUNK = `
INSERT INTO document_chunks (
  id, source_id, project_id, scope, source_type, source_path,
  heading_path, start_line, end_line, content_hash, text, created_at, updated_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DocumentIndexError(`${label} must be a non-empty string.`);
  }
  return value;
}

function validateSource(source: IndexableDocumentSource, index: number): void {
  const label = `sources[${index}]`;
  if (source.scope !== "project" && source.scope !== "global") {
    throw new DocumentIndexError(`${label}.scope must be "project" or "global".`);
  }
  if (source.scope === "project") {
    requireNonEmptyString(source.projectId, `${label}.projectId`);
  } else if (source.projectId !== null) {
    throw new DocumentIndexError(`${label}.projectId must be null for global scope.`);
  }
  requireNonEmptyString(source.path, `${label}.path`);
  requireNonEmptyString(source.sourceType, `${label}.sourceType`);
  requireNonEmptyString(source.contentHash, `${label}.contentHash`);
  if (typeof source.content !== "string") {
    throw new DocumentIndexError(`${label}.content must be a string.`);
  }
}

function hashChunkText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function countChunks(connection: SqliteConnection, sourceId: string): number {
  const row = connection.database
    .query<Readonly<{ chunk_count: number }>, [string]>(COUNT_CHUNKS_FOR_SOURCE)
    .get(sourceId);
  return row?.chunk_count ?? 0;
}

function projectKey(scope: "project" | "global", projectId: string | null): string {
  return `${scope}\u0000${projectId ?? ""}`;
}

/**
 * Incrementally syncs admitted curated-document sources into the chunk and
 * FTS indexes. Sources are re-chunked only when their content hash changed,
 * and indexed sources whose path is no longer admitted are removed together
 * with their chunks and FTS entries. Source documents are never modified.
 * The whole sync runs in one transaction so readers never observe a
 * half-updated index.
 */
export function indexDocumentSources(
  connection: SqliteConnection,
  input: IndexDocumentSourcesInput,
): DocumentIndexResult {
  const sources = input.sources;
  if (!Array.isArray(sources)) {
    throw new DocumentIndexError("sources must be an array.");
  }
  const now = (input.now ?? new Date()).toISOString();

  const seenPaths = new Set<string>();
  const byProject = new Map<string, { scope: "project" | "global"; projectId: string | null; sources: IndexableDocumentSource[] }>();
  for (let index = 0; index < sources.length; index++) {
    const source = sources[index]!;
    validateSource(source, index);
    const seenKey = projectKey(source.scope, source.projectId) + `\u0000${source.path}`;
    if (seenPaths.has(seenKey)) {
      throw new DocumentIndexError(`sources[${index}].path is indexed more than once: ${source.path}`);
    }
    seenPaths.add(seenKey);

    const projectKeyText = projectKey(source.scope, source.projectId);
    const bucket = byProject.get(projectKeyText);
    if (bucket) {
      bucket.sources.push(source);
    } else {
      byProject.set(projectKeyText, { scope: source.scope, projectId: source.projectId, sources: [source] });
    }
  }

  let indexedSourceCount = 0;
  let indexedChunkCount = 0;
  let unchangedSourceCount = 0;
  let removedSourceCount = 0;
  let removedChunkCount = 0;

  connection.database.transaction(() => {
    for (const { scope, projectId, sources: admitted } of byProject.values()) {
      const existingRows = connection.database
        .query<ExistingSourceRow, [string, string | null]>(SELECT_EXISTING_SOURCES)
        .all(scope, projectId);
      const existingByPath = new Map(existingRows.map((row) => [row.path, row]));
      const admittedPaths = new Set(admitted.map((source) => source.path));

      for (const source of admitted) {
        const existing = existingByPath.get(source.path);
        if (existing && existing.content_hash === source.contentHash) {
          unchangedSourceCount++;
          continue;
        }

        const chunkInput: { content: string; sourcePath: string; maxChunkLines?: number } = {
          content: source.content,
          sourcePath: source.path,
        };
        if (input.maxChunkLines !== undefined) {
          chunkInput.maxChunkLines = input.maxChunkLines;
        }
        const chunks = chunkMarkdown(chunkInput).chunks;

        let sourceId: string;
        if (existing) {
          removedChunkCount += countChunks(connection, existing.id);
          connection.database.run(DELETE_CHUNKS_FOR_SOURCE, [existing.id]);
          connection.database.run(UPDATE_SOURCE_CONTENT, [source.contentHash, now, now, existing.id]);
          sourceId = existing.id;
        } else {
          sourceId = randomUUID();
          connection.database.run(INSERT_SOURCE, [
            sourceId,
            projectId,
            scope,
            source.sourceType,
            source.path,
            source.contentHash,
            now,
            now,
            now,
          ]);
        }

        for (const chunk of chunks) {
          connection.database.run(INSERT_CHUNK, [
            randomUUID(),
            sourceId,
            projectId,
            scope,
            source.sourceType,
            source.path,
            chunk.headingPath,
            chunk.startLine,
            chunk.endLine,
            hashChunkText(chunk.text),
            chunk.text,
            now,
            now,
          ]);
        }

        indexedSourceCount++;
        indexedChunkCount += chunks.length;
      }

      for (const row of existingRows) {
        if (admittedPaths.has(row.path)) {
          continue;
        }
        removedChunkCount += countChunks(connection, row.id);
        connection.database.run(DELETE_SOURCE, [row.id]);
        removedSourceCount++;
      }
    }
  })();

  return {
    indexedSourceCount,
    indexedChunkCount,
    unchangedSourceCount,
    removedSourceCount,
    removedChunkCount,
  };
}
