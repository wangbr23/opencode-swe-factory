import type { SchemaMigration } from "./migrations.js";
import {
  CREATE_LESSON_TABLES_SQL,
  CREATE_PROJECT_TABLES_SQL,
  CREATE_RETRIEVAL_INDEX_TABLES_SQL,
} from "./schema-sql.js";
import { CREATE_TASK_EVIDENCE_TABLES_SQL } from "./task-evidence-schema-sql.js";

export const releaseSchemaMigrations: readonly SchemaMigration[] = [
  {
    version: 1,
    name: "create projects, aliases, and project settings",
    migrate(database) {
      database.run(CREATE_PROJECT_TABLES_SQL);
    },
  },
  {
    version: 2,
    name: "create lessons, immutable versions, and pending candidates",
    migrate(database) {
      database.run(CREATE_LESSON_TABLES_SQL);
    },
  },
  {
    version: 3,
    name: "create document indexes, full-text search, and embeddings",
    migrate(database) {
      database.run(CREATE_RETRIEVAL_INDEX_TABLES_SQL);
    },
  },
  {
    version: 4,
    name: "create tasks, execution profiles, and outcome signals",
    migrate(database) {
      database.run(CREATE_TASK_EVIDENCE_TABLES_SQL);
    },
  },
];
