export type OutcomeDimension = "quality" | "reliability" | "cost" | "latency";

export type ExecutionTokens = Readonly<{
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}>;

export type RecordExecutionProfileInput = Readonly<{
  taskId: string;
  provider: string;
  model: string;
  variant?: string;
  agent: string;
  selectionSource: string;
  hostProvider?: string;
  hostModel?: string;
  hostVariant?: string;
  toolProfile?: Record<string, unknown>;
  softwareVersions?: Record<string, unknown>;
  startedAt: Date;
  completedAt: Date;
  latencyMs: number;
  tokens: ExecutionTokens;
  costUsd: number;
  finishState: string;
  providerErrorKind?: string;
  providerErrorCode?: string;
  now?: Date;
}>;

export type RecordExecutionProfileResult = Readonly<{
  executionId: string;
  taskId: string;
  taskProfileVersion: number;
}>;

export type RecordOutcomeSignalInput = Readonly<{
  taskId: string;
  executionId?: string;
  dimension: OutcomeDimension;
  kind: string;
  source: string;
  confidence: number;
  value: number;
  metadata?: Record<string, unknown>;
  lessonId?: string;
  lessonVersion?: number;
  supersedesSignalId?: string;
  observedAt?: Date;
  now?: Date;
}>;

export type RecordOutcomeSignalResult = Readonly<{
  signalId: string;
  taskId: string;
  dimension: OutcomeDimension;
}>;

export type ExecutionProfileRow = Readonly<{
  id: string;
  task_id: string;
  task_profile_version: number;
  provider: string;
  model: string;
  variant: string | null;
  agent: string;
  selection_source: string;
  host_provider: string | null;
  host_model: string | null;
  host_variant: string | null;
  tool_profile_json: string;
  software_versions_json: string;
  started_at: string;
  completed_at: string;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  finish_state: string;
  provider_error_kind: string | null;
  provider_error_code: string | null;
  created_at: string;
}>;

export type OutcomeSignalRow = Readonly<{
  id: string;
  task_id: string;
  execution_id: string | null;
  dimension: string;
  kind: string;
  source: string;
  confidence: number;
  value: number;
  metadata_json: string;
  lesson_id: string | null;
  lesson_version: number | null;
  supersedes_signal_id: string | null;
  observed_at: string;
  created_at: string;
}>;
