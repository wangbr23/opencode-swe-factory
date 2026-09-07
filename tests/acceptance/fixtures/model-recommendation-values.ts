export const MODEL_RECOMMENDATION_PROJECT_PATH = "/test/project";

export const MODEL_RECOMMENDATION_TASK_MESSAGE =
  "Fix the login bug in the API request handler";

/** Cold-start favorite: only a configured prior speaks for it. */
export const PRIOR_FAVORITE_MODEL = {
  provider: "openai",
  model: "gpt-4.1",
  variant: "default",
} as const;

/** Wins only once recorded execution evidence backs it. */
export const EVIDENCE_WINNER_MODEL = {
  provider: "anthropic",
  model: "claude-sonnet-4",
  variant: "thinking",
} as const;

export const EVIDENCE_TASK_COUNT = 5;
