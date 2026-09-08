import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../src/cli/index.js";
import { PINNED_EMBEDDING_ARTIFACTS } from "../src/core/index.js";

async function withTemporaryDirectory(run: (directory: string) => void | Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-cli-embeddings-"));
  try {
    await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function captureConsole() {
  const logged: string[] = [];
  const errors: string[] = [];
  const log = spyOn(console, "log").mockImplementation((message: string) => {
    logged.push(message);
  });
  const error = spyOn(console, "error").mockImplementation((message: string) => {
    errors.push(message);
  });
  return {
    logged,
    errors,
    restore() {
      log.mockRestore();
      error.mockRestore();
    },
  };
}

function writeEmbeddingsConfig(configFilePath: string, artifactDirectory: string, embeddings?: Record<string, unknown>): void {
  writeFileSync(
    configFilePath,
    JSON.stringify({ embeddings: { artifactDirectory, ...embeddings } }),
  );
}

test("embeddings-status reports not-installed artifacts and not-ready offline state", async () => {
  await withTemporaryDirectory(async (directory) => {
    const artifactDirectory = join(directory, "artifacts");
    const configFilePath = join(directory, "config.json");
    writeEmbeddingsConfig(configFilePath, artifactDirectory);

    const console_ = captureConsole();
    try {
      expect(await main(["embeddings-status", "--config", configFilePath])).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain("Pinned model: Xenova/all-MiniLM-L6-v2");
      expect(output).toContain(`Artifact directory: ${artifactDirectory}`);
      expect(output).toContain("Artifacts: not-installed");
      for (const artifact of PINNED_EMBEDDING_ARTIFACTS) {
        expect(output).toContain(`  ${artifact.path}: missing`);
      }
      expect(output).toContain("Runtime: not installed");
      expect(output).toContain("Offline semantic retrieval: not ready");
      expect(output).toContain("Remote downloads: blocked by embeddings.allowRemoteDownloads");
      expect(output).toContain("Private mode: off");
    } finally {
      console_.restore();
    }
  });
});

test("embeddings-status reports corrupt artifacts when file contents do not match the pin", async () => {
  await withTemporaryDirectory(async (directory) => {
    const artifactDirectory = join(directory, "artifacts");
    for (const artifact of PINNED_EMBEDDING_ARTIFACTS) {
      const artifactPath = join(artifactDirectory, artifact.path);
      mkdirSync(join(artifactPath, ".."), { recursive: true });
      writeFileSync(artifactPath, `not the pinned content for ${artifact.path}`);
    }
    const configFilePath = join(directory, "config.json");
    writeEmbeddingsConfig(configFilePath, artifactDirectory);

    const console_ = captureConsole();
    try {
      expect(await main(["embeddings-status", "--config", configFilePath])).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain("Artifacts: corrupt");
      for (const artifact of PINNED_EMBEDDING_ARTIFACTS) {
        expect(output).toContain(`  ${artifact.path}: corrupt`);
      }
      expect(output).toContain("Offline semantic retrieval: not ready");
    } finally {
      console_.restore();
    }
  });
});

test("embeddings-install refuses in private mode without touching the network", async () => {
  await withTemporaryDirectory(async (directory) => {
    const artifactDirectory = join(directory, "artifacts");
    const configFilePath = join(directory, "config.json");
    writeFileSync(
      configFilePath,
      JSON.stringify({
        privateMode: { enabled: true },
        embeddings: { allowRemoteDownloads: true, artifactDirectory },
      }),
    );

    const console_ = captureConsole();
    try {
      expect(await main(["embeddings-install", "--config", configFilePath])).toBe(1);
      expect(console_.errors.join("\n")).toContain("Private mode never initiates artifact downloads");
      expect(existsSync(artifactDirectory)).toBe(false);
    } finally {
      console_.restore();
    }
  });
});

test("embeddings-install refuses while remote downloads are disabled", async () => {
  await withTemporaryDirectory(async (directory) => {
    const artifactDirectory = join(directory, "artifacts");
    const configFilePath = join(directory, "config.json");
    writeEmbeddingsConfig(configFilePath, artifactDirectory);

    const console_ = captureConsole();
    try {
      expect(await main(["embeddings-install", "--config", configFilePath])).toBe(1);
      expect(console_.errors.join("\n")).toContain("Remote artifact downloads are disabled");
      expect(console_.errors.join("\n")).toContain("embeddings.allowRemoteDownloads");
    } finally {
      console_.restore();
    }
  });
});
