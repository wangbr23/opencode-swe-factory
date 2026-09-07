import { EMBEDDING_VECTOR_BYTE_LENGTH, EMBEDDING_VECTOR_DIMENSIONS } from "../types/embedding-types.js";

export const CREATE_PROJECT_TABLES_SQL = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  remote_hash TEXT,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX projects_remote_hash_key ON projects (remote_hash) WHERE remote_hash IS NOT NULL;
CREATE UNIQUE INDEX projects_path_key ON projects (path);

CREATE TABLE project_aliases (
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  alias_kind TEXT NOT NULL CHECK (alias_kind IN ('path', 'remote')),
  alias_value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (alias_kind, alias_value)
);

CREATE TABLE project_settings (
  project_id TEXT PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  settings_version INTEGER NOT NULL,
  settings_json TEXT NOT NULL CHECK (json_valid(settings_json)),
  updated_at TEXT NOT NULL
);
`;

export const CREATE_LESSON_TABLES_SQL = `
CREATE TABLE lessons (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects (id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('project', 'global')),
  active_version INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX lessons_active_version_key ON lessons (id, active_version) WHERE active_version IS NOT NULL;
CREATE INDEX lessons_scope_idx ON lessons (scope);
CREATE INDEX lessons_project_idx ON lessons (project_id);

CREATE TABLE lesson_versions (
  lesson_id TEXT NOT NULL REFERENCES lessons (id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  rationale TEXT NOT NULL,
  applicability_json TEXT NOT NULL CHECK (json_valid(applicability_json)),
  provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
  superseded_by_version INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (lesson_id, version),
  FOREIGN KEY (lesson_id, superseded_by_version) REFERENCES lesson_versions (lesson_id, version)
);

CREATE TABLE pending_lesson_candidates (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects (id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('project', 'global')),
  draft_json TEXT NOT NULL CHECK (json_valid(draft_json)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX pending_lesson_candidates_expiry_idx ON pending_lesson_candidates (expires_at);
`;

export const CREATE_LESSON_USAGE_TABLES_SQL = `
CREATE TABLE lesson_retrieval_hits (
  lesson_id TEXT NOT NULL REFERENCES lessons (id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  retrieved_day TEXT NOT NULL,
  PRIMARY KEY (lesson_id, version, retrieved_day)
);
`;

export const CREATE_RETRIEVAL_INDEX_TABLES_SQL = `
CREATE TABLE document_sources (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects (id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('project', 'global')),
  source_type TEXT NOT NULL,
  path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  indexed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (scope = 'project' AND project_id IS NOT NULL) OR
    (scope = 'global' AND project_id IS NULL)
  )
);
CREATE UNIQUE INDEX document_sources_project_path_key
  ON document_sources (project_id, path)
  WHERE scope = 'project';
CREATE UNIQUE INDEX document_sources_global_path_key
  ON document_sources (path)
  WHERE scope = 'global';
CREATE INDEX document_sources_scope_idx ON document_sources (scope, project_id);

CREATE TABLE document_chunks (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES document_sources (id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects (id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('project', 'global')),
  source_type TEXT NOT NULL,
  source_path TEXT NOT NULL,
  heading_path TEXT NOT NULL,
  start_line INTEGER NOT NULL CHECK (start_line > 0),
  end_line INTEGER NOT NULL CHECK (end_line >= start_line),
  content_hash TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (scope = 'project' AND project_id IS NOT NULL) OR
    (scope = 'global' AND project_id IS NULL)
  )
);
CREATE INDEX document_chunks_source_idx ON document_chunks (source_id);
CREATE INDEX document_chunks_scope_idx ON document_chunks (scope, project_id);
CREATE INDEX document_chunks_content_hash_idx ON document_chunks (content_hash);

CREATE TRIGGER document_chunks_source_insert BEFORE INSERT ON document_chunks BEGIN
  SELECT RAISE(ABORT, 'document chunk metadata does not match source')
  WHERE NOT EXISTS (
    SELECT 1
    FROM document_sources
    WHERE id = new.source_id
      AND project_id IS new.project_id
      AND scope = new.scope
      AND source_type = new.source_type
      AND path = new.source_path
  );
END;

CREATE TRIGGER document_chunks_source_update
BEFORE UPDATE OF source_id, project_id, scope, source_type, source_path ON document_chunks BEGIN
  SELECT RAISE(ABORT, 'document chunk metadata does not match source')
  WHERE NOT EXISTS (
    SELECT 1
    FROM document_sources
    WHERE id = new.source_id
      AND project_id IS new.project_id
      AND scope = new.scope
      AND source_type = new.source_type
      AND path = new.source_path
  );
END;

CREATE TRIGGER document_sources_metadata_update
BEFORE UPDATE OF project_id, scope, source_type, path ON document_sources
WHEN EXISTS (SELECT 1 FROM document_chunks WHERE source_id = old.id)
  AND (
    new.project_id IS NOT old.project_id OR
    new.scope != old.scope OR
    new.source_type != old.source_type OR
    new.path != old.path
  )
BEGIN
  SELECT RAISE(ABORT, 'cannot change indexed document source metadata');
END;

CREATE VIRTUAL TABLE document_chunks_fts USING fts5(
  chunk_id UNINDEXED,
  source_path,
  heading_path,
  text
);

CREATE TRIGGER document_chunks_fts_insert AFTER INSERT ON document_chunks BEGIN
  INSERT INTO document_chunks_fts(chunk_id, source_path, heading_path, text)
  VALUES (new.id, new.source_path, new.heading_path, new.text);
END;

CREATE TRIGGER document_chunks_fts_delete AFTER DELETE ON document_chunks BEGIN
  DELETE FROM document_chunks_fts WHERE chunk_id = old.id;
END;

CREATE TRIGGER document_chunks_fts_update
AFTER UPDATE OF id, source_path, heading_path, text ON document_chunks BEGIN
  DELETE FROM document_chunks_fts WHERE chunk_id = old.id;
  INSERT INTO document_chunks_fts(chunk_id, source_path, heading_path, text)
  VALUES (new.id, new.source_path, new.heading_path, new.text);
END;

CREATE VIRTUAL TABLE lesson_versions_fts USING fts5(
  lesson_id UNINDEXED,
  lesson_version UNINDEXED,
  title,
  body
);

CREATE TRIGGER lesson_versions_fts_insert AFTER INSERT ON lesson_versions BEGIN
  INSERT INTO lesson_versions_fts(lesson_id, lesson_version, title, body)
  VALUES (new.lesson_id, new.version, new.title, new.body);
END;

CREATE TRIGGER lesson_versions_fts_delete AFTER DELETE ON lesson_versions BEGIN
  DELETE FROM lesson_versions_fts WHERE lesson_id = old.lesson_id AND lesson_version = old.version;
END;

CREATE TRIGGER lesson_versions_fts_update
AFTER UPDATE OF lesson_id, version, title, body ON lesson_versions BEGIN
  DELETE FROM lesson_versions_fts WHERE lesson_id = old.lesson_id AND lesson_version = old.version;
  INSERT INTO lesson_versions_fts(lesson_id, lesson_version, title, body)
  VALUES (new.lesson_id, new.version, new.title, new.body);
END;

INSERT INTO lesson_versions_fts(lesson_id, lesson_version, title, body)
SELECT lesson_id, version, title, body FROM lesson_versions;

CREATE TABLE document_chunk_embeddings (
  chunk_id TEXT NOT NULL REFERENCES document_chunks (id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  revision TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions = ${EMBEDDING_VECTOR_DIMENSIONS}),
  vector BLOB NOT NULL CHECK (typeof(vector) = 'blob' AND length(vector) = ${EMBEDDING_VECTOR_BYTE_LENGTH}),
  created_at TEXT NOT NULL,
  PRIMARY KEY (chunk_id, model, revision)
);
CREATE INDEX document_chunk_embeddings_version_idx ON document_chunk_embeddings (model, revision);

CREATE TABLE lesson_version_embeddings (
  lesson_id TEXT NOT NULL,
  lesson_version INTEGER NOT NULL,
  model TEXT NOT NULL,
  revision TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions = ${EMBEDDING_VECTOR_DIMENSIONS}),
  vector BLOB NOT NULL CHECK (typeof(vector) = 'blob' AND length(vector) = ${EMBEDDING_VECTOR_BYTE_LENGTH}),
  created_at TEXT NOT NULL,
  PRIMARY KEY (lesson_id, lesson_version, model, revision),
  FOREIGN KEY (lesson_id, lesson_version) REFERENCES lesson_versions (lesson_id, version) ON DELETE CASCADE
);
CREATE INDEX lesson_version_embeddings_version_idx ON lesson_version_embeddings (model, revision);
`;
