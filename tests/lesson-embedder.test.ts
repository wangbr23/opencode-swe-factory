import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  LessonEmbedderError,
  createLocalLessonEmbedder,
} from "../src/core/index.js";
import { EMBEDDING_VECTOR_DIMENSIONS } from "../src/types/embedding-types.js";
import { PINNED_EMBEDDING_ARTIFACTS } from "../src/core/embedding-artifact-manifest.js";
import type { PinnedEmbeddingArtifact } from "../src/types/embedding-artifact-types.js";
import type { FeatureExtractionOutput, TransformersModule } from "../src/types/lesson-embedder-types.js";

type EmbedderHarness = Readonly<{
  artifactDirectory: string;
  artifacts: ReadonlyArray<PinnedEmbeddingArtifact>;
  cleanup: () => void;
}>;

function writeVerifiedArtifacts(): EmbedderHarness {
  const artifactDirectory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-lesson-embedder-"));
  const artifacts: PinnedEmbeddingArtifact[] = PINNED_EMBEDDING_ARTIFACTS.map((artifact) => {
    const content = new TextEncoder().encode(`content-for-${artifact.path}`);
    const absolutePath = join(artifactDirectory, artifact.path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content);
    return { path: artifact.path, sha256: createHash("sha256").update(content).digest("hex") };
  });
  return {
    artifactDirectory,
    artifacts,
    cleanup: () => rmSync(artifactDirectory, { recursive: true, force: true }),
  };
}

type FakePipelineCall = Readonly<{ text: string; pooling: "mean"; normalize: true }>;

type FakeRuntime = {
  module: TransformersModule;
  calls: FakePipelineCall[];
  created: ReadonlyArray<Readonly<{ task: string; model: string; dtype: "q8" | undefined }>>;
};

function createFakeRuntime(outputFactory: () => FeatureExtractionOutput): FakeRuntime {
  const calls: FakePipelineCall[] = [];
  const created: Array<Readonly<{ task: string; model: string; dtype: "q8" | undefined }>> = [];
  const module: TransformersModule = {
    env: {},
    pipeline: async (task, model, options) => {
      created.push({ task, model, dtype: options?.dtype });
      return async (text, options) => {
        calls.push({ text, pooling: options.pooling, normalize: options.normalize });
        return outputFactory();
      };
    },
  };
  return { module, calls, created };
}

test("refuses to create an embedder when artifacts are not verified", async () => {
  const harness = writeVerifiedArtifacts();
  try {
    rmSync(join(harness.artifactDirectory, "tokenizer.json"));
    const failure = await createLocalLessonEmbedder({
      artifactDirectory: harness.artifactDirectory,
      artifacts: harness.artifacts,
      loadTransformers: () => Promise.resolve(createFakeRuntime(() => ({ data: new Float32Array(0) })).module),
    }).then(
      () => null,
      (error: LessonEmbedderError) => error,
    );
    expect(failure).toBeInstanceOf(LessonEmbedderError);
    expect(failure?.code).toBe("artifacts-not-verified");
  } finally {
    harness.cleanup();
  }
});

test("refuses to create an embedder when a pinned artifact is corrupt", async () => {
  const harness = writeVerifiedArtifacts();
  try {
    writeFileSync(join(harness.artifactDirectory, "config.json"), "tampered");
    let runtimeUsed = false;
    await expect(
      createLocalLessonEmbedder({
        artifactDirectory: harness.artifactDirectory,
        artifacts: harness.artifacts,
        loadTransformers: () => {
          runtimeUsed = true;
          return Promise.resolve(createFakeRuntime(() => ({ data: new Float32Array(0) })).module);
        },
      }),
    ).rejects.toThrow("not verified");
    expect(runtimeUsed).toBe(false);
  } finally {
    harness.cleanup();
  }
});

test("reports a typed error when the Transformers.js runtime is unavailable", async () => {
  const harness = writeVerifiedArtifacts();
  try {
    const failure = await createLocalLessonEmbedder({
      artifactDirectory: harness.artifactDirectory,
      artifacts: harness.artifacts,
      loadTransformers: () => Promise.reject(new Error("Cannot find module")),
    }).then(
      () => null,
      (error: LessonEmbedderError) => error,
    );
    expect(failure).toBeInstanceOf(LessonEmbedderError);
    expect(failure?.code).toBe("runtime-unavailable");
    expect(failure?.message).toContain("optional peer dependency");
  } finally {
    harness.cleanup();
  }
});

