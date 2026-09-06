import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EmbeddingArtifactError,
  PINNED_EMBEDDING_ARTIFACTS,
  PINNED_EMBEDDING_ARTIFACT_BASE_URL,
  installEmbeddingArtifacts,
  resolveEmbeddingArtifactDirectory,
  verifyEmbeddingArtifacts,
  type DownloadEmbeddingArtifactFn,
  type PinnedEmbeddingArtifact,
} from "../src/core/index.js";

async function withTempArtifactDirectory(run: (artifactDirectory: string) => Promise<void> | void): Promise<void> {
  const parent = mkdtempSync(join(tmpdir(), "opencode-swe-factory-embedding-artifacts-"));
  const artifactDirectory = join(parent, "artifacts");
  mkdirSync(artifactDirectory);
  try {
    await run(artifactDirectory);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

function fakeManifest(): ReadonlyArray<PinnedEmbeddingArtifact> {
  return [
    { path: "config.json", sha256: sha256Of("config") },
    { path: "onnx/model.onnx", sha256: sha256Of("model") },
    { path: "tokenizer.json", sha256: sha256Of("tokenizer") },
  ];
}

function fakeContents(): Map<string, Uint8Array> {
  return new Map([
    ["config.json", encode("config")],
    ["onnx/model.onnx", encode("model")],
    ["tokenizer.json", encode("tokenizer")],
  ]);
}

function sha256Of(label: string): string {
  return createHash("sha256").update(encode(label)).digest("hex");
}

function encode(label: string): Uint8Array {
  return new TextEncoder().encode(`${label}-bytes`);
}

function fakeDownloader(
  contents: Map<string, Uint8Array>,
  requestedUrls: string[] = [],
): DownloadEmbeddingArtifactFn {
  return async (url: string) => {
    requestedUrls.push(url);
    const withoutBase = url.slice(url.indexOf("/resolve/") + "/resolve/".length);
    const path = withoutBase.slice(withoutBase.indexOf("/") + 1);
    const content = contents.get(path);
    if (content === undefined) {
      throw new Error(`unexpected artifact request: ${url}`);
    }
    return content;
  };
}

test("verify reports not-installed with every pinned file missing on an empty directory", () => {
  withTempArtifactDirectory((artifactDirectory) => {
    const result = verifyEmbeddingArtifacts({ artifactDirectory, artifacts: fakeManifest() });
    expect(result.state).toBe("not-installed");
    expect(result.files).toHaveLength(3);
    for (const file of result.files) {
      expect(file.state).toBe("missing");
    }
  });
});

test("verify reports verified when every pinned file matches its checksum", () => {
  withTempArtifactDirectory(async (artifactDirectory) => {
    await installEmbeddingArtifacts({
      artifactDirectory,
      allowRemoteDownloads: true,
      artifacts: fakeManifest(),
      downloadFile: fakeDownloader(fakeContents()),
    });
    const result = verifyEmbeddingArtifacts({ artifactDirectory, artifacts: fakeManifest() });
    expect(result.state).toBe("verified");
    for (const file of result.files) {
      expect(file.state).toBe("verified");
    }
  });
});

test("verify reports incomplete when some pinned files are missing", () => {
  withTempArtifactDirectory((artifactDirectory) => {
    writeFileSync(join(artifactDirectory, "config.json"), encode("config"));
    const result = verifyEmbeddingArtifacts({ artifactDirectory, artifacts: fakeManifest() });
    expect(result.state).toBe("incomplete");
    const byPath = new Map(result.files.map((file) => [file.path, file.state]));
    expect(byPath.get("config.json")).toBe("verified");
    expect(byPath.get("onnx/model.onnx")).toBe("missing");
    expect(byPath.get("tokenizer.json")).toBe("missing");
  });
});

test("verify reports corrupt and flags files whose content does not match the pin", () => {
  withTempArtifactDirectory((artifactDirectory) => {
    writeFileSync(join(artifactDirectory, "config.json"), encode("tampered"));
    writeFileSync(join(artifactDirectory, "tokenizer.json"), encode("tokenizer"));
    const result = verifyEmbeddingArtifacts({ artifactDirectory, artifacts: fakeManifest() });
    expect(result.state).toBe("corrupt");
    const byPath = new Map(result.files.map((file) => [file.path, file.state]));
    expect(byPath.get("config.json")).toBe("corrupt");
    expect(byPath.get("tokenizer.json")).toBe("verified");
    expect(byPath.get("onnx/model.onnx")).toBe("missing");
  });
});

test("verify refuses symbolic link artifacts", () => {
  withTempArtifactDirectory((artifactDirectory) => {
    const outside = join(artifactDirectory, "..", "outside-target");
    writeFileSync(outside, encode("config"));
    symlinkSync(outside, join(artifactDirectory, "config.json"));
    expect(() => verifyEmbeddingArtifacts({ artifactDirectory, artifacts: fakeManifest() })).toThrow(
      EmbeddingArtifactError,
    );
  });
});

test("resolve uses the cache directory by default and the config override when set", () => {
  expect(
    resolveEmbeddingArtifactDirectory({ cacheDirectory: "/cache", configArtifactDirectory: null }),
  ).toBe(join("/cache", "embeddings"));
  expect(
    resolveEmbeddingArtifactDirectory({ cacheDirectory: "/cache", configArtifactDirectory: "/custom/artifacts" }),
  ).toBe("/custom/artifacts");
});

test("install refuses to download in private mode", async () => {
  await withTempArtifactDirectory(async (artifactDirectory) => {
    let downloaderCalled = false;
    const downloadFile: DownloadEmbeddingArtifactFn = async () => {
      downloaderCalled = true;
      return encode("config");
    };
    expect(
      installEmbeddingArtifacts({
        artifactDirectory,
        allowRemoteDownloads: true,
        privateModeEnabled: true,
        artifacts: fakeManifest(),
        downloadFile,
      }),
    ).rejects.toThrow(EmbeddingArtifactError);
    expect(downloaderCalled).toBe(false);
  });
});

test("install refuses when remote downloads are disabled by configuration", async () => {
  await withTempArtifactDirectory(async (artifactDirectory) => {
    let downloaderCalled = false;
    const downloadFile: DownloadEmbeddingArtifactFn = async () => {
      downloaderCalled = true;
      return encode("config");
    };
    expect(
      installEmbeddingArtifacts({
        artifactDirectory,
        allowRemoteDownloads: false,
        artifacts: fakeManifest(),
        downloadFile,
      }),
    ).rejects.toThrow(/allowRemoteDownloads/);
    expect(downloaderCalled).toBe(false);
  });
});

test("install downloads missing artifacts with pinned URLs, owner-only permissions, and a verified result", async () => {
  await withTempArtifactDirectory(async (artifactDirectory) => {
    const requestedUrls: string[] = [];
    const result = await installEmbeddingArtifacts({
      artifactDirectory,
      allowRemoteDownloads: true,
      artifacts: fakeManifest(),
      downloadFile: fakeDownloader(fakeContents(), requestedUrls),
    });

    expect(result.verification.state).toBe("verified");
    expect(result.downloadedFiles).toHaveLength(3);
    expect(result.skippedFiles).toHaveLength(0);
    expect(requestedUrls).toHaveLength(3);

    const model = lstatSync(join(artifactDirectory, "onnx", "model.onnx"));
    expect(model.isFile()).toBe(true);
    expect(model.mode & 0o777).toBe(0o600);
    const onnxDirectory = lstatSync(join(artifactDirectory, "onnx"));
    expect(onnxDirectory.mode & 0o777).toBe(0o700);

    const leftovers = readdirSync(artifactDirectory).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toHaveLength(0);
  });
});

test("install downloads only from the pinned model revision base URL", async () => {
  await withTempArtifactDirectory(async (artifactDirectory) => {
    const requestedUrls: string[] = [];
    await installEmbeddingArtifacts({
      artifactDirectory,
      allowRemoteDownloads: true,
      artifacts: fakeManifest(),
      downloadFile: fakeDownloader(fakeContents(), requestedUrls),
    });
    expect(requestedUrls.every((url) => url.startsWith(PINNED_EMBEDDING_ARTIFACT_BASE_URL))).toBe(true);
  });
});

test("install skips already-verified artifacts and repairs corrupt ones", async () => {
  await withTempArtifactDirectory(async (artifactDirectory) => {
    writeFileSync(join(artifactDirectory, "config.json"), encode("config"));
    writeFileSync(join(artifactDirectory, "tokenizer.json"), encode("tampered"));

    const requestedUrls: string[] = [];
    const result = await installEmbeddingArtifacts({
      artifactDirectory,
      allowRemoteDownloads: true,
      artifacts: fakeManifest(),
      downloadFile: fakeDownloader(fakeContents(), requestedUrls),
    });

    expect(result.verification.state).toBe("verified");
    expect(result.skippedFiles).toEqual(["config.json"]);
    expect(result.downloadedFiles.slice().sort()).toEqual(["onnx/model.onnx", "tokenizer.json"]);
    expect(verifyEmbeddingArtifacts({ artifactDirectory, artifacts: fakeManifest() }).state).toBe("verified");
  });
});

test("install aborts without writing anything when a download fails the pinned checksum", async () => {
  await withTempArtifactDirectory(async (artifactDirectory) => {
    const contents = fakeContents();
    contents.set("tokenizer.json", encode("malicious"));
    const requestedUrls: string[] = [];

    let failure: unknown = null;
    try {
      await installEmbeddingArtifacts({
        artifactDirectory,
        allowRemoteDownloads: true,
        artifacts: fakeManifest(),
        downloadFile: fakeDownloader(contents, requestedUrls),
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(EmbeddingArtifactError);
    expect((failure as EmbeddingArtifactError).code).toBe("checksum-mismatch");
    expect(requestedUrls).toHaveLength(3);
    expect(existsSync(join(artifactDirectory, "tokenizer.json"))).toBe(false);
    const leftovers = readdirSync(artifactDirectory, { recursive: true }).filter((name) =>
      String(name).endsWith(".tmp"),
    );
    expect(leftovers).toHaveLength(0);
  });
});

test("install is resumable after a checksum failure", async () => {
  await withTempArtifactDirectory(async (artifactDirectory) => {
    const contents = fakeContents();
    contents.set("tokenizer.json", encode("malicious"));
    const firstAttempt = installEmbeddingArtifacts({
      artifactDirectory,
      allowRemoteDownloads: true,
      artifacts: fakeManifest(),
      downloadFile: fakeDownloader(contents),
    });
    await expect(firstAttempt).rejects.toThrow(EmbeddingArtifactError);

    const result = await installEmbeddingArtifacts({
      artifactDirectory,
      allowRemoteDownloads: true,
      artifacts: fakeManifest(),
      downloadFile: fakeDownloader(fakeContents()),
    });
    expect(result.verification.state).toBe("verified");
    expect(result.skippedFiles).toEqual(["config.json", "onnx/model.onnx"]);
    expect(result.downloadedFiles).toEqual(["tokenizer.json"]);
  });
});

test("the pinned manifest covers the quantized model with well-formed checksums", () => {
  expect(PINNED_EMBEDDING_ARTIFACTS.length).toBeGreaterThan(0);
  const paths = PINNED_EMBEDDING_ARTIFACTS.map((artifact) => artifact.path);
  expect(paths).toContain("onnx/model_quantized.onnx");
  expect(paths).toContain("config.json");
  expect(paths).toContain("tokenizer.json");
  for (const artifact of PINNED_EMBEDDING_ARTIFACTS) {
    expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
  }
  expect(PINNED_EMBEDDING_ARTIFACT_BASE_URL).toContain("huggingface.co");
  expect(PINNED_EMBEDDING_ARTIFACT_BASE_URL).toContain("all-MiniLM-L6-v2");
});
