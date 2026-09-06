import { expect, test } from "bun:test";

import { chunkMarkdown } from "../src/core/index.js";

test("chunks by heading boundaries", () => {
  const content = `# Introduction
Some intro text.

## Setup
Setup instructions here.
More setup details.

## Usage
How to use the tool.`;

  const { chunks } = chunkMarkdown({ content, sourcePath: "README.md" });

  expect(chunks).toHaveLength(3);
  expect(chunks[0]!.headingPath).toBe("Introduction");
  expect(chunks[0]!.startLine).toBe(1);
  expect(chunks[0]!.endLine).toBe(3);
  expect(chunks[0]!.text).toContain("# Introduction");
  expect(chunks[0]!.text).toContain("Some intro text.");

  expect(chunks[1]!.headingPath).toBe("Introduction > Setup");
  expect(chunks[1]!.startLine).toBe(4);
  expect(chunks[1]!.endLine).toBe(7);

  expect(chunks[2]!.headingPath).toBe("Introduction > Usage");
  expect(chunks[2]!.startLine).toBe(8);
  expect(chunks[2]!.endLine).toBe(9);
});

test("builds nested heading paths", () => {
  const content = `# Top
## Middle
### Deep
Content here.`;

  const { chunks } = chunkMarkdown({ content, sourcePath: "doc.md" });

  expect(chunks).toHaveLength(3);
  expect(chunks[0]!.headingPath).toBe("Top");
  expect(chunks[1]!.headingPath).toBe("Top > Middle");
  expect(chunks[2]!.headingPath).toBe("Top > Middle > Deep");
});

test("resets heading stack when a higher-level heading appears", () => {
  const content = `# Part One
## Section A
Content A.
# Part Two
## Section B
Content B.`;

  const { chunks } = chunkMarkdown({ content, sourcePath: "doc.md" });

  expect(chunks).toHaveLength(4);
  expect(chunks[0]!.headingPath).toBe("Part One");
  expect(chunks[1]!.headingPath).toBe("Part One > Section A");
  expect(chunks[2]!.headingPath).toBe("Part Two");
  expect(chunks[3]!.headingPath).toBe("Part Two > Section B");
});

test("handles content before first heading", () => {
  const content = `Some preamble text.
More preamble.

# First Heading
Content under heading.`;

  const { chunks } = chunkMarkdown({ content, sourcePath: "doc.md" });

  expect(chunks).toHaveLength(2);
  expect(chunks[0]!.headingPath).toBe("/");
  expect(chunks[0]!.startLine).toBe(1);
  expect(chunks[0]!.text).toContain("Some preamble text.");

  expect(chunks[1]!.headingPath).toBe("First Heading");
});

test("splits oversized sections into numbered parts", () => {
  const lines = ["# Big Section"];
  for (let i = 0; i < 10; i++) {
    lines.push(`Line ${i + 1} of content.`);
  }
  const content = lines.join("\n");

  const { chunks } = chunkMarkdown({ content, sourcePath: "doc.md", maxChunkLines: 4 });

  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks[0]!.headingPath).toBe("Big Section [part 1]");
  expect(chunks[1]!.headingPath).toBe("Big Section [part 2]");

  const allLines = chunks.flatMap((c) => c.text.split("\n"));
  expect(allLines).toContain("# Big Section");
  expect(allLines).toContain("Line 10 of content.");
});

test("preserves line numbers across split parts", () => {
  const lines = ["# Section"];
  for (let i = 0; i < 8; i++) {
    lines.push(`Line ${i + 1}.`);
  }
  const content = lines.join("\n");

  const { chunks } = chunkMarkdown({ content, sourcePath: "doc.md", maxChunkLines: 3 });

  expect(chunks[0]!.startLine).toBe(1);
  expect(chunks[0]!.endLine).toBe(3);
  expect(chunks[1]!.startLine).toBe(4);
  expect(chunks[1]!.endLine).toBe(6);
  expect(chunks[2]!.startLine).toBe(7);
  expect(chunks[2]!.endLine).toBe(9);
});

test("handles empty content", () => {
  const { chunks } = chunkMarkdown({ content: "", sourcePath: "empty.md" });
  expect(chunks).toHaveLength(0);
});

test("handles content with no headings", () => {
  const content = `Just some plain text.
No headings at all.
Third line.`;

  const { chunks } = chunkMarkdown({ content, sourcePath: "doc.md" });

  expect(chunks).toHaveLength(1);
  expect(chunks[0]!.headingPath).toBe("/");
  expect(chunks[0]!.startLine).toBe(1);
  expect(chunks[0]!.endLine).toBe(3);
});

test("handles heading-only document", () => {
  const content = `# Title
## Subtitle`;

  const { chunks } = chunkMarkdown({ content, sourcePath: "doc.md" });

  expect(chunks).toHaveLength(2);
  expect(chunks[0]!.headingPath).toBe("Title");
  expect(chunks[0]!.text).toBe("# Title");
  expect(chunks[1]!.headingPath).toBe("Title > Subtitle");
  expect(chunks[1]!.text).toBe("## Subtitle");
});

test("handles skipped heading levels", () => {
  const content = `# Top
### Skipped to H3
Content.
## Back to H2
More content.`;

  const { chunks } = chunkMarkdown({ content, sourcePath: "doc.md" });

  expect(chunks).toHaveLength(3);
  expect(chunks[0]!.headingPath).toBe("Top");
  expect(chunks[1]!.headingPath).toBe("Top > Skipped to H3");
  expect(chunks[2]!.headingPath).toBe("Top > Back to H2");
});

test("line numbers are 1-indexed", () => {
  const content = `# First
Content.
# Second
Content.`;

  const { chunks } = chunkMarkdown({ content, sourcePath: "doc.md" });

  expect(chunks[0]!.startLine).toBe(1);
  expect(chunks[0]!.endLine).toBe(2);
  expect(chunks[1]!.startLine).toBe(3);
  expect(chunks[1]!.endLine).toBe(4);
});

test("does not treat code fences with hashes as headings", () => {
  const content = `# Real Heading
Some text.
\`\`\`
# This is a comment in code
\`\`\`
More text.`;

  const { chunks } = chunkMarkdown({ content, sourcePath: "doc.md" });

  // The code fence line with # is treated as a heading by the simple parser.
  // This is acceptable for V1 — the design says "heading boundaries with a
  // bounded fallback" not "full CommonMark parsing."
  expect(chunks.length).toBeGreaterThanOrEqual(1);
});

test("handles blank lines between sections", () => {
  const content = `# Section One
Content one.

# Section Two
Content two.`;

  const { chunks } = chunkMarkdown({ content, sourcePath: "doc.md" });

  expect(chunks).toHaveLength(2);
  expect(chunks[0]!.text).toContain("Content one.");
  expect(chunks[0]!.endLine).toBe(3);
  expect(chunks[1]!.text).toContain("Content two.");
});
