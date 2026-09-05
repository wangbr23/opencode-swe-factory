import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  DocumentAdmissionInputError,
  admitCuratedDocumentSources,
  type AdmitCuratedDocumentSourcesInput,
} from "../src/core/index.js";

async function withTempProject(run: (projectRoot: string, parent: string) => Promise<void>): Promise<void> {
  const parent = mkdtempSync(join(tmpdir(), "opencode-swe-factory-document-admission-"));
  const projectRoot = join(parent, "project");
  mkdirSync(projectRoot);
  try {
    await run(projectRoot, parent);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

function admissionInput(
  projectRoot: string,
  curatedPaths: ReadonlyArray<string>,
  overrides: Partial<AdmitCuratedDocumentSourcesInput> = {},
): AdmitCuratedDocumentSourcesInput {
  return {
    projectId: "project-1",
    projectRoot,
    curatedPaths,
    limits: {
      maxFileBytes: 1024,
      maxTotalBytes: 4096,
    },
    ...overrides,
  };
}

test("admits deterministic curated Markdown sources with hashes and source types", async () => {
  await withTempProject(async (projectRoot) => {
    mkdirSync(join(projectRoot, "docs", "designs"), { recursive: true });
    mkdirSync(join(projectRoot, "docs", "specs"), { recursive: true });
    const contents = new Map([
      ["AGENTS.md", "# Project instructions\nUse Bun.\n"],
      ["TODO.md", "# Work\nShip retrieval.\n"],
      ["docs/journal.md", "# Journal\nIndexing started.\n"],
      ["docs/designs/retrieval.md", "# Retrieval design\nUse FTS.\n"],
      ["docs/specs/product.md", "# Product specification\nKeep sources authoritative.\n"],
    ]);
    for (const [relativePath, content] of contents) {
      writeFileSync(join(projectRoot, relativePath), content);
    }
    writeFileSync(join(projectRoot, "docs", "ignored.ts"), "export const ignored = true;\n");

    const result = await admitCuratedDocumentSources(
      admissionInput(projectRoot, ["AGENTS.md", "TODO.md", "docs", "AGENTS.md"]),
    );

    expect(result.admitted.map((source) => [source.relativePath, source.sourceType])).toEqual([
      ["AGENTS.md", "project-instructions"],
      ["TODO.md", "task-state"],
      ["docs/designs/retrieval.md", "design"],
      ["docs/journal.md", "journal"],
      ["docs/specs/product.md", "specification"],
    ]);
    expect(result.skipped.map((source) => [source.reason, source.path.endsWith("ignored.ts")])).toEqual([
      ["duplicate", false],
      ["unsupported-file-type", true],
    ]);
    expect(result.totalBytes).toBe([...contents.values()].reduce((total, content) => total + Buffer.byteLength(content), 0));

    const agents = result.admitted[0]!;
    expect(agents.path).toBe(realpathSync(join(projectRoot, "AGENTS.md")));
    expect(agents.contentHash).toBe(createHash("sha256").update(contents.get("AGENTS.md")!).digest("hex"));
    expect(agents.secretScan).toEqual({ disposition: "clear", findings: [] });
    expect(agents.secretRiskAcknowledged).toBe(false);
  });
});

test("rejects traversal and symlink escapes unless the external path is explicitly approved", async () => {
  await withTempProject(async (projectRoot, parent) => {
    const externalDirectory = join(parent, "external");
    const externalDocument = join(externalDirectory, "guide.md");
    mkdirSync(externalDirectory);
    writeFileSync(externalDocument, "# External guide\nApproved reference.\n");

    const traversal = await admitCuratedDocumentSources(admissionInput(projectRoot, ["../external/guide.md"]));
    expect(traversal.admitted).toEqual([]);
    expect(traversal.skipped).toEqual([
      expect.objectContaining({ reason: "outside-project", path: externalDocument }),
    ]);

    const approved = await admitCuratedDocumentSources(
      admissionInput(projectRoot, ["../external"], { explicitlyApprovedExternalPaths: [externalDirectory] }),
    );
    expect(approved.admitted).toEqual([
      expect.objectContaining({ path: realpathSync(externalDocument), relativePath: null }),
    ]);

    if (process.platform !== "win32") {
      const symlinkPath = join(projectRoot, "escaped.md");
      symlinkSync(externalDocument, symlinkPath);
      const escaped = await admitCuratedDocumentSources(admissionInput(projectRoot, ["escaped.md"]));
      expect(escaped.admitted).toEqual([]);
      expect(escaped.skipped).toEqual([expect.objectContaining({ reason: "outside-project", path: symlinkPath })]);

      const approvedSymlink = await admitCuratedDocumentSources(
        admissionInput(projectRoot, ["escaped.md"], { explicitlyApprovedExternalPaths: [externalDocument] }),
      );
      expect(approvedSymlink.admitted).toEqual([
        expect.objectContaining({ path: realpathSync(externalDocument), relativePath: null }),
      ]);
    }
  });
});

test("enforces per-file and total limits while ignoring binary and unsupported content", async () => {
  await withTempProject(async (projectRoot) => {
    writeFileSync(join(projectRoot, "0-binary.md"), new Uint8Array([65, 0, 66]));
    writeFileSync(join(projectRoot, "a.md"), "aaaa");
    writeFileSync(join(projectRoot, "b.md"), "bbbb");
    writeFileSync(join(projectRoot, "huge.md"), "x".repeat(10));
    writeFileSync(join(projectRoot, "notes.txt"), "plain text");

    const result = await admitCuratedDocumentSources(
      admissionInput(projectRoot, ["."], { limits: { maxFileBytes: 8, maxTotalBytes: 5 } }),
    );

    expect(result.admitted.map((source) => source.relativePath)).toEqual(["a.md"]);
    expect(result.totalBytes).toBe(4);
    expect(result.skipped.map((source) => [basename(source.path), source.reason])).toEqual([
      ["0-binary.md", "binary"],
      ["b.md", "total-size-limit"],
      ["huge.md", "file-too-large"],
      ["notes.txt", "unsupported-file-type"],
    ]);
  });
});

test("blocks high-confidence secrets and requires exact acknowledgment for lower-confidence findings", async () => {
  await withTempProject(async (projectRoot) => {
    const credential = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
    const hash = "a3f5c7e9b1d2f4a6c8e0b2d4f6a8c0e2a4b6d8f0c2e4a6b8d0e2f4a6c8b0d2e4";
    const highPath = join(projectRoot, "high.md");
    const lowPath = join(projectRoot, "low.md");
    writeFileSync(join(projectRoot, "clear.md"), "# Safe guide\nRun the tests.\n");
    writeFileSync(highPath, `token = ${credential}\n`);
    writeFileSync(lowPath, `checksum: ${hash}\n`);

    const blocked = await admitCuratedDocumentSources(admissionInput(projectRoot, ["."]));
    expect(blocked.admitted.map((source) => source.relativePath)).toEqual(["clear.md"]);
    expect(blocked.skipped.map((source) => [basename(source.path), source.reason])).toEqual([
      ["high.md", "secret-blocked"],
      ["low.md", "secret-acknowledgment-required"],
    ]);
    expect(JSON.stringify(blocked.skipped)).not.toContain(credential);
    expect(JSON.stringify(blocked.skipped)).not.toContain(hash);

    const acknowledged = await admitCuratedDocumentSources(
      admissionInput(projectRoot, ["high.md", "low.md"], {
        acknowledgedSecretPaths: [highPath, lowPath],
      }),
    );
    expect(acknowledged.admitted).toEqual([
      expect.objectContaining({ relativePath: "low.md", secretRiskAcknowledged: true }),
    ]);
    expect(acknowledged.skipped).toEqual([
      expect.objectContaining({ path: realpathSync(highPath), reason: "secret-blocked" }),
    ]);
  });
});

test("validates project identity, roots, paths, and explicit limits", async () => {
  await withTempProject(async (projectRoot) => {
    await expect(
      admitCuratedDocumentSources(admissionInput(projectRoot, ["missing.md"])),
    ).resolves.toEqual({
      admitted: [],
      skipped: [expect.objectContaining({ reason: "missing" })],
      totalBytes: 0,
    });
    await expect(
      admitCuratedDocumentSources(admissionInput(projectRoot, [], { projectId: "" })),
    ).rejects.toThrow(DocumentAdmissionInputError);
    await expect(
      admitCuratedDocumentSources(admissionInput("relative/project", [])),
    ).rejects.toThrow(/projectRoot must be absolute/);
    await expect(
      admitCuratedDocumentSources(admissionInput(projectRoot, [], { limits: { maxFileBytes: 0, maxTotalBytes: 10 } })),
    ).rejects.toThrow(/maxFileBytes/);
    await expect(
      admitCuratedDocumentSources(
        admissionInput(projectRoot, [], {
          limits: { maxFileBytes: 10, maxTotalBytes: Number.POSITIVE_INFINITY },
        }),
      ),
    ).rejects.toThrow(/maxTotalBytes/);
  });
});
