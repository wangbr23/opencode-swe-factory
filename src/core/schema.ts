import type { SchemaMigration } from "./migrations.js";

const createProjectTablesSql = `
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

const createLessonTablesSql = `
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

export const releaseSchemaMigrations: readonly SchemaMigration[] = [
  {
    version: 1,
    name: "create projects, aliases, and project settings",
    migrate(database) {
      database.run(createProjectTablesSql);
    },
  },
  {
    version: 2,
    name: "create lessons, immutable versions, and pending candidates",
    migrate(database) {
      database.run(createLessonTablesSql);
    },
  },
];
