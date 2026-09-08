import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LESSON_PROPOSAL_PROTOCOL } from "../../src/opencode/context-injection.js";
import {
  installLessonProtocolDoc,
} from "../../src/opencode/protocol-doc.js";

const BLOCK_MARKER = "opencode-swe-factory:lesson-capture-protocol@1";
const BLOCK_START = `<!-- ${BLOCK_MARKER} start -->`;
const BLOCK_END = `<!-- ${BLOCK_MARKER} end -->`;

function withProjectDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "protocol-doc-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("installLessonProtocolDoc creates AGENTS.md when the project has none", () => {
  withProjectDirectory((directory) => {
    const result = installLessonProtocolDoc({ projectDirectory: directory });

    expect(result.status).toBe("created");
    const content = readFileSync(join(directory, "AGENTS.md"), "utf8");
    expect(content).toContain(BLOCK_START);
    expect(content).toContain(LESSON_PROPOSAL_PROTOCOL);
    expect(content).toContain(BLOCK_END);
  });
});

test("installLessonProtocolDoc appends to an existing AGENTS.md without touching other content", () => {
  withProjectDirectory((directory) => {
    const filePath = join(directory, "AGENTS.md");
    writeFileSync(filePath, "# My project\n\nExisting conventions live here.\n");

    const result = installLessonProtocolDoc({ projectDirectory: directory });

    expect(result.status).toBe("updated");
    const content = readFileSync(filePath, "utf8");
    expect(content).toContain("# My project");
    expect(content).toContain("Existing conventions live here.");
    expect(content).toContain(BLOCK_START);
    expect(content.indexOf(BLOCK_START)).toBeGreaterThan(
      content.indexOf("Existing conventions live here."),
    );
  });
});

test("installLessonProtocolDoc is idempotent when the block is already current", () => {
  withProjectDirectory((directory) => {
    installLessonProtocolDoc({ projectDirectory: directory });
    const before = readFileSync(join(directory, "AGENTS.md"), "utf8");

    const result = installLessonProtocolDoc({ projectDirectory: directory });

    expect(result.status).toBe("current");
    expect(readFileSync(join(directory, "AGENTS.md"), "utf8")).toBe(before);
    expect(before.split(BLOCK_START).length - 1).toBe(1);
  });
});

test("installLessonProtocolDoc replaces a drifted block in place", () => {
  withProjectDirectory((directory) => {
    const filePath = join(directory, "AGENTS.md");
    writeFileSync(
      filePath,
      `# My project\n\n${BLOCK_START}\nOutdated protocol text.\n${BLOCK_END}\n\nTail content.\n`,
    );

    const result = installLessonProtocolDoc({ projectDirectory: directory });

    expect(result.status).toBe("updated");
    const content = readFileSync(filePath, "utf8");
    expect(content).not.toContain("Outdated protocol text.");
    expect(content).toContain(LESSON_PROPOSAL_PROTOCOL);
    expect(content).toContain("# My project");
    expect(content).toContain("Tail content.");
    expect(content.split(BLOCK_START).length - 1).toBe(1);
  });
});

test("installLessonProtocolDoc refuses to touch a file with mismatched markers", () => {
  withProjectDirectory((directory) => {
    const filePath = join(directory, "AGENTS.md");
    const broken = `# My project\n\n${BLOCK_START}\nUnfinished block, no end marker.\n`;
    writeFileSync(filePath, broken);

    const result = installLessonProtocolDoc({ projectDirectory: directory });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("partial");
    }
    expect(readFileSync(filePath, "utf8")).toBe(broken);
  });
});

test("installLessonProtocolDoc reports failure for an unwritable target", () => {
  withProjectDirectory((directory) => {
    const result = installLessonProtocolDoc({
      projectDirectory: join(directory, "does-not-exist"),
    });

    expect(result.status).toBe("failed");
    expect(existsSync(join(directory, "AGENTS.md"))).toBe(false);
  });
});
