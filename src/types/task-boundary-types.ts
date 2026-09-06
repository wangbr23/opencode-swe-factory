import type { TaskBoundary } from "../core/task-taxonomy.js";
import type { TaskProfile, ProfileTaskInput } from "./task-profile-types.js";

export type ProfileTaskFn = (input: ProfileTaskInput) => Promise<TaskProfile>;

export type ActiveTask = Readonly<{
  taskId: string;
  sessionId: string;
  boundary: TaskBoundary;
  agent: string | undefined;
  startedAt: string;
}>;

export type SessionTaskState = {
  rootAgentEstablished: boolean;
  rootAgent: string | undefined;
  topLevelTask: ActiveTask | null;
  subtasks: Map<string, ActiveTask>;
};

export type TaskBoundaryState = {
  readonly sessions: Map<string, SessionTaskState>;
};

export type HandleTaskBoundaryInput = Readonly<{
  sessionId: string;
  messageId?: string;
  agent?: string;
  messageText: string;
  projectId: string;
  declaredStack?: ReadonlyArray<string>;
  now?: string;
}>;

export type HandleTaskBoundaryResult =
  | Readonly<{
      status: "started";
      taskId: string;
      profile: TaskProfile;
      boundary: TaskBoundary;
      previousTaskCompleted: boolean;
    }>
  | Readonly<{
      status: "skipped";
      reason: "private-mode" | "recording-disabled" | "empty-text";
    }>
  | Readonly<{ status: "failed"; error: string }>;

export type CompleteActiveTaskResult =
  | Readonly<{ status: "completed"; taskId: string }>
  | Readonly<{ status: "skipped"; reason: "no-active-task" }>;
