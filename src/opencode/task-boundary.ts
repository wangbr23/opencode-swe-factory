import {
  createTask,
  persistTaskProfile,
  completeTask,
} from "../core/task-persistence.js";
import type { TaskBoundary } from "../core/task-taxonomy.js";
import type { SqliteConnection } from "../core/sqlite.js";
import type { ResolvedFeatureToggles } from "../types/feature-toggle-types.js";
import type {
  ActiveTask,
  CompleteActiveTaskResult,
  HandleTaskBoundaryInput,
  HandleTaskBoundaryResult,
  ProfileTaskFn,
  SessionTaskState,
  TaskBoundaryState,
} from "../types/task-boundary-types.js";

export type {
  ActiveTask,
  CompleteActiveTaskResult,
  HandleTaskBoundaryInput,
  HandleTaskBoundaryResult,
  ProfileTaskFn,
  SessionTaskState,
  TaskBoundaryState,
} from "../types/task-boundary-types.js";

export function createTaskBoundaryState(): TaskBoundaryState {
  return { sessions: new Map() };
}

function getOrCreateSessionState(
  state: TaskBoundaryState,
  sessionId: string,
): SessionTaskState {
  let session = state.sessions.get(sessionId);
  if (!session) {
    session = {
      rootAgentEstablished: false,
      rootAgent: undefined,
      topLevelTask: null,
      subtasks: new Map(),
    };
    state.sessions.set(sessionId, session);
  }
  return session;
}

function determineBoundary(
  session: SessionTaskState,
  agent: string | undefined,
): TaskBoundary {
  if (!session.rootAgentEstablished) {
    return "top-level";
  }
  if (agent === undefined || agent === session.rootAgent) {
    return "top-level";
  }
  return "subtask";
}

function completeTaskRecord(
  connection: SqliteConnection,
  task: ActiveTask,
  now: string | undefined,
): void {
  const input =
    now !== undefined
      ? { taskId: task.taskId, now: new Date(now) }
      : { taskId: task.taskId };
  completeTask(connection, input);
}

export function extractMessageText(
  parts: ReadonlyArray<{ type: string; text?: string }>,
): string {
  const texts: string[] = [];
  for (const part of parts) {
    if (part.type === "text" && typeof part.text === "string") {
      texts.push(part.text);
    }
  }
  return texts.join("\n").trim();
}

export async function handleTaskBoundary(
  state: TaskBoundaryState,
  connection: SqliteConnection,
  toggles: ResolvedFeatureToggles,
  input: HandleTaskBoundaryInput,
  profileFn: ProfileTaskFn,
): Promise<HandleTaskBoundaryResult> {
  if (toggles.privateMode) {
    return { status: "skipped", reason: "private-mode" };
  }
  if (!toggles.recording) {
    return { status: "skipped", reason: "recording-disabled" };
  }

  const trimmed = input.messageText.trim();
  if (trimmed.length === 0) {
    return { status: "skipped", reason: "empty-text" };
  }

  try {
    const session = getOrCreateSessionState(state, input.sessionId);
    const boundary = determineBoundary(session, input.agent);

    let previousTaskCompleted = false;
    if (boundary === "top-level" && session.topLevelTask) {
      completeTaskRecord(connection, session.topLevelTask, input.now);
      previousTaskCompleted = true;
    } else if (boundary === "subtask" && input.agent !== undefined) {
      const existing = session.subtasks.get(input.agent);
      if (existing) {
        completeTaskRecord(connection, existing, input.now);
        previousTaskCompleted = true;
      }
    }

    if (!session.rootAgentEstablished) {
      session.rootAgent = input.agent;
      session.rootAgentEstablished = true;
    }

    const profileInput =
      input.declaredStack !== undefined
        ? {
            taskText: trimmed,
            boundary,
            declaredStack: input.declaredStack,
          }
        : { taskText: trimmed, boundary };
    const profile = await profileFn(profileInput);

    const parentTaskId =
      boundary === "subtask" ? session.topLevelTask?.taskId : undefined;

    const nowDate =
      input.now !== undefined ? new Date(input.now) : undefined;

    const createInput = (() => {
      const base = {
        projectId: input.projectId,
        sessionId: input.sessionId,
        boundary,
      };
      const withNow =
        nowDate !== undefined ? { ...base, now: nowDate } : base;
      if (parentTaskId !== undefined && input.messageId !== undefined) {
        return {
          ...withNow,
          parentTaskId,
          hostTaskId: input.messageId,
        };
      }
      if (parentTaskId !== undefined) {
        return { ...withNow, parentTaskId };
      }
      if (input.messageId !== undefined) {
        return { ...withNow, hostTaskId: input.messageId };
      }
      return withNow;
    })();

    const result = createTask(connection, createInput);

    const persistInput =
      nowDate !== undefined
        ? { taskId: result.taskId, profile, now: nowDate }
        : { taskId: result.taskId, profile };
    persistTaskProfile(connection, persistInput);

    const activeTask: ActiveTask = {
      taskId: result.taskId,
      sessionId: input.sessionId,
      boundary,
      agent: input.agent,
      startedAt: result.createdAt,
    };

    if (boundary === "top-level") {
      session.topLevelTask = activeTask;
    } else if (input.agent !== undefined) {
      session.subtasks.set(input.agent, activeTask);
    }

    return {
      status: "started",
      taskId: result.taskId,
      profile,
      boundary,
      previousTaskCompleted,
    };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function completeActiveTask(
  state: TaskBoundaryState,
  connection: SqliteConnection,
  sessionId: string,
  agent?: string,
  now?: string,
): CompleteActiveTaskResult {
  const session = state.sessions.get(sessionId);
  if (!session) {
    return { status: "skipped", reason: "no-active-task" };
  }

  let task: ActiveTask | null = null;
  if (agent !== undefined && agent !== session.rootAgent) {
    task = session.subtasks.get(agent) ?? null;
    if (task) session.subtasks.delete(agent);
  } else {
    task = session.topLevelTask;
    if (task) session.topLevelTask = null;
  }

  if (!task) {
    return { status: "skipped", reason: "no-active-task" };
  }

  try {
    completeTaskRecord(connection, task, now);
  } catch {
    // fail-open: completion errors are not critical
  }
  return { status: "completed", taskId: task.taskId };
}

export function completeSessionTasks(
  state: TaskBoundaryState,
  connection: SqliteConnection,
  sessionId: string,
  now?: string,
): ReadonlyArray<string> {
  const session = state.sessions.get(sessionId);
  if (!session) return [];

  const completed: string[] = [];

  for (const [, task] of session.subtasks) {
    try {
      completeTaskRecord(connection, task, now);
    } catch {
      // fail-open
    }
    completed.push(task.taskId);
  }
  session.subtasks.clear();

  if (session.topLevelTask) {
    try {
      completeTaskRecord(connection, session.topLevelTask, now);
    } catch {
      // fail-open
    }
    completed.push(session.topLevelTask.taskId);
    session.topLevelTask = null;
  }

  state.sessions.delete(sessionId);
  return completed;
}

export function getActiveTask(
  state: TaskBoundaryState,
  sessionId: string,
  agent?: string,
): ActiveTask | null {
  const session = state.sessions.get(sessionId);
  if (!session) return null;

  if (agent !== undefined && agent !== session.rootAgent) {
    return session.subtasks.get(agent) ?? null;
  }
  return session.topLevelTask;
}
