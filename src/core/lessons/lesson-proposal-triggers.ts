import { LESSON_PROPOSAL_TRIGGER_CONSTANTS, VERIFICATION_CATEGORIES } from "./lesson-proposal-trigger-constants.js";
import { proposeLessonCandidate } from "./lessons.js";
import { scanTextForSecrets } from "../secrets.js";
import type { SqliteConnection } from "../db/sqlite.js";
import type { ToolOutcomeCategory } from "../../types/tool-outcome-signal-types.js";
import type {
  EvaluateLessonProposalTriggerInput,
  LessonProposalTriggerKind,
  LessonProposalTriggerResult,
  ProposalTaskProfileSnapshot,
  QualifyingTaskEvidence,
} from "../../types/lesson-proposal-trigger-types.js";
import type { LessonCandidateDraft } from "../../types/lessons-types.js";

export type {
  EvaluateLessonProposalTriggerInput,
  LessonProposalTriggerKind,
  LessonProposalTriggerReason,
  LessonProposalTriggerResult,
  ProposalTaskProfileSnapshot,
  QualifyingTaskEvidence,
} from "../../types/lesson-proposal-trigger-types.js";
export { LESSON_PROPOSAL_TRIGGER_CONSTANTS, VERIFICATION_CATEGORIES } from "./lesson-proposal-trigger-constants.js";

export class LessonProposalTriggerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LessonProposalTriggerError";
  }
}

type TaskRow = Readonly<{
  task_id: string;
  activity: string | null;
  domain: string | null;
  complexity: string | null;
  risk: string | null;
  stack_json: string | null;
  summary: string | null;
}>;

type SignalRow = Readonly<{
  task_id: string;
  kind: string;
  value: number;
  metadata_json: string;
  observed_at: string;
  superseded_by: string | null;
}>;

type ClassifiedTask = Readonly<{
  taskId: string;
  verifiedCategories: ReadonlyArray<ToolOutcomeCategory>;
  hasExplicitAcceptance: boolean;
  latestPositiveObservedAt: string;
  profile: ProposalTaskProfileSnapshot | null;
}>;

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new LessonProposalTriggerError(`${label} must be a non-empty string.`);
  }
  return value;
}

function resolveMinVerifiedSuccesses(value: number | undefined): number {
  const resolved = value ?? LESSON_PROPOSAL_TRIGGER_CONSTANTS.defaultMinVerifiedSuccesses;
  if (!Number.isInteger(resolved) || resolved < 2) {
    throw new LessonProposalTriggerError(
      "minVerifiedSuccesses must be an integer of at least 2; repeated success needs repetition.",
    );
  }
  return resolved;
}

function parseProfileStack(stackJson: string | null): ReadonlyArray<string> {
  if (stackJson === null) {
    return [];
  }
  const parsed: unknown = JSON.parse(stackJson);
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new LessonProposalTriggerError("Task profile stack must be a JSON array of strings.");
  }
  return parsed;
}

function parseTaskProfile(row: TaskRow): ProposalTaskProfileSnapshot | null {
  if (row.activity === null && row.complexity === null) {
    return null;
  }
  return {
    activity: row.activity,
    domain: row.domain,
    complexity: row.complexity ?? "",
    risk: row.risk ?? "",
    stack: parseProfileStack(row.stack_json),
    summary: row.summary ?? "",
  };
}

/**
 * Collect task ids already cited by an automatic proposal's provenance, from
 * both pending candidates and approved lesson versions of the project. This
 * is the dedup state: a proposal consumes its evidence tasks, and only fresh
 * successes can trigger the next one. Manual drafts never match the marker.
 */
function collectCitedAutomaticTaskIds(connection: SqliteConnection, projectId: string): ReadonlySet<string> {
  const cited = new Set<string>();
  const readProvenance = (raw: unknown): void => {
    let provenance: unknown = raw;
    if (typeof provenance === "string") {
      try {
        provenance = JSON.parse(provenance);
      } catch {
        return;
      }
    }
    if (
      typeof provenance !== "object" ||
      provenance === null ||
      (provenance as Record<string, unknown>).trigger !== LESSON_PROPOSAL_TRIGGER_CONSTANTS.automaticProvenanceTrigger
    ) {
      return;
    }
    const evidenceTaskIds = (provenance as Record<string, unknown>).evidenceTaskIds;
    if (!Array.isArray(evidenceTaskIds)) {
      return;
    }
    for (const id of evidenceTaskIds) {
      if (typeof id === "string") {
        cited.add(id);
      }
    }
  };

  const candidateRows = connection.database
    .query<{ draft_json: string }, [string]>(
      "SELECT draft_json FROM pending_lesson_candidates WHERE project_id = ?",
    )
    .all(projectId);
  for (const row of candidateRows) {
    try {
      const stored = JSON.parse(row.draft_json) as { draft?: { provenance?: unknown } };
      readProvenance(stored.draft?.provenance);
    } catch {
      continue;
    }
  }

  const lessonRows = connection.database
    .query<{ provenance_json: string }, [string]>(
      `SELECT lesson_versions.provenance_json
       FROM lesson_versions
       JOIN lessons ON lessons.id = lesson_versions.lesson_id
       WHERE lessons.scope = 'project' AND lessons.project_id = ?`,
    )
    .all(projectId);
  for (const row of lessonRows) {
    readProvenance(row.provenance_json);
  }

  return cited;
}

