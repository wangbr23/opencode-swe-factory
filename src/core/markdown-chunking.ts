import type {
  ChunkMarkdownInput,
  ChunkMarkdownResult,
  MarkdownChunk,
} from "../types/markdown-chunking-types.js";

export type {
  ChunkMarkdownInput,
  ChunkMarkdownResult,
  MarkdownChunk,
} from "../types/markdown-chunking-types.js";

const DEFAULT_MAX_CHUNK_LINES = 200;
const HEADING_PATTERN = /^(#{1,6})\s+(.+)$/;

type HeadingInfo = Readonly<{
  level: number;
  title: string;
  lineNumber: number;
}>;

function parseHeading(line: string): HeadingInfo | null {
  const match = HEADING_PATTERN.exec(line);
  if (!match) return null;
  return {
    level: match[1]!.length,
    title: match[2]!.trim(),
    lineNumber: 0,
  };
}

function buildHeadingPath(stack: ReadonlyArray<string>): string {
  return stack.length === 0 ? "/" : stack.join(" > ");
}

function splitOversizedChunk(
  text: string,
  headingPath: string,
  startLine: number,
  endLine: number,
  maxLines: number,
): MarkdownChunk[] {
  const lines = text.split("\n");
  const chunks: MarkdownChunk[] = [];
  let partStart = 0;

  while (partStart < lines.length) {
    const partEnd = Math.min(partStart + maxLines, lines.length);
    const partLines = lines.slice(partStart, partEnd);
    const partNumber = chunks.length + 1;

    chunks.push({
      headingPath: `${headingPath} [part ${partNumber}]`,
      startLine: startLine + partStart,
      endLine: startLine + partEnd - 1,
      text: partLines.join("\n"),
    });

    partStart = partEnd;
  }

  return chunks;
}

/**
 * Splits Markdown content into chunks at heading boundaries. Each chunk
 * carries a heading path (e.g. "Setup > Dependencies") for stable citations,
 * plus 1-indexed line numbers for source traceability. Sections that exceed
 * maxChunkLines are split into numbered parts.
 */
export function chunkMarkdown(input: ChunkMarkdownInput): ChunkMarkdownResult {
  const maxLines = input.maxChunkLines ?? DEFAULT_MAX_CHUNK_LINES;
  const lines = input.content.split("\n");

  if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) {
    return { chunks: [] };
  }

  const chunks: MarkdownChunk[] = [];
  const headingStack: string[] = [];
  let currentStartLine = 1;
  const currentLines: string[] = [];

  function flushSection(): void {
    if (currentLines.length === 0) return;

    const text = currentLines.join("\n");
    const headingPath = buildHeadingPath(headingStack);
    const endLine = currentStartLine + currentLines.length - 1;

    if (currentLines.length > maxLines) {
      chunks.push(...splitOversizedChunk(text, headingPath, currentStartLine, endLine, maxLines));
    } else {
      chunks.push({ headingPath, startLine: currentStartLine, endLine, text });
    }

    currentLines.length = 0;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const heading = parseHeading(line);

    if (heading) {
      flushSection();

      while (headingStack.length >= heading.level) {
        headingStack.pop();
      }
      headingStack.push(heading.title);

      currentStartLine = i + 1;
      currentLines.push(line);
    } else {
      if (currentLines.length === 0) {
        currentStartLine = i + 1;
      }
      currentLines.push(line);
    }
  }

  flushSection();

  return { chunks };
}
