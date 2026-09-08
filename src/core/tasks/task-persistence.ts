import { randomUUID } from "node:crypto";

import type {
  CompleteTaskInput,
  CorrectTaskProfileInput,
  CorrectTaskProfileResult,
  CreateTaskInput,
  CreateTaskResult,
  PersistedTaskProfile,
  PersistTaskProfileInput,
  PersistTaskProfileResult,
  TaskProfileRow,
  TaskRow,
  TaskWithProfile,
} from "../../types/task-persistence-types.js";
import type {
  TaskActivity,
  TaskComplexity,
  TaskDomain,
  TaskProfileSignal,
  TaskRisk,
} from "./task-taxonomy.js";
import type { SqliteConnection } from "../db/sqlite.js";

export type {
  CompleteTaskInput,
  CorrectTaskProfileInput,
  CorrectTaskProfileResult,
  CreateTaskInput,
  CreateTaskResult,
  PersistedTaskProfile,
  PersistTaskProfileInput,
  PersistTaskProfileResult,
  TaskProfileCorrections,
  TaskWithProfile,
} from "../../types/task-persistence-types.js";

export class TaskPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskPersistenceError";
  }
}

function nextProfileVersion(connection: SqliteConnection, taskId: string): number {
  const row = connection.database
    .query<{ max_version: number | null }, [string]>(
      "SELECT MAX(version) AS max_version FROM task_profiles WHERE task_id = ?",
    )
    .get(taskId);
  return (row?.max_version ?? 0) + 1;
}

function toPersistedProfile(row: TaskProfileRow): PersistedTaskProfile {
  return {
    version: row.version,
    taxonomyVersion: row.taxonomy_version,
    activity: row.activity as TaskActivity | null,
    domain: row.domain as TaskDomain | null,
    complexity: row.complexity as TaskComplexity,
    risk: row.risk as TaskRisk,
    stack: JSON.parse(row.stack_json) as string[],
    requiredCapabilities: JSON.parse(row.required_capabilities_json) as string[],
    signals: JSON.parse(row.signals_json) as TaskProfileSignal[],
    summary: row.summary,
    source: row.source as "inferred" | "corrected",
    supersededVersion: row.supersedes_version,
    createdAt: row.created_at,
  };
}

