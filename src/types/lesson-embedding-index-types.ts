export type EmbedLessonTextFn = (text: string) => Promise<Float32Array>;

export type LessonEmbeddingFailure = Readonly<{
  lessonId: string;
  lessonVersion: number;
  message: string;
}>;

export type LessonEmbeddingIndexResult = Readonly<{
  model: string;
  revision: string;
  /** Active confirmed versions embedded during this run. */
  embeddedCount: number;
  /** Active confirmed versions that already had a current (model, revision) vector. */
  skippedCount: number;
  /** Stale-revision and non-active-version vector rows removed during this run. */
  prunedCount: number;
  /** Active confirmed versions that still lack a current vector after this run. */
  remainingCount: number;
  failures: ReadonlyArray<LessonEmbeddingFailure>;
}>;

export type ScheduledLessonEmbeddingIndexResult =
  | Readonly<{ outcome: "indexed"; result: LessonEmbeddingIndexResult }>
  | Readonly<{ outcome: "failed"; message: string }>;

export type IndexConfirmedLessonEmbeddingsInput = Readonly<{
  embed: EmbedLessonTextFn;
  /** Defaults to the pinned embedding model id. */
  model?: string;
  /** Defaults to the pinned embedding model revision. */
  revision?: string;
  now?: Date;
}>;

export type LessonEmbeddingIndexer = Readonly<{
  /**
   * Runs indexing immediately, serialized with any in-flight run.
   * Errors propagate to the caller.
   */
  run(): Promise<LessonEmbeddingIndexResult>;
  /**
   * Runs indexing in the background without blocking the caller and never
   * rejects: failures are reported through the returned outcome.
   */
  schedule(): Promise<ScheduledLessonEmbeddingIndexResult>;
}>;
