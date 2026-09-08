import { EMBEDDING_VECTOR_DIMENSIONS } from "../../types/embedding-types.js";

export const LESSON_EMBEDDING_TEXT_SEPARATOR = "\n\n";

export const LESSON_EMBEDDING_VECTOR_DIMENSIONS = EMBEDDING_VECTOR_DIMENSIONS;

/**
 * Upper bound on lesson versions embedded per indexing run. Confirmed-lesson
 * corpora are small (human-approved), so this is a safety valve against
 * runaway embedding work, not a throughput tuning knob.
 */
export const MAX_LESSON_EMBEDDING_BATCH = 512;
