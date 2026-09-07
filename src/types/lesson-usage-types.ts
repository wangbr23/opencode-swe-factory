export type LessonRetrievalHit = Readonly<{
  lessonId: string;
  version: number;
}>;

export type RecordLessonRetrievalHitsInput = Readonly<{
  hits: ReadonlyArray<LessonRetrievalHit>;
  now?: Date;
}>;

export type RecordLessonRetrievalHitsResult = Readonly<{
  /** Rows actually written; repeat hits on the same UTC day are deduplicated by the primary key. */
  recordedCount: number;
}>;
