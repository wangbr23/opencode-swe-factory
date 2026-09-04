export const OPENCODE_COMPATIBILITY_MANIFEST = {
  schemaVersion: 1,
  minimumVersion: "1.18.27",
  testedVersions: ["1.18.27"],
} as const;

export type OpenCodeCompatibility =
  | Readonly<{ status: "supported"; version: string }>
  | Readonly<{
      status: "unsupported";
      version: string;
      reason: "invalid-version" | "below-minimum-version" | "untested-version";
    }>;

type Version = readonly [major: number, minor: number, patch: number];

export function checkOpenCodeCompatibility(version: string): OpenCodeCompatibility {
  const parsedVersion = parseVersion(version);

  if (!parsedVersion) {
    return { status: "unsupported", version, reason: "invalid-version" };
  }

  const minimumVersion = parseVersion(OPENCODE_COMPATIBILITY_MANIFEST.minimumVersion);

  if (!minimumVersion || compareVersions(parsedVersion, minimumVersion) < 0) {
    return { status: "unsupported", version, reason: "below-minimum-version" };
  }

  const testedVersions: readonly string[] = OPENCODE_COMPATIBILITY_MANIFEST.testedVersions;

  if (!testedVersions.includes(version)) {
    return { status: "unsupported", version, reason: "untested-version" };
  }

  return { status: "supported", version };
}

function parseVersion(version: string): Version | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);

  if (!match) {
    return undefined;
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);

  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return undefined;
  }

  return [major, minor, patch];
}

function compareVersions(left: Version, right: Version): number {
  return (
    left[0] - right[0] ||
    left[1] - right[1] ||
    left[2] - right[2]
  );
}
