export type PinnedEmbeddingArtifact = Readonly<{
  path: string;
  sha256: string;
}>;

export type EmbeddingArtifactFileState = "missing" | "corrupt" | "verified";

export type EmbeddingArtifactState = "not-installed" | "incomplete" | "corrupt" | "verified";

export type EmbeddingArtifactFileStatus = Readonly<{
  path: string;
  sha256: string;
  state: EmbeddingArtifactFileState;
}>;

export type VerifyEmbeddingArtifactsInput = Readonly<{
  artifactDirectory: string;
  artifacts?: ReadonlyArray<PinnedEmbeddingArtifact>;
}>;

export type VerifyEmbeddingArtifactsResult = Readonly<{
  artifactDirectory: string;
  state: EmbeddingArtifactState;
  files: ReadonlyArray<EmbeddingArtifactFileStatus>;
}>;

export type DownloadEmbeddingArtifactFn = (url: string) => Promise<Uint8Array>;

export type InstallEmbeddingArtifactsInput = Readonly<{
  artifactDirectory: string;
  allowRemoteDownloads: boolean;
  privateModeEnabled?: boolean;
  artifacts?: ReadonlyArray<PinnedEmbeddingArtifact>;
  downloadFile?: DownloadEmbeddingArtifactFn;
}>;

export type InstallEmbeddingArtifactsResult = Readonly<{
  artifactDirectory: string;
  downloadedFiles: ReadonlyArray<string>;
  skippedFiles: ReadonlyArray<string>;
  verification: VerifyEmbeddingArtifactsResult;
}>;

export type ResolveEmbeddingArtifactDirectoryInput = Readonly<{
  cacheDirectory: string;
  configArtifactDirectory: string | null;
}>;
