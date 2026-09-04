import { mkdirSync, chmodSync, lstatSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, posix as posixPath, win32 as win32Path } from "node:path";

import { PACKAGE_NAME } from "./constants.js";

type EnvironmentMap = Readonly<Record<string, string | undefined>>;

export type ManagedPaths = Readonly<{
  configDirectory: string;
  configFilePath: string;
  dataDirectory: string;
  cacheDirectory: string;
  backupDirectory: string;
}>;

export type ResolveManagedPathsInput = Readonly<{
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  env?: EnvironmentMap;
  packageName?: string;
}>;

function pathModuleForPlatform(platform: NodeJS.Platform) {
  return platform === "win32" ? win32Path : posixPath;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function readEnvPath(env: EnvironmentMap, key: string): string | null {
  const value = env[key];
  return isNonEmptyString(value) ? value : null;
}

function requireHomeDirectory(homeDirectory: string | undefined, platform: NodeJS.Platform, packageName: string, kind: string): string {
  if (isNonEmptyString(homeDirectory)) {
    return homeDirectory;
  }
  throw new Error(`Cannot resolve ${kind} for ${packageName} on ${platform}: missing home directory.`);
}

function resolveUnixBaseDirectory(
  homeDirectory: string | undefined,
  platform: NodeJS.Platform,
  packageName: string,
  kind: string,
  defaultRelativePath: string,
  override: string | null,
): string {
  if (override !== null) {
    return override;
  }
  const home = requireHomeDirectory(homeDirectory, platform, packageName, kind);
  return posixPath.join(home, defaultRelativePath);
}

function resolveWindowsBaseDirectory(
  homeDirectory: string | undefined,
  platform: NodeJS.Platform,
  packageName: string,
  kind: string,
  envPath: string | null,
  homeRelativePath: string,
): string {
  if (envPath !== null) {
    return envPath;
  }
  const home = requireHomeDirectory(homeDirectory, platform, packageName, kind);
  return win32Path.join(home, homeRelativePath);
}

function unsupportedPlatformError(platform: string): Error {
  return new Error(`Cannot resolve managed paths on unsupported platform: ${platform}.`);
}

export function resolveManagedPaths(input: ResolveManagedPathsInput = {}): ManagedPaths {
  const platform = input.platform ?? process.platform;
  const packageName = input.packageName ?? PACKAGE_NAME;
  const env = input.env ?? process.env;
  const homeDirectory = input.homeDirectory ?? homedir();
  const pathModule = pathModuleForPlatform(platform);

  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") {
    throw unsupportedPlatformError(platform);
  }

  const configBase =
    platform === "linux"
      ? resolveUnixBaseDirectory(homeDirectory, platform, packageName, "config directory", ".config", readEnvPath(env, "XDG_CONFIG_HOME"))
      : platform === "darwin"
        ? resolveUnixBaseDirectory(homeDirectory, platform, packageName, "config directory", "Library/Application Support", null)
        : resolveWindowsBaseDirectory(homeDirectory, platform, packageName, "config directory", readEnvPath(env, "APPDATA"), "AppData/Roaming");

  const dataBase =
    platform === "linux"
      ? resolveUnixBaseDirectory(homeDirectory, platform, packageName, "data directory", ".local/share", readEnvPath(env, "XDG_DATA_HOME"))
      : platform === "darwin"
        ? resolveUnixBaseDirectory(homeDirectory, platform, packageName, "data directory", "Library/Application Support", null)
        : resolveWindowsBaseDirectory(homeDirectory, platform, packageName, "data directory", readEnvPath(env, "APPDATA"), "AppData/Roaming");

  const cacheBase =
    platform === "linux"
      ? resolveUnixBaseDirectory(homeDirectory, platform, packageName, "cache directory", ".cache", readEnvPath(env, "XDG_CACHE_HOME"))
      : platform === "darwin"
        ? resolveUnixBaseDirectory(homeDirectory, platform, packageName, "cache directory", "Library/Caches", null)
        : resolveWindowsBaseDirectory(homeDirectory, platform, packageName, "cache directory", readEnvPath(env, "LOCALAPPDATA"), "AppData/Local");

  const configDirectory = pathModule.join(configBase, packageName);
  const dataDirectory = pathModule.join(dataBase, packageName, "data");
  const cacheDirectory = pathModule.join(cacheBase, packageName, "cache");
  const backupDirectory = pathModule.join(dataDirectory, "backups");

  return {
    configDirectory,
    configFilePath: pathModule.join(configDirectory, "config.json"),
    dataDirectory,
    cacheDirectory,
    backupDirectory,
  };
}

function supportsPosixModes(platform: NodeJS.Platform): boolean {
  return platform !== "win32";
}

function formatManagedPathError(kind: "directory" | "file", path: string, reason: string): Error {
  return new Error(`Cannot manage ${kind} at ${path}: ${reason}.`);
}

function ensureOwnerOnlyPermissions(path: string, mode: number, kind: "directory" | "file", platform: NodeJS.Platform): void {
  if (!supportsPosixModes(platform)) {
    return;
  }

  try {
    chmodSync(path, mode);
  } catch (error) {
    const reason = error instanceof Error && error.message.length > 0 ? error.message : "permission update failed";
    throw formatManagedPathError(kind, path, reason);
  }
}

export function ensureOwnerOnlyDirectory(directoryPath: string, platform: NodeJS.Platform = process.platform): void {
  try {
    const existing = lstatSync(directoryPath, { throwIfNoEntry: false });
    if (existing?.isSymbolicLink()) {
      throw formatManagedPathError("directory", directoryPath, "symbolic links are not supported");
    }
    if (existing !== undefined && !existing.isDirectory()) {
      throw formatManagedPathError("directory", directoryPath, "an existing path is not a directory");
    }

    mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
    ensureOwnerOnlyPermissions(directoryPath, 0o700, "directory", platform);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Cannot manage directory at ")) {
      throw error;
    }
    const reason = error instanceof Error && error.message.length > 0 ? error.message : "directory creation failed";
    throw formatManagedPathError("directory", directoryPath, reason);
  }
}

export function ensureOwnerOnlyFile(filePath: string, platform: NodeJS.Platform = process.platform): void {
  try {
    ensureOwnerOnlyDirectory(dirname(filePath), platform);

    const existing = lstatSync(filePath, { throwIfNoEntry: false });
    if (existing?.isSymbolicLink()) {
      throw formatManagedPathError("file", filePath, "symbolic links are not supported");
    }
    if (existing !== undefined && !existing.isFile()) {
      throw formatManagedPathError("file", filePath, "an existing path is not a file");
    }

    if (existing === undefined) {
      writeFileSync(filePath, "", { mode: 0o600 });
    }

    ensureOwnerOnlyPermissions(filePath, 0o600, "file", platform);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Cannot manage file at ")) {
      throw error;
    }
    const reason = error instanceof Error && error.message.length > 0 ? error.message : "file creation failed";
    throw formatManagedPathError("file", filePath, reason);
  }
}
