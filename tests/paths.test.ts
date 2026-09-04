import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix as posixPath, win32 as win32Path } from "node:path";
import { tmpdir } from "node:os";

import {
  ensureOwnerOnlyDirectory,
  ensureOwnerOnlyFile,
  resolveManagedPaths,
} from "../src/core/index.js";

function managedMode(path: string): number | null {
  if (process.platform === "win32") {
    return null;
  }
  return statSync(path).mode & 0o777;
}

function withTempDirectory(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "opencode-swe-factory-paths-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("resolveManagedPaths uses platform conventions and injectable environment values", () => {
  const linux = resolveManagedPaths({
    platform: "linux",
    homeDirectory: "/home/alice",
    env: {
      XDG_CONFIG_HOME: "/srv/config",
      XDG_DATA_HOME: "/srv/data",
      XDG_CACHE_HOME: "/srv/cache",
    },
  });

  expect(linux).toEqual({
    configDirectory: posixPath.join("/srv/config", "opencode-swe-factory"),
    configFilePath: posixPath.join("/srv/config", "opencode-swe-factory", "config.json"),
    dataDirectory: posixPath.join("/srv/data", "opencode-swe-factory", "data"),
    cacheDirectory: posixPath.join("/srv/cache", "opencode-swe-factory", "cache"),
    backupDirectory: posixPath.join("/srv/data", "opencode-swe-factory", "data", "backups"),
  });

  const darwin = resolveManagedPaths({
    platform: "darwin",
    homeDirectory: "/Users/alice",
  });

  expect(darwin).toEqual({
    configDirectory: posixPath.join("/Users/alice", "Library/Application Support", "opencode-swe-factory"),
    configFilePath: posixPath.join("/Users/alice", "Library/Application Support", "opencode-swe-factory", "config.json"),
    dataDirectory: posixPath.join("/Users/alice", "Library/Application Support", "opencode-swe-factory", "data"),
    cacheDirectory: posixPath.join("/Users/alice", "Library/Caches", "opencode-swe-factory", "cache"),
    backupDirectory: posixPath.join("/Users/alice", "Library/Application Support", "opencode-swe-factory", "data", "backups"),
  });

  const windows = resolveManagedPaths({
    platform: "win32",
    homeDirectory: "C:\\Users\\Alice",
    env: {
      APPDATA: "C:\\Users\\Alice\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\Alice\\AppData\\Local",
    },
  });

  expect(windows).toEqual({
    configDirectory: win32Path.join("C:\\Users\\Alice\\AppData\\Roaming", "opencode-swe-factory"),
    configFilePath: win32Path.join("C:\\Users\\Alice\\AppData\\Roaming", "opencode-swe-factory", "config.json"),
    dataDirectory: win32Path.join("C:\\Users\\Alice\\AppData\\Roaming", "opencode-swe-factory", "data"),
    cacheDirectory: win32Path.join("C:\\Users\\Alice\\AppData\\Local", "opencode-swe-factory", "cache"),
    backupDirectory: win32Path.join("C:\\Users\\Alice\\AppData\\Roaming", "opencode-swe-factory", "data", "backups"),
  });
});

test("resolveManagedPaths defaults from the runtime without creating filesystem state", () => {
  const resolved = resolveManagedPaths();

  if (process.platform === "win32") {
    expect(resolved.configDirectory).toBe(win32Path.join(homedir(), "opencode-swe-factory"));
    expect(resolved.dataDirectory).toBe(win32Path.join(process.env.APPDATA ?? win32Path.join(homedir(), "AppData", "Roaming"), "opencode-swe-factory", "data"));
    expect(resolved.cacheDirectory).toBe(win32Path.join(process.env.LOCALAPPDATA ?? win32Path.join(homedir(), "AppData", "Local"), "opencode-swe-factory", "cache"));
  } else if (process.platform === "darwin") {
    expect(resolved.configDirectory).toBe(posixPath.join(homedir(), "Library/Application Support", "opencode-swe-factory"));
    expect(resolved.dataDirectory).toBe(posixPath.join(homedir(), "Library/Application Support", "opencode-swe-factory", "data"));
    expect(resolved.cacheDirectory).toBe(posixPath.join(homedir(), "Library/Caches", "opencode-swe-factory", "cache"));
  } else {
    expect(resolved.configDirectory).toBe(posixPath.join(process.env.XDG_CONFIG_HOME ?? posixPath.join(homedir(), ".config"), "opencode-swe-factory"));
    expect(resolved.dataDirectory).toBe(posixPath.join(process.env.XDG_DATA_HOME ?? posixPath.join(homedir(), ".local/share"), "opencode-swe-factory", "data"));
    expect(resolved.cacheDirectory).toBe(posixPath.join(process.env.XDG_CACHE_HOME ?? posixPath.join(homedir(), ".cache"), "opencode-swe-factory", "cache"));
  }
});

