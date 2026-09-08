import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LESSON_PROPOSAL_PROTOCOL } from "./context-injection.js";

export type ProtocolDocInstallResult = Readonly<
  | { status: "created" | "updated" | "current"; filePath: string }
  | { status: "failed"; filePath: string; error: string }
>;

const DOC_FILE_NAME = "AGENTS.md";
const BLOCK_MARKER = "opencode-swe-factory:lesson-capture-protocol@1";
const BLOCK_START = `<!-- ${BLOCK_MARKER} start -->`;
const BLOCK_END = `<!-- ${BLOCK_MARKER} end -->`;

function renderManagedBlock(): string {
  return `${BLOCK_START}\n${LESSON_PROPOSAL_PROTOCOL}\n${BLOCK_END}`;
}

/**
 * Installs the lesson-capture protocol into the host project's AGENTS.md as a
 * version-marked managed block: created when the file is missing, appended to
 * an existing file, and replaced in place when the protocol text changes.
 * Content outside the markers is never modified, so the install is idempotent.
 */
export function installLessonProtocolDoc(input: {
  projectDirectory: string;
}): ProtocolDocInstallResult {
  const filePath = join(input.projectDirectory, DOC_FILE_NAME);
  try {
    let existing: string | null = null;
    try {
      existing = readFileSync(filePath, "utf8");
    } catch {
      existing = null;
    }

    if (existing === null) {
      writeFileSync(filePath, `${renderManagedBlock()}\n`);
      return { status: "created", filePath };
    }

    const startIndex = existing.indexOf(BLOCK_START);
    const endIndex = existing.indexOf(BLOCK_END);
    if (startIndex !== -1 || endIndex !== -1) {
      if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
        return {
          status: "failed",
          filePath,
          error: "AGENTS.md has a partial lesson-capture-protocol marker; fix or remove it manually.",
        };
      }
      const before = existing.slice(0, startIndex);
      const after = existing.slice(endIndex + BLOCK_END.length);
      const next = `${before}${renderManagedBlock()}${after}`;
      if (next === existing) {
        return { status: "current", filePath };
      }
      writeFileSync(filePath, next);
      return { status: "updated", filePath };
    }

    const separator = existing.endsWith("\n") ? "" : "\n";
    writeFileSync(filePath, `${existing}${separator}\n${renderManagedBlock()}\n`);
    return { status: "updated", filePath };
  } catch (error) {
    return {
      status: "failed",
      filePath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
