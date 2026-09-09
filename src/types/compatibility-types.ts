export const OPENCODE_COMPATIBILITY_MANIFEST = {
  schemaVersion: 1,
  minimumVersion: "1.18.27",
  testedVersions: ["1.18.27", "1.18.29", "1.18.30"],
} as const;

export type OpenCodeCompatibility =
  | Readonly<{ status: "supported"; version: string }>
  | Readonly<{
      status: "unsupported";
      version: string;
      reason: "invalid-version" | "below-minimum-version" | "unknown-version";
    }>;

export type Version = readonly [major: number, minor: number, patch: number];
