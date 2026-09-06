import type {
  TaskActivity,
  TaskBoundary,
  TaskComplexity,
  TaskDomain,
  TaskProfileSignal,
  TaskRisk,
} from "../core/task-taxonomy.js";

export type CreateTaskInput = Readonly<{
  projectId: string;
  sessionId: string;
  boundary: TaskBoundary;
  parentTaskId?: string;
  hostTaskId?: string;
  now?: Date;
}>;

export type CreateTaskResult = Readonly<{
  taskId: string;
  boundary: TaskBoundary;
  createdAt: string;
}>;

export type PersistTaskProfileInput = Readonly<{
  taskId: string;
  profile: Readonly<{
    taxonomyVersion: number;
    activity: TaskActivity | null;
    domain: TaskDomain | null;
    complexity: TaskComplexity;
    risk: TaskRisk;
    stack: ReadonlyArray<string>;
    signals: ReadonlyArray<TaskProfileSignal>;
    summary: string;
  }>;
  now?: Date;
}>;

export type PersistTaskProfileResult = Readonly<{
  taskId: string;
  version: number;
  source: "inferred";
}>;

export type TaskProfileCorrections = Readonly<{
  activity?: TaskActivity | null;
  domain?: TaskDomain | null;
  complexity?: TaskComplexity;
  risk?: TaskRisk;
  stack?: ReadonlyArray<string>;
}>;

export type CorrectTaskProfileInput = Readonly<{
  taskId: string;
  corrections: TaskProfileCorrections;
  now?: Date;
}>;

export type CorrectTaskProfileResult = Readonly<{
  taskId: string;
  version: number;
  supersededVersion: number;
  source: "corrected";
}>;

export type CompleteTaskInput = Readonly<{
  taskId: string;
  now?: Date;
}>;

export type PersistedTaskProfile = Readonly<{
  version: number;
  taxonomyVersion: number;
  activity: TaskActivity | null;
  domain: TaskDomain | null;
  complexity: TaskComplexity;
  risk: TaskRisk;
  stack: ReadonlyArray<string>;
  requiredCapabilities: ReadonlyArray<string>;
  signals: ReadonlyArray<TaskProfileSignal>;
  summary: string;
  source: "inferred" | "corrected";
  supersededVersion: number | null;
  createdAt: string;
}>;

export type TaskWithProfile = Readonly<{
  taskId: string;
  projectId: string;
  sessionId: string;
  boundary: TaskBoundary;
  parentTaskId: string | null;
  hostTaskId: string | null;
  activeProfileVersion: number | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  activeProfile: PersistedTaskProfile | null;
}>;

export type TaskRow = Readonly<{
  id: string;
  project_id: string;
  parent_task_id: string | null;
  session_id: string;
  host_task_id: string | null;
  boundary: string;
  active_profile_version: number | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}>;

export type TaskProfileRow = Readonly<{
  task_id: string;
  version: number;
  taxonomy_version: number;
  activity: string | null;
  domain: string | null;
  complexity: string;
  risk: string;
  stack_json: string;
  required_capabilities_json: string;
  signals_json: string;
  summary: string;
  source: string;
  supersedes_version: number | null;
  created_at: string;
}>;
