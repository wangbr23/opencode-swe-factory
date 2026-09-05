import {
  TASK_BOUNDARY_VALUES,
  TASK_TAXONOMY_VERSION,
  type TaskComplexity,
  type TaskProfileSignal,
  type TaskRisk,
} from "./task-taxonomy.js";
import { scanTextForSecrets } from "./secrets.js";
import {
  ACTIVITY_KEYWORDS,
  DOMAIN_KEYWORDS,
  HIGH_COMPLEXITY_KEYWORDS,
  HIGH_RISK_KEYWORDS,
  MAX_SUMMARY_CHARS,
  STACK_KEYWORDS,
  type ProfileTaskInput,
  type TaskProfile,
} from "../types/task-profile-types.js";

export type { ProfileTaskInput, TaskProfile } from "../types/task-profile-types.js";

export class TaskProfileInputError extends Error {}

function requireEnum<T extends string>(value: unknown, allowed: ReadonlyArray<T>, label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new TaskProfileInputError(`${label} must be one of ${allowed.join(", ")}.`);
  }
  return value as T;
}

function countKeywordHits(text: string, keywords: ReadonlyArray<string>): number {
  let hits = 0;
  for (const keyword of keywords) {
    const pattern = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:s|es)?\\b`, "gi");
    if (pattern.test(text)) {
      hits += 1;
    }
  }
  return hits;
}

function classifyByKeywords<T extends string>(text: string, groups: ReadonlyArray<readonly [T, ReadonlyArray<string>]>): { value: T | null; matched: boolean } {
  let best: { value: T; hits: number } | undefined;
  for (const [value, keywords] of groups) {
    const hits = countKeywordHits(text, keywords);
    if (hits > 0 && (best === undefined || hits > best.hits)) {
      best = { value, hits };
    }
  }
  return { value: best?.value ?? null, matched: best !== undefined };
}

function detectStack(input: ProfileTaskInput, taskText: string): { stack: string[]; lexicalMatched: boolean } {
  const stack = new Set<string>();
  for (const declared of input.declaredStack ?? []) {
    if (typeof declared !== "string" || declared.trim().length === 0) {
      throw new TaskProfileInputError("declaredStack entries must be non-empty strings.");
    }
    stack.add(declared.toLowerCase());
  }
  let lexicalMatched = false;
  for (const [stackName, keywords] of STACK_KEYWORDS) {
    if (countKeywordHits(taskText, keywords) > 0) {
      stack.add(stackName);
      lexicalMatched = true;
    }
  }
  return { stack: [...stack].sort(), lexicalMatched };
}

function collapseTaskText(taskText: string): string {
  return taskText.replaceAll(/\s+/g, " ").trim();
}

function truncateSummary(summary: string): string {
  if (summary.length <= MAX_SUMMARY_CHARS) {
    return summary;
  }
  return `${summary.slice(0, MAX_SUMMARY_CHARS)}…`;
}

/**
 * Profiles a task deterministically from lexical features, the declared
 * stack, and the task boundary — no generative-model call, no randomness.
 * The summary is secret-scanned and truncated so nothing beyond the bounded
 * redacted fragment is retained; raw classifier input is discarded.
 */
export async function profileTask(input: ProfileTaskInput): Promise<TaskProfile> {
  const boundary = requireEnum(input.boundary, TASK_BOUNDARY_VALUES, "boundary");
  if (typeof input.taskText !== "string") {
    throw new TaskProfileInputError("taskText must be a string.");
  }

  const taskText = input.taskText.toLowerCase();
  const activityMatch = classifyByKeywords(taskText, ACTIVITY_KEYWORDS);
  const domainMatch = classifyByKeywords(taskText, DOMAIN_KEYWORDS);
  const stackDetection = detectStack(input, taskText);
  const stack = stackDetection.stack;

  const highComplexitySignals =
    HIGH_COMPLEXITY_KEYWORDS.some((keyword) => countKeywordHits(taskText, [keyword]) > 0) ||
    taskText.length > 600;
  let complexity: TaskComplexity;
  if (highComplexitySignals) {
    complexity = "high";
  } else if (taskText.trim().length < 120) {
    complexity = "low";
  } else {
    complexity = "medium";
  }

  const securityInvolved =
    domainMatch.value === "security" || countKeywordHits(taskText, HIGH_RISK_KEYWORDS) > 0;

  let risk: TaskRisk;
  if (securityInvolved) {
    risk = "high";
  } else if ((activityMatch.value === "test" || activityMatch.value === "document" || activityMatch.value === "review") && complexity !== "high") {
    risk = "low";
  } else {
    risk = "medium";
  }

  const signals: TaskProfileSignal[] = [];
  if (activityMatch.matched) {
    signals.push("activity-lexical");
  }
  if (domainMatch.matched) {
    signals.push("domain-lexical");
  }
  if (input.declaredStack !== undefined && input.declaredStack.length > 0) {
    signals.push("declared-stack");
  }
  if (stackDetection.lexicalMatched) {
    signals.push("stack-lexical");
  }

  const scan = await scanTextForSecrets(collapseTaskText(input.taskText));
  const summary = truncateSummary(scan.redactedText);

  return {
    taxonomyVersion: TASK_TAXONOMY_VERSION,
    boundary,
    activity: activityMatch.value,
    domain: domainMatch.value,
    complexity,
    risk,
    stack,
    signals: [...signals].sort(),
    summary,
  };
}
