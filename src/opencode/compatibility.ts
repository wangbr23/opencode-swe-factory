import {
  OPENCODE_COMPATIBILITY_MANIFEST,
  type OpenCodeCompatibility,
  type Version,
} from "../types/compatibility-types.js";

export {
  OPENCODE_COMPATIBILITY_MANIFEST,
  type OpenCodeCompatibility,
} from "../types/compatibility-types.js";

export function checkOpenCodeCompatibility(version: string): OpenCodeCompatibility {
  const parsedVersion = parseVersion(version);

  if (!parsedVersion) {
    return { status: "unsupported", version, reason: "invalid-version" };
  }

  const minimumVersion = parseVersion(OPENCODE_COMPATIBILITY_MANIFEST.minimumVersion);

  if (!minimumVersion || compareVersions(parsedVersion, minimumVersion) < 0) {
    return { status: "unsupported", version, reason: "below-minimum-version" };
  }

  // Versions at or above the minimum run with injection enabled: OpenCode
  // patch releases must not silently disable lesson retrieval. The tested
  // list is informational and only shapes the init diagnostic's severity.
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
