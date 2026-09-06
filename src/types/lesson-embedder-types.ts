/**
 * Structural subset of the Transformers.js module surface the local embedder
 * relies on. Kept structural (instead of importing the real types) because the
 * runtime is an optional peer dependency that may not be installed.
 */
import type { PinnedEmbeddingArtifact } from "./embedding-artifact-types.js";

export type TransformersEnv = {
  allowRemoteModels?: boolean;
  localModelPath?: string;
};

export type FeatureExtractionOutput = Readonly<{
  data: ArrayLike<number>;
}>;

export type FeatureExtractionPipeline = (
  text: string,
  options: Readonly<{ pooling: "mean"; normalize: true }>,
) => Promise<FeatureExtractionOutput>;

export type TransformersModule = {
  env: TransformersEnv;
  pipeline: (
    task: "feature-extraction",
    model: string,
    options?: Readonly<{ progress_callback?: () => void }>,
  ) => Promise<FeatureExtractionPipeline>;
};

export type LoadTransformersFn = () => Promise<TransformersModule>;

export type LessonEmbedderErrorCode =
  | "artifacts-not-verified"
  | "runtime-unavailable"
  | "invalid-input"
  | "invalid-output";

export type CreateLocalLessonEmbedderInput = Readonly<{
  /** Directory holding the pinned, checksum-verified embedding artifacts. */
  artifactDirectory: string;
  /** Overrides the pinned artifact list; defaults to the pinned manifest. */
  artifacts?: ReadonlyArray<PinnedEmbeddingArtifact>;
  /** Overrides how the Transformers.js runtime is loaded; injectable for tests. */
  loadTransformers?: LoadTransformersFn;
}>;