function classifyTasks(
  connection: SqliteConnection,
  projectId: string,
  since: string | undefined,
): ReadonlyArray<ClassifiedTask> {
  // The lower bound is always bound; an empty string precedes every ISO
  // timestamp, so an undefined `since` imposes no restriction.
  const taskRows = connection.database
    .query<TaskRow, [string, string]>(
      `SELECT t.id AS task_id, p.activity, p.domain, p.complexity, p.risk, p.stack_json, p.summary
       FROM tasks t
       LEFT JOIN task_profiles p
         ON p.task_id = t.id AND p.version = t.active_profile_version
       WHERE t.project_id = ?
         AND t.completed_at IS NOT NULL
         AND t.completed_at >= ?
       ORDER BY t.completed_at ASC, t.id ASC`,
    )
    .all(projectId, since ?? "");
  if (taskRows.length === 0) {
    return [];
  }

  const signalRows = connection.database
    .query<SignalRow, [string]>(
      `SELECT s.task_id, s.kind, s.value, s.metadata_json, s.observed_at,
              (SELECT newer.id FROM outcome_signals newer WHERE newer.supersedes_signal_id = s.id) AS superseded_by
       FROM outcome_signals s
       JOIN tasks t ON t.id = s.task_id
       WHERE t.project_id = ?
       ORDER BY s.rowid`,
    )
    .all(projectId);

  const signalsByTask = new Map<string, SignalRow[]>();
  for (const row of signalRows) {
    const list = signalsByTask.get(row.task_id);
    if (list !== undefined) {
      list.push(row);
    } else {
      signalsByTask.set(row.task_id, [row]);
    }
  }

  const classified: ClassifiedTask[] = [];
  for (const taskRow of taskRows) {
    const signals = signalsByTask.get(taskRow.task_id) ?? [];
    const verificationCategories = new Set<ToolOutcomeCategory>();
    let hasExplicitAcceptance = false;
    let latestPositiveObservedAt: string | null = null;
    let hasNegativeEvidence = false;

    for (const signal of signals) {
      if (signal.superseded_by !== null) {
        continue;
      }
      if (signal.value <= 0) {
        hasNegativeEvidence = true;
        continue;
      }
      if (signal.kind === "tool-outcome") {
        const category = (JSON.parse(signal.metadata_json) as { category?: unknown }).category;
        if (VERIFICATION_CATEGORIES.includes(category as ToolOutcomeCategory)) {
          verificationCategories.add(category as ToolOutcomeCategory);
        }
      } else if (signal.kind === "explicit-feedback") {
        const feedbackKind = (JSON.parse(signal.metadata_json) as { feedbackKind?: unknown }).feedbackKind;
        if (feedbackKind === "acceptance") {
          hasExplicitAcceptance = true;
        }
      }
      if (latestPositiveObservedAt === null || signal.observed_at > latestPositiveObservedAt) {
        latestPositiveObservedAt = signal.observed_at;
      }
    }

    // Silence is never success: a task with no positive evidence, or with any
    // effective negative evidence, contributes nothing to a proposal.
    if (hasNegativeEvidence || latestPositiveObservedAt === null) {
      continue;
    }

    classified.push({
      taskId: taskRow.task_id,
      verifiedCategories: [...verificationCategories].sort(),
      hasExplicitAcceptance,
      latestPositiveObservedAt,
      profile: parseTaskProfile(taskRow),
    });
  }

  return classified;
}

