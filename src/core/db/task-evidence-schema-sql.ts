export const CREATE_TASK_EVIDENCE_TABLES_SQL = `
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  parent_task_id TEXT REFERENCES tasks (id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  host_task_id TEXT,
  boundary TEXT NOT NULL CHECK (boundary IN ('top-level', 'subtask')),
  active_profile_version INTEGER CHECK (active_profile_version IS NULL OR active_profile_version > 0),
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (boundary = 'top-level' AND parent_task_id IS NULL) OR
    (boundary = 'subtask' AND parent_task_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX tasks_session_host_task_key
  ON tasks (session_id, host_task_id)
  WHERE host_task_id IS NOT NULL;
CREATE INDEX tasks_project_created_idx ON tasks (project_id, created_at);
CREATE INDEX tasks_parent_idx ON tasks (parent_task_id);

CREATE TRIGGER tasks_parent_insert BEFORE INSERT ON tasks
WHEN new.parent_task_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'task parent must belong to the same project')
  WHERE NOT EXISTS (
    SELECT 1
    FROM tasks
    WHERE id = new.parent_task_id
      AND project_id = new.project_id
  );
END;

CREATE TRIGGER tasks_identity_update
BEFORE UPDATE OF project_id, parent_task_id, session_id, host_task_id, boundary ON tasks BEGIN
  SELECT RAISE(ABORT, 'task identity fields are immutable');
END;

CREATE TABLE task_profiles (
  task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  taxonomy_version INTEGER NOT NULL CHECK (taxonomy_version > 0),
  activity TEXT,
  domain TEXT,
  complexity TEXT NOT NULL,
  risk TEXT NOT NULL,
  stack_json TEXT NOT NULL CHECK (json_valid(stack_json) AND json_type(stack_json) = 'array'),
  required_capabilities_json TEXT NOT NULL
    CHECK (json_valid(required_capabilities_json) AND json_type(required_capabilities_json) = 'array'),
  signals_json TEXT NOT NULL CHECK (json_valid(signals_json) AND json_type(signals_json) = 'array'),
  summary TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('inferred', 'corrected')),
  supersedes_version INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, version),
  FOREIGN KEY (task_id, supersedes_version) REFERENCES task_profiles (task_id, version),
  CHECK (
    (source = 'inferred' AND supersedes_version IS NULL) OR
    (source = 'corrected' AND supersedes_version IS NOT NULL)
  )
);
CREATE UNIQUE INDEX task_profiles_supersedes_key
  ON task_profiles (task_id, supersedes_version)
  WHERE supersedes_version IS NOT NULL;

CREATE TRIGGER task_profiles_update BEFORE UPDATE ON task_profiles BEGIN
  SELECT RAISE(ABORT, 'task profiles are immutable');
END;

CREATE TRIGGER tasks_active_profile_insert BEFORE INSERT ON tasks
WHEN new.active_profile_version IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'new tasks cannot reference a task profile before it exists');
END;

CREATE TRIGGER tasks_active_profile_update BEFORE UPDATE OF active_profile_version ON tasks
WHEN new.active_profile_version IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'active task profile does not exist')
  WHERE NOT EXISTS (
    SELECT 1
    FROM task_profiles
    WHERE task_id = new.id AND version = new.active_profile_version
  );
END;

CREATE TABLE execution_profiles (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  task_profile_version INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  variant TEXT,
  agent TEXT NOT NULL,
  selection_source TEXT NOT NULL,
  host_provider TEXT,
  host_model TEXT,
  host_variant TEXT,
  tool_profile_json TEXT NOT NULL CHECK (json_valid(tool_profile_json)),
  software_versions_json TEXT NOT NULL CHECK (json_valid(software_versions_json)),
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0),
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  reasoning_tokens INTEGER NOT NULL CHECK (reasoning_tokens >= 0),
  cache_read_tokens INTEGER NOT NULL CHECK (cache_read_tokens >= 0),
  cache_write_tokens INTEGER NOT NULL CHECK (cache_write_tokens >= 0),
  cost_usd REAL NOT NULL CHECK (cost_usd >= 0),
  finish_state TEXT NOT NULL,
  provider_error_kind TEXT,
  provider_error_code TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (id, task_id),
  FOREIGN KEY (task_id, task_profile_version) REFERENCES task_profiles (task_id, version) ON DELETE CASCADE,
  CHECK ((host_provider IS NULL) = (host_model IS NULL))
);
CREATE INDEX execution_profiles_task_idx ON execution_profiles (task_id, completed_at);
CREATE INDEX execution_profiles_model_idx ON execution_profiles (provider, model, variant, completed_at);

CREATE TABLE outcome_signals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  execution_id TEXT,
  dimension TEXT NOT NULL CHECK (dimension IN ('quality', 'reliability', 'cost', 'latency')),
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  value REAL NOT NULL,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  lesson_id TEXT,
  lesson_version INTEGER,
  supersedes_signal_id TEXT,
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (id, task_id),
  FOREIGN KEY (execution_id, task_id) REFERENCES execution_profiles (id, task_id) ON DELETE CASCADE,
  FOREIGN KEY (lesson_id, lesson_version) REFERENCES lesson_versions (lesson_id, version) ON DELETE CASCADE,
  FOREIGN KEY (supersedes_signal_id, task_id) REFERENCES outcome_signals (id, task_id) ON DELETE CASCADE,
  CHECK ((lesson_id IS NULL) = (lesson_version IS NULL))
);
CREATE UNIQUE INDEX outcome_signals_supersedes_key
  ON outcome_signals (supersedes_signal_id)
  WHERE supersedes_signal_id IS NOT NULL;
CREATE INDEX outcome_signals_task_idx ON outcome_signals (task_id, observed_at);
CREATE INDEX outcome_signals_execution_idx ON outcome_signals (execution_id);
CREATE INDEX outcome_signals_dimension_idx ON outcome_signals (dimension, observed_at);

CREATE TRIGGER outcome_signals_update BEFORE UPDATE ON outcome_signals BEGIN
  SELECT RAISE(ABORT, 'outcome signals are immutable');
END;
`;
