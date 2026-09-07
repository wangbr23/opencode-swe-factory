import { basename, dirname } from "node:path";

import { verifyEmbeddingArtifacts } from "./embedding-artifacts.js";
import { PINNED_EMBEDDING_DTYPE } from "./embedding-artifact-manifest.js";
import { EMBEDDING_VECTOR_DIMENSIONS } from "../types/embedding-types.js";
import type { EmbedLessonTextFn } from "../types/lesson-embedding-index-types.js";
import type {
  CreateLocalLessonEmbedderInput,
  FeatureExtractionOutput,
  LessonEmbedderErrorCode,
  LoadTransformersFn,
  TransformersModule,
} from "../types/lesson-embedder-types.js";

export type {
  CreateLocalLessonEmbedderInput,
  FeatureExtractionOutput,
  FeatureExtractionPipeline,
  LessonEmbedderErrorCode,
  LoadTransformersFn,
  TransformersEnv,
  TransformersModule,
} from "../types/lesson-embedder-types.js";

export class LessonEmbedderError extends Error {
  readonly code: LessonEmbedderErrorCode;

  constructor(code: LessonEmbedderErrorCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "LessonEmbedderError";
    this.code = code;
  }
}

// The specifier is kept in a variable so the import stays dynamic: TypeScript
// cannot resolve the optional peer dependency's types at compile time.
const TRANSFORMERS_IMPORT_SPECIFIER = "@huggingface/transformers";

function isTransformersModule(value: unknown): value is TransformersModule {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<TransformersModule>;
  return (
    typeof candidate.env === "object" &&
    candidate.env !== null &&
    typeof candidate.pipeline === "function"
  );
}

async function defaultLoadTransformers(): Promise<TransformersModule> {
  return (await import(TRANSFORMERS_IMPORT_SPECIFIER)) as TransformersModule;
}

async function loadTransformersModule(load: LoadTransformersFn): Promise<TransformersModule> {
  let loaded: TransformersModule;
  try {
    loaded = await load();
  } catch (cause) {
    throw new LessonEmbedderError(
      "runtime-unavailable",
      "The @huggingface/transformers runtime is not installed. Install the optional peer dependency to enable local semantic retrieval.",
      { cause },
    );
  }
  if (!isTransformersModule(loaded)) {
    throw new LessonEmbedderError(
      "runtime-unavailable",
      "The @huggingface/transformers runtime does not expose the expected module shape.",
    );
  }
  return loaded;
}

function requireEmbeddableText(text: unknown): string {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new LessonEmbedderError("invalid-input", "Text to embed must be a non-empty string.");
  }
  return text;
}

function extractVector(output: FeatureExtractionOutput): Float32Array {
  const data = output?.data;
  if (data === undefined || typeof data.length !== "number") {
    throw new LessonEmbedderError("invalid-output", "Embedding output has no vector data.");
  }
  const vector = Float32Array.from(data);
  if (vector.length !== EMBEDDING_VECTOR_DIMENSIONS) {
    throw new LessonEmbedderError(
      "invalid-output",
      `Embedding output has ${vector.length} dimensions; expected ${EMBEDDING_VECTOR_DIMENSIONS}.`,
    );
  }
  for (const component of vector) {
    if (!Number.isFinite(component)) {
      throw new LessonEmbedderError("invalid-output", "Embedding output contains a non-finite component.");
    }
  }
  return vector;
}

/**
 * Creates a local embedder over the pinned MiniLM artifacts. Artifacts are
 * verified by checksum before the runtime loads anything, remote model loading
 * is disabled so normal operation never touches the network, and the model is
 * read from the artifact directory itself (Transformers.js expects
 * `<localModelPath>/<model-name>/`, so the artifact directory's parent and its
 * basename provide that layout).
 */
export async function createLocalLessonEmbedder(
  input: CreateLocalLessonEmbedderInput,
): Promise<EmbedLessonTextFn> {
  const artifactDirectory = input.artifactDirectory;
  if (typeof artifactDirectory !== "string" || artifactDirectory.trim().length === 0) {
    throw new LessonEmbedderError("invalid-input", "artifactDirectory must be a non-empty string.");
  }
  const modelName = basename(artifactDirectory);
  if (modelName.length === 0) {
    throw new LessonEmbedderError(
      "invalid-input",
      "artifactDirectory must not be a filesystem root so it can serve as the local model directory name.",
    );
  }

  const verification = verifyEmbeddingArtifacts(
    input.artifacts === undefined
      ? { artifactDirectory }
      : { artifactDirectory, artifacts: input.artifacts },
  );
  if (verification.state !== "verified") {
    throw new LessonEmbedderError(
      "artifacts-not-verified",
      `Embedding artifacts in ${artifactDirectory} are not verified (state: ${verification.state}). Install them before enabling semantic retrieval.`,
    );
  }

  const loadTransformers: LoadTransformersFn = input.loadTransformers ?? defaultLoadTransformers;
  const transformers = await loadTransformersModule(loadTransformers);
  transformers.env.allowLocalModels = true;
  transformers.env.allowRemoteModels = false;
  transformers.env.localModelPath = dirname(artifactDirectory);

  const extract = await transformers.pipeline("feature-extraction", modelName, {
    dtype: PINNED_EMBEDDING_DTYPE,
  });

  return async (text: string): Promise<Float32Array> => {
    const embeddableText = requireEmbeddableText(text);
    const output = await extract(embeddableText, { pooling: "mean", normalize: true });
    return extractVector(output);
  };
}
