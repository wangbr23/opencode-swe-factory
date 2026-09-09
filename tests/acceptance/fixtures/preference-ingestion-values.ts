export const PREFERENCE_INGESTION_PROJECT_PATH = "/repos/preference-ingestion-acceptance";

export const CREDENTIAL = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";

export const PREFERENCE_LESSON = Object.freeze({
  title: "Explain things simply",
  body: "Use simple explanations by default and add detail only when the user asks for more.",
  rationale: "The user stated a lasting interaction preference.",
});

/** Same content as PREFERENCE_LESSON; models the Edit path proposing a replacement at project scope. */
export const REPLACED_PREFERENCE = Object.freeze({
  title: "Explain things simply",
  body: "Use simple explanations by default and add detail only when the user asks for more.",
  rationale: "Replacement for the same preference at the corrected project scope.",
});

/** Near-identical body drives the overlap detection above the 0.15 jaccard threshold. */
export const NEAR_DUPLICATE_PREFERENCE = Object.freeze({
  title: "Default to simple explanations",
  body: "Use simple explanations by default and add detail only when the user asks for more detail.",
  rationale: "The user restated the interaction preference.",
});

export const BLOCKED_PREFERENCE = Object.freeze({
  title: "Store the deploy token",
  body: `Configure the deploy token as token = ${CREDENTIAL} for releases.`,
  rationale: "The user pasted a credential while stating a release preference.",
});
