export type MarkdownChunk = Readonly<{
  headingPath: string;
  startLine: number;
  endLine: number;
  text: string;
}>;

export type ChunkMarkdownInput = Readonly<{
  content: string;
  sourcePath: string;
  maxChunkLines?: number;
}>;

export type ChunkMarkdownResult = Readonly<{
  chunks: ReadonlyArray<MarkdownChunk>;
}>;
