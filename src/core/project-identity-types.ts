export const REMOTE_HASH_ALGORITHM = "sha256";
export const SUPPORTED_REMOTE_PROTOCOLS = new Set(["http:", "https:", "ssh:", "git:"]);

export type ResolvedProject = Readonly<{
  id: string;
  path: string;
  remoteHash: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type ProjectResolution = "remote-match" | "path-match" | "created";

export type ProjectIdentityResult = Readonly<{
  project: ResolvedProject;
  resolution: ProjectResolution;
}>;

export type ResolveProjectIdentityInput = Readonly<{
  projectPath: string;
  remoteUrl?: string;
  now?: Date;
}>;

export type ProjectRow = Readonly<{
  id: string;
  remote_hash: string | null;
  path: string;
  created_at: string;
  updated_at: string;
}>;

export type AliasRow = Readonly<{
  project_id: string;
}>;