test("resolveManagedPaths falls back to home-derived directories and fails clearly when an explicit home override is empty", () => {
  const linux = resolveManagedPaths({
    platform: "linux",
    homeDirectory: "/home/alice",
    env: {},
  });

  expect(linux.configDirectory).toBe(posixPath.join("/home/alice", ".config", "opencode-swe-factory"));
  expect(linux.dataDirectory).toBe(posixPath.join("/home/alice", ".local/share", "opencode-swe-factory", "data"));
  expect(linux.cacheDirectory).toBe(posixPath.join("/home/alice", ".cache", "opencode-swe-factory", "cache"));

  expect(() => resolveManagedPaths({ platform: "linux", homeDirectory: "", env: {} })).toThrow(/Cannot resolve config directory for opencode-swe-factory on linux: missing home directory\./);
  expect(() => resolveManagedPaths({ platform: "win32", homeDirectory: "", env: {} })).toThrow(/Cannot resolve config directory for opencode-swe-factory on win32: missing home directory\./);
});

test("ensureOwnerOnlyDirectory creates and tightens existing directories", () => {
  withTempDirectory((root) => {
    const directoryPath = join(root, "managed-dir");
    ensureOwnerOnlyDirectory(directoryPath);
    expect(managedMode(directoryPath)).toBe(process.platform === "win32" ? null : 0o700);

    if (process.platform !== "win32") {
      chmodSync(directoryPath, 0o755);
    }

    ensureOwnerOnlyDirectory(directoryPath);
    expect(managedMode(directoryPath)).toBe(process.platform === "win32" ? null : 0o700);
  });
});

test("ensureOwnerOnlyFile creates and tightens existing files", () => {
  withTempDirectory((root) => {
    const filePath = join(root, "managed-file", "config.json");
    ensureOwnerOnlyFile(filePath);
    expect(managedMode(filePath)).toBe(process.platform === "win32" ? null : 0o600);

    if (process.platform !== "win32") {
      chmodSync(filePath, 0o644);
    }

    ensureOwnerOnlyFile(filePath);
    expect(managedMode(filePath)).toBe(process.platform === "win32" ? null : 0o600);
  });
});

test("ensureOwnerOnlyDirectory replaces Windows inherited ACLs with an owner-only ACL", () => {
  withTempDirectory((root) => {
    const directoryPath = join(root, "managed-dir");
    const commands: Array<Readonly<{ command: string; arguments_: readonly string[] }>> = [];

    ensureOwnerOnlyDirectory(directoryPath, "win32", (command, arguments_) => {
      commands.push({ command, arguments_ });
    });

    expect(commands).toHaveLength(1);
    expect(commands[0]?.command).toBe("powershell.exe");
    expect(commands[0]?.arguments_.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
    expect(commands[0]?.arguments_.at(-2)).toBe(directoryPath);
    expect(commands[0]?.arguments_.at(-1)).toBe("directory");
    expect(commands[0]?.arguments_[3]).toContain("SetAccessRuleProtection($true, $false)");
    expect(commands[0]?.arguments_[3]).toContain("param([string]$path, [string]$kind)");
    expect(commands[0]?.arguments_[3]).toContain("$isDirectory = $kind -eq 'directory'");
    expect(commands[0]?.arguments_[3]).toContain("DirectorySecurity");
  });
});

test("ensureOwnerOnlyFile hardens Windows parent directories and fails closed on ACL errors", () => {
  withTempDirectory((root) => {
    const filePath = join(root, "managed-file", "config.json");
    const commands: Array<readonly string[]> = [];

    ensureOwnerOnlyFile(filePath, "win32", (_command, arguments_) => {
      commands.push(arguments_);
    });

    expect(commands).toHaveLength(2);
    expect(commands[0]?.at(-1)).toBe("directory");
    expect(commands[1]?.at(-2)).toBe(filePath);
    expect(commands[1]?.at(-1)).toBe("file");
    expect(commands[1]?.[3]).toContain("FileSecurity");
    expect(commands[1]?.[3]).not.toContain("param([string]$path, [bool]$isDirectory)");

    expect(() => ensureOwnerOnlyDirectory(join(root, "blocked"), "win32", () => {
      throw new Error("access denied");
    })).toThrow(/Cannot manage directory at .*: access denied\./);
  });
});

test("ensureOwnerOnlyDirectory and ensureOwnerOnlyFile reject incompatible existing paths", () => {
  withTempDirectory((root) => {
    const filePath = join(root, "file-as-directory");
    const dirPath = join(root, "dir-as-file");

    writeFileSync(filePath, "not a directory");
    mkdirSync(dirPath, { recursive: true });

    expect(() => ensureOwnerOnlyDirectory(filePath)).toThrow(/Cannot manage directory at .*: an existing path is not a directory\./);
    expect(() => ensureOwnerOnlyFile(dirPath)).toThrow(/Cannot manage file at .*: an existing path is not a file\./);
  });
});
