import type { RetrievedLesson } from "../types/retrieved-lesson-types.js";
import {
  DEFAULT_LESSON_TOKEN_BUDGET,
} from "../types/lesson-context-types.js";
import type {
  ExcludedLesson,
  PackedLesson,
  PackLessonContextInput,
  PackLessonContextResult,
  RetrievalReceipt,
} from "../types/lesson-context-types.js";

export {
  DEFAULT_LESSON_TOKEN_BUDGET,
} from "../types/lesson-context-types.js";
export type {
  ExcludedLesson,
  PackedLesson,
  PackLessonContextInput,
  PackLessonContextResult,
  RetrievalReceipt,
} from "../types/lesson-context-types.js";

const CONTEXT_BLOCK_HEADER = "## Confirmed Lessons\n\n";

export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

function formatSingleLesson(lesson: RetrievedLesson): string {
  const scopeTag = lesson.scope === "project" ? "project" : "global";
  return `### ${lesson.title} [${scopeTag}]\n${lesson.body}\n`;
}

export function packLessonContext(input: PackLessonContextInput): PackLessonContextResult {
  const budget = input.tokenBudget ?? DEFAULT_LESSON_TOKEN_BUDGET;
  const estimate = input.estimateTokens ?? estimateTokenCount;

  const excluded: ExcludedLesson[] = input.suppressed.map((s) => ({
    lessonId: s.lessonId,
    reason: "conflict-suppressed" as const,
    conflictsWith: s.conflictsWith,
    bodyOverlap: s.bodyOverlap,
  }));

  const headerTokens = estimate(CONTEXT_BLOCK_HEADER);
  let usedTokens = headerTokens;

  const packed: PackedLesson[] = [];
  const formattedParts: string[] = [];

  for (const lesson of input.kept) {
    const formatted = formatSingleLesson(lesson);
    const tokens = estimate(formatted);

    if (usedTokens + tokens > budget) {
      excluded.push({ lessonId: lesson.lessonId, reason: "budget-exceeded" as const });
      continue;
    }

    packed.push({
      lessonId: lesson.lessonId,
      version: lesson.version,
      scope: lesson.scope,
      title: lesson.title,
      body: lesson.body,
      estimatedTokens: tokens,
    });
    formattedParts.push(formatted);
    usedTokens += tokens;
  }

  const block = packed.length > 0
    ? (CONTEXT_BLOCK_HEADER + formattedParts.join("\n")).trimEnd()
    : "";

  const receipt: RetrievalReceipt = {
    query: input.query,
    retrievedCount: input.kept.length + input.suppressed.length,
    suppressedCount: input.suppressed.length,
    packedCount: packed.length,
    excludedByBudgetCount: excluded.filter((e) => e.reason === "budget-exceeded").length,
    tokenBudget: budget,
    estimatedTokensUsed: packed.length > 0 ? usedTokens : 0,
    semantic: { status: "unavailable", candidateCount: 0 },
  };

  return { block, packed, excluded, receipt };
}
