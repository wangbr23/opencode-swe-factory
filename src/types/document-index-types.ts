import type { DocumentSourceType } from "./document-admission-types.js";

export type DocumentIndexScope = "project" | "global";

export type IndexableDocumentSource = Readonly<{
  projectId: string | null;
  scope: DocumentIndexScope;
  path: string;
  sourceType: DocumentSourceType;
  content: string;
  contentHash: string;
}>;

export type IndexDocumentSourcesInput = Readonly<{
  sources: ReadonlyArray<IndexableDocumentSource>;
  maxChunkLines?: number;
  now?: Date;
}>;

export type DocumentIndexResult = Readonly<{
  indexedSourceCount: number;
  indexedChunkCount: number;
  unchangedSourceCount: number;
  removedSourceCount: number;
  removedChunkCount: number;
}>;