test("loads the pipeline locally with remote model access disabled", async () => {
  const harness = writeVerifiedArtifacts();
  try {
    const runtime = createFakeRuntime(() => ({ data: new Float32Array(EMBEDDING_VECTOR_DIMENSIONS).fill(0.5) }));
    const embed = await createLocalLessonEmbedder({
      artifactDirectory: harness.artifactDirectory,
      artifacts: harness.artifacts,
      loadTransformers: () => Promise.resolve(runtime.module),
    });

    expect(runtime.module.env.allowLocalModels).toBe(true);
    expect(runtime.module.env.allowRemoteModels).toBe(false);
    expect(runtime.module.env.localModelPath).toBe(dirname(harness.artifactDirectory));
    expect(runtime.created).toEqual([{
      task: "feature-extraction",
      model: basename(harness.artifactDirectory),
      dtype: "q8",
    }]);

    const vector = await embed("Prefer the fixture loader over ad-hoc setup.");
    expect(runtime.calls).toHaveLength(1);
    expect(runtime.calls[0]?.text).toBe("Prefer the fixture loader over ad-hoc setup.");
    expect(runtime.calls[0]?.pooling).toBe("mean");
    expect(runtime.calls[0]?.normalize).toBe(true);
    expect(vector).toBeInstanceOf(Float32Array);
    expect(vector.length).toBe(EMBEDDING_VECTOR_DIMENSIONS);
    expect(vector[0]).toBe(0.5);
  } finally {
    harness.cleanup();
  }
});

test("rejects embedding output with wrong dimensions or non-finite components", async () => {
  const harness = writeVerifiedArtifacts();
  try {
    const shortRuntime = createFakeRuntime(() => ({ data: new Float32Array(3) }));
    const shortEmbed = await createLocalLessonEmbedder({
      artifactDirectory: harness.artifactDirectory,
      artifacts: harness.artifacts,
      loadTransformers: () => Promise.resolve(shortRuntime.module),
    });
    await expect(shortEmbed("text")).rejects.toThrow(/dimensions/);

    const nonFiniteRuntime = createFakeRuntime(() => ({
      data: Float32Array.from({ length: EMBEDDING_VECTOR_DIMENSIONS }, (_, index) =>
        index === 7 ? Number.NaN : 0.1,
      ),
    }));
    const nonFiniteEmbed = await createLocalLessonEmbedder({
      artifactDirectory: harness.artifactDirectory,
      artifacts: harness.artifacts,
      loadTransformers: () => Promise.resolve(nonFiniteRuntime.module),
    });
    await expect(nonFiniteEmbed("text")).rejects.toThrow(/non-finite/);
  } finally {
    harness.cleanup();
  }
});

test("rejects empty text and empty artifact directory inputs", async () => {
  const harness = writeVerifiedArtifacts();
  try {
    const runtime = createFakeRuntime(() => ({ data: new Float32Array(EMBEDDING_VECTOR_DIMENSIONS) }));
    const embed = await createLocalLessonEmbedder({
      artifactDirectory: harness.artifactDirectory,
      artifacts: harness.artifacts,
      loadTransformers: () => Promise.resolve(runtime.module),
    });

    for (const invalid of ["", "   "]) {
      await expect(embed(invalid)).rejects.toThrow(LessonEmbedderError);
    }
    expect(runtime.calls).toHaveLength(0);

    await expect(
      createLocalLessonEmbedder({
        artifactDirectory: "  ",
        artifacts: harness.artifacts,
        loadTransformers: () => Promise.resolve(runtime.module),
      }),
    ).rejects.toThrow(/artifactDirectory/);
  } finally {
    harness.cleanup();
  }
});

test("uses the default Transformers.js loader when none is injected", async () => {
  const harness = writeVerifiedArtifacts();
  try {
    // The optional peer dependency is not installed in this repository, so the
    // default loader must fail with the typed runtime-unavailable error rather
    // than attempting a network load or crashing with an import error.
    const failure = await createLocalLessonEmbedder({
      artifactDirectory: harness.artifactDirectory,
      artifacts: harness.artifacts,
    }).then(
      () => null,
      (error: LessonEmbedderError) => error,
    );
    expect(failure).toBeInstanceOf(LessonEmbedderError);
    expect(failure?.code).toBe("runtime-unavailable");
  } finally {
    harness.cleanup();
  }
});