function buildAutomaticDraft(
  triggerKind: LessonProposalTriggerKind,
  evidence: ReadonlyArray<QualifyingTaskEvidence>,
  generatedAt: string,
): LessonCandidateDraft {
  const activities = [...new Set(evidence.map((task) => task.profile?.activity).filter((a): a is string => a !== null))];
  const activityLabel = activities.length === 1 ? activities[0] : "mixed activity";
  const verificationCategories = [...new Set(evidence.flatMap((task) => task.verifiedCategories))].sort();

  const taskLines = evidence.map((task) => {
    const parts = [
      task.verifiedCategories.length > 0 ? `verified ${task.verifiedCategories.join(", ")} success` : null,
      task.hasExplicitAcceptance ? "explicit user acceptance" : null,
      task.profile !== null && task.profile.summary.length > 0 ? `summary: ${task.profile.summary}` : null,
    ].filter((part): part is string => part !== null);
    return `- Task ${task.taskId}: ${parts.length > 0 ? parts.join("; ") : "positive evidence recorded"}`;
  });

  const title = `Verified method for ${activityLabel}`;
  const body = [
    "Proposed automatically from recorded execution evidence; requires human review before activation.",
    "",
    ...taskLines,
  ].join("\n");

  const rationale = triggerKind === "strong-signal"
    ? `Explicit user acceptance recorded on ${evidence.length} completed task(s) with no effective negative evidence.`
    : `${evidence.length} completed tasks show verified success with no effective negative evidence.`;

  const profileWithApplicability = evidence.find((task) => task.profile !== null)?.profile ?? null;

  return {
    title,
    body,
    rationale,
    applicability: profileWithApplicability === null
      ? {}
      : {
          activity: profileWithApplicability.activity,
          domain: profileWithApplicability.domain,
          complexity: profileWithApplicability.complexity,
          stack: profileWithApplicability.stack,
        },
    provenance: {
      trigger: LESSON_PROPOSAL_TRIGGER_CONSTANTS.automaticProvenanceTrigger,
      triggerKind,
      generatedAt,
      evidenceTaskIds: evidence.map((task) => task.taskId),
      verificationCategories,
    },
  };
}

/**
 * Evaluate recorded evidence for one project and, when it justifies it,
 * create a pending successful-method lesson candidate. Two trigger kinds:
 * `strong-signal` (explicit user acceptance on a completed, un-cited task)
 * and `repeated-success` (at least `minVerifiedSuccesses` completed tasks
 * each carrying a verified tool success). Tasks with no positive signals
 * never count — silence is not success — and any effective negative signal
 * (failed verification, correction, rework, correction-lesson link)
 * disqualifies its task. The candidate always stays pending: activation
 * remains a human decision.
 */
export async function evaluateAutomaticLessonProposal(
  connection: SqliteConnection,
  input: EvaluateLessonProposalTriggerInput,
): Promise<LessonProposalTriggerResult> {
  const projectId = requireNonEmptyString(input.projectId, "projectId");
  const minVerifiedSuccesses = resolveMinVerifiedSuccesses(input.minVerifiedSuccesses);
  if (input.since !== undefined) {
    requireNonEmptyString(input.since, "since");
  }
  const now = input.now ?? new Date();

  const citedTaskIds = collectCitedAutomaticTaskIds(connection, projectId);
  const classified = classifyTasks(connection, projectId, input.since);
  const qualifying = classified.filter((task) => !citedTaskIds.has(task.taskId));
  const strongSignalTasks = qualifying.filter((task) => task.hasExplicitAcceptance);
  const repeatedSuccessTasks = qualifying.filter((task) => task.verifiedCategories.length > 0);
  const noTriggerBase = {
    status: "no-trigger" as const,
    qualifyingTaskCount: qualifying.length,
    strongSignalTaskCount: strongSignalTasks.length,
  };

  const hasPendingAutomaticCandidate = connection.database
    .query<{ draft_json: string }, [string, string]>(
      "SELECT draft_json FROM pending_lesson_candidates WHERE project_id = ? AND expires_at > ?",
    )
    .all(projectId, now.toISOString())
    .some((row) => {
      try {
        const stored = JSON.parse(row.draft_json) as { draft?: { provenance?: { trigger?: unknown } } };
        return stored.draft?.provenance?.trigger === LESSON_PROPOSAL_TRIGGER_CONSTANTS.automaticProvenanceTrigger;
      } catch {
        return false;
      }
    });
  if (hasPendingAutomaticCandidate) {
    return { ...noTriggerBase, reason: "pending-automatic-candidate" };
  }

  if (qualifying.length === 0) {
    return { ...noTriggerBase, reason: "no-qualifying-tasks" };
  }

  if (strongSignalTasks.length === 0 && repeatedSuccessTasks.length < minVerifiedSuccesses) {
    return { ...noTriggerBase, reason: "below-repeated-success-threshold" };
  }

  const triggerKind: LessonProposalTriggerKind =
    strongSignalTasks.length > 0 ? "strong-signal" : "repeated-success";
  const evidence = triggerKind === "strong-signal" ? strongSignalTasks : repeatedSuccessTasks;

  const draft = buildAutomaticDraft(triggerKind, evidence, now.toISOString());
  const secretScan = await scanTextForSecrets(`${draft.title}\n${draft.body}`);
  if (secretScan.disposition === "blocked") {
    return {
      status: "blocked",
      reason: "High-confidence secret findings in generated evidence prevent this proposal.",
      triggerKind,
      evidence,
    };
  }

  const candidate = proposeLessonCandidate(connection, {
    projectId,
    scope: "project",
    draft,
    secretScan,
    now,
    ...(input.reviewWindowDays !== undefined ? { reviewWindowDays: input.reviewWindowDays } : {}),
  });

  return { status: "triggered", triggerKind, candidate, evidence };
}