export function createTask(connection: SqliteConnection, input: CreateTaskInput): CreateTaskResult {
  const taskId = randomUUID();
  const now = (input.now ?? new Date()).toISOString();

  connection.database.run(
    `INSERT INTO tasks (id, project_id, parent_task_id, session_id, host_task_id, boundary, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      taskId,
      input.projectId,
      input.parentTaskId ?? null,
      input.sessionId,
      input.hostTaskId ?? null,
      input.boundary,
      now,
      now,
    ],
  );

  return { taskId, boundary: input.boundary, createdAt: now };
}

export function persistTaskProfile(
  connection: SqliteConnection,
  input: PersistTaskProfileInput,
): PersistTaskProfileResult {
  const now = (input.now ?? new Date()).toISOString();
  const p = input.profile;

  return connection.database.transaction((): PersistTaskProfileResult => {
    const version = nextProfileVersion(connection, input.taskId);

    connection.database.run(
      `INSERT INTO task_profiles
        (task_id, version, taxonomy_version, activity, domain, complexity, risk,
         stack_json, required_capabilities_json, signals_json, summary, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'inferred', ?)`,
      [
        input.taskId,
        version,
        p.taxonomyVersion,
        p.activity,
        p.domain,
        p.complexity,
        p.risk,
        JSON.stringify(p.stack),
        JSON.stringify([]),
        JSON.stringify(p.signals),
        p.summary,
        now,
      ],
    );

    connection.database.run(
      "UPDATE tasks SET active_profile_version = ?, updated_at = ? WHERE id = ?",
      [version, now, input.taskId],
    );

    return { taskId: input.taskId, version, source: "inferred" as const };
  })();
}

export function correctTaskProfile(
  connection: SqliteConnection,
  input: CorrectTaskProfileInput,
): CorrectTaskProfileResult {
  const now = (input.now ?? new Date()).toISOString();

  return connection.database.transaction((): CorrectTaskProfileResult => {
    const task = connection.database
      .query<TaskRow, [string]>(
        "SELECT id, project_id, parent_task_id, session_id, host_task_id, boundary, active_profile_version, completed_at, created_at, updated_at FROM tasks WHERE id = ?",
      )
      .get(input.taskId);

    if (!task) {
      throw new TaskPersistenceError(`Task ${input.taskId} not found.`);
    }
    if (task.active_profile_version === null) {
      throw new TaskPersistenceError(`Task ${input.taskId} has no active profile to correct.`);
    }

    const current = connection.database
      .query<TaskProfileRow, [string, number]>(
        "SELECT task_id, version, taxonomy_version, activity, domain, complexity, risk, stack_json, required_capabilities_json, signals_json, summary, source, supersedes_version, created_at FROM task_profiles WHERE task_id = ? AND version = ?",
      )
      .get(input.taskId, task.active_profile_version);

    if (!current) {
      throw new TaskPersistenceError(
        `Active profile version ${task.active_profile_version} not found for task ${input.taskId}.`,
      );
    }

    const c = input.corrections;
    const activity = "activity" in c ? c.activity : current.activity;
    const domain = "domain" in c ? c.domain : current.domain;
    const complexity = c.complexity ?? current.complexity;
    const risk = c.risk ?? current.risk;
    const stack = c.stack ?? (JSON.parse(current.stack_json) as string[]);

    const newVersion = nextProfileVersion(connection, input.taskId);

    connection.database.run(
      `INSERT INTO task_profiles
        (task_id, version, taxonomy_version, activity, domain, complexity, risk,
         stack_json, required_capabilities_json, signals_json, summary, source, supersedes_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'corrected', ?, ?)`,
      [
        input.taskId,
        newVersion,
        current.taxonomy_version,
        activity,
        domain,
        complexity,
        risk,
        JSON.stringify(stack),
        current.required_capabilities_json,
        current.signals_json,
        current.summary,
        task.active_profile_version,
        now,
      ],
    );

    connection.database.run(
      "UPDATE tasks SET active_profile_version = ?, updated_at = ? WHERE id = ?",
      [newVersion, now, input.taskId],
    );

    return {
      taskId: input.taskId,
      version: newVersion,
      supersededVersion: task.active_profile_version,
      source: "corrected" as const,
    };
  })();
}

export function completeTask(connection: SqliteConnection, input: CompleteTaskInput): void {
  const now = (input.now ?? new Date()).toISOString();

  const task = connection.database
    .query<{ id: string; completed_at: string | null }, [string]>(
      "SELECT id, completed_at FROM tasks WHERE id = ?",
    )
    .get(input.taskId);

  if (!task) {
    throw new TaskPersistenceError(`Task ${input.taskId} not found.`);
  }
  if (task.completed_at !== null) {
    return;
  }

  connection.database.run(
    "UPDATE tasks SET completed_at = ?, updated_at = ? WHERE id = ?",
    [now, now, input.taskId],
  );
}

export function getTaskWithProfile(
  connection: SqliteConnection,
  taskId: string,
): TaskWithProfile | null {
  const task = connection.database
    .query<TaskRow, [string]>(
      "SELECT id, project_id, parent_task_id, session_id, host_task_id, boundary, active_profile_version, completed_at, created_at, updated_at FROM tasks WHERE id = ?",
    )
    .get(taskId);

  if (!task) {
    return null;
  }

  let activeProfile: PersistedTaskProfile | null = null;
  if (task.active_profile_version !== null) {
    const profileRow = connection.database
      .query<TaskProfileRow, [string, number]>(
        "SELECT task_id, version, taxonomy_version, activity, domain, complexity, risk, stack_json, required_capabilities_json, signals_json, summary, source, supersedes_version, created_at FROM task_profiles WHERE task_id = ? AND version = ?",
      )
      .get(task.id, task.active_profile_version);
    if (profileRow) {
      activeProfile = toPersistedProfile(profileRow);
    }
  }

  return {
    taskId: task.id,
    projectId: task.project_id,
    sessionId: task.session_id,
    boundary: task.boundary as "top-level" | "subtask",
    parentTaskId: task.parent_task_id,
    hostTaskId: task.host_task_id,
    activeProfileVersion: task.active_profile_version,
    completedAt: task.completed_at,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
    activeProfile,
  };
}
