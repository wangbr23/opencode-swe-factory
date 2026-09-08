import type { ConfigV1 } from "../../../src/types/config-types.js";

export const LESSON_DRAFT = {
  title: "Run tests before commits",
  body: "Always run bun test before committing changes to the repository",
  rationale: "User corrected a commit without tests.",
  applicability: {},
  provenance: {},
} as const;

export const RECALL_QUERY = "run tests before commits";

export const USER_TABLES = [
  "projects",
  "project_aliases",
  "project_settings",
  "lessons",
  "lesson_versions",
  "pending_lesson_candidates",
  "document_sources",
  "document_chunks",
  "document_chunk_embeddings",
  "lesson_version_embeddings",
  "tasks",
  "task_profiles",
  "execution_profiles",
  "outcome_signals",
] as const;

export const FTS_TABLES = ["lesson_versions_fts", "document_chunks_fts"] as const;

export function retentionLimitedBackups(maxBackups: number): ConfigV1["backups"] {
  return {
    enabled: true,
    schedule: { intervalDays: null },
    retention: { maxBackups },
  };
}
