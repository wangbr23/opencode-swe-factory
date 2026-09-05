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

export const releaseSchemaMigrations: readonly SchemaMigration[] = [
  {
    version: 1,
    name: "create projects, aliases, and project settings",
    migrate(database) {
      database.run(createProjectTablesSql);
    },
  },
];
