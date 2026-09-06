import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../src/cli/index.js";
import { createDefaultConfig, savePackageConfig } from "../src/core/index.js";

function withConfigDir(run: (configPath: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "opencode-swe-factory-cli-config-"));
  const configPath = join(directory, "config.json");
  try {
    run(configPath);
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

test("config shows full configuration as JSON", () => {
  withConfigDir((configPath) => {
    const console_ = captureConsole();
    try {
      expect(main(["config", "--config", configPath])).toBe(0);
      const output = console_.logged.join("\n");
      const parsed = JSON.parse(output);
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.routing.mode).toBe("recommendation-only");
      expect(parsed.privateMode.enabled).toBe(false);
    } finally {
      console_.restore();
    }
  });
});

test("config get reads a top-level section", () => {
  withConfigDir((configPath) => {
    const console_ = captureConsole();
    try {
      expect(main(["config", "get", "routing.mode", "--config", configPath])).toBe(0);
      expect(console_.logged.join("\n")).toBe("recommendation-only");
    } finally {
      console_.restore();
    }
  });
});

test("config get reads a nested value", () => {
  withConfigDir((configPath) => {
    const console_ = captureConsole();
    try {
      expect(main(["config", "get", "backups.enabled", "--config", configPath])).toBe(0);
      expect(console_.logged.join("\n")).toBe("false");
    } finally {
      console_.restore();
    }
  });
});

test("config get reads an object value as JSON", () => {
  withConfigDir((configPath) => {
    const console_ = captureConsole();
    try {
      expect(main(["config", "get", "retrieval.scope", "--config", configPath])).toBe(0);
      const output = console_.logged.join("\n");
      const parsed = JSON.parse(output);
      expect(parsed.global).toBe("enabled");
      expect(parsed.project).toBe("enabled");
      expect(parsed.session).toBe("enabled");
    } finally {
      console_.restore();
    }
  });
});

test("config get fails for unknown path", () => {
  withConfigDir((configPath) => {
    const console_ = captureConsole();
    try {
      expect(main(["config", "get", "nonexistent.path", "--config", configPath])).toBe(1);
      expect(console_.errors.join("\n")).toContain("Unknown config path");
    } finally {
      console_.restore();
    }
  });
});

test("config get fails without path argument", () => {
  withConfigDir((configPath) => {
    const console_ = captureConsole();
    try {
      expect(main(["config", "get", "--config", configPath])).toBe(1);
      expect(console_.errors.join("\n")).toContain("Usage: config get <path>");
    } finally {
      console_.restore();
    }
  });
});

test("config set updates a boolean value", () => {
  withConfigDir((configPath) => {
    const console_ = captureConsole();
    try {
      expect(main(["config", "set", "backups.enabled", "true", "--config", configPath])).toBe(0);
      expect(console_.logged.join("\n")).toContain("Set backups.enabled = true");
    } finally {
      console_.restore();
    }

    const console2 = captureConsole();
    try {
      expect(main(["config", "get", "backups.enabled", "--config", configPath])).toBe(0);
      expect(console2.logged.join("\n")).toBe("true");
    } finally {
      console2.restore();
    }
  });
});

test("config set updates a string value", () => {
  withConfigDir((configPath) => {
    const console_ = captureConsole();
    try {
      expect(main(["config", "set", "routing.mode", "automatic", "--config", configPath])).toBe(0);
      expect(console_.logged.join("\n")).toContain("Set routing.mode = automatic");
    } finally {
      console_.restore();
    }

    const console2 = captureConsole();
    try {
      expect(main(["config", "get", "routing.mode", "--config", configPath])).toBe(0);
      expect(console2.logged.join("\n")).toBe("automatic");
    } finally {
      console2.restore();
    }
  });
});

test("config set updates a nullable number to a number", () => {
  withConfigDir((configPath) => {
    const console_ = captureConsole();
    try {
      expect(main(["config", "set", "backups.retention.maxBackups", "10", "--config", configPath])).toBe(0);
    } finally {
      console_.restore();
    }

    const console2 = captureConsole();
    try {
      expect(main(["config", "get", "backups.retention.maxBackups", "--config", configPath])).toBe(0);
      expect(console2.logged.join("\n")).toBe("10");
    } finally {
      console2.restore();
    }
  });
});

test("config set updates a nullable number to null", () => {
  withConfigDir((configPath) => {
    savePackageConfig({ ...createDefaultConfig(), backups: { ...createDefaultConfig().backups, retention: { maxBackups: 5 } } }, { configFilePath: configPath });

    const console_ = captureConsole();
    try {
      expect(main(["config", "set", "backups.retention.maxBackups", "null", "--config", configPath])).toBe(0);
    } finally {
      console_.restore();
    }

    const console2 = captureConsole();
    try {
      expect(main(["config", "get", "backups.retention.maxBackups", "--config", configPath])).toBe(0);
      expect(console2.logged.join("\n")).toBe("null");
    } finally {
      console2.restore();
    }
  });
});

test("config set rejects invalid values via config validation", () => {
  withConfigDir((configPath) => {
    const console_ = captureConsole();
    try {
      expect(main(["config", "set", "routing.mode", "invalid-mode", "--config", configPath])).toBe(1);
      expect(console_.errors.join("\n")).toContain("Command failed");
    } finally {
      console_.restore();
    }
  });
});

test("config set fails for unknown path", () => {
  withConfigDir((configPath) => {
    const console_ = captureConsole();
    try {
      expect(main(["config", "set", "nonexistent.key", "value", "--config", configPath])).toBe(1);
      expect(console_.errors.join("\n")).toContain("is not an object");
    } finally {
      console_.restore();
    }
  });
});

test("config set fails without value argument", () => {
  withConfigDir((configPath) => {
    const console_ = captureConsole();
    try {
      expect(main(["config", "set", "routing.mode", "--config", configPath])).toBe(1);
      expect(console_.errors.join("\n")).toContain("Usage: config set <path> <value>");
    } finally {
      console_.restore();
    }
  });
});

test("toggles shows resolved feature toggles per scope", () => {
  withConfigDir((configPath) => {
    const console_ = captureConsole();
    try {
      expect(main(["toggles", "--config", configPath])).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain("Private mode: off");
      expect(output).toContain("global:");
      expect(output).toContain("project:");
      expect(output).toContain("session:");
      expect(output).toContain("retrieval:      enabled");
      expect(output).toContain("recording:      enabled");
      expect(output).toContain("modelTelemetry: enabled");
    } finally {
      console_.restore();
    }
  });
});

test("toggles reflects disabled features", () => {
  withConfigDir((configPath) => {
    const defaults = createDefaultConfig();
    savePackageConfig({
      ...defaults,
      retrieval: { ...defaults.retrieval, scope: { global: "disabled", project: "enabled", session: "enabled" } },
    }, { configFilePath: configPath });

    const console_ = captureConsole();
    try {
      expect(main(["toggles", "--config", configPath])).toBe(0);
      const output = console_.logged.join("\n");
      const globalSection = output.split("project:")[0]!;
      expect(globalSection).toContain("retrieval:      disabled");
    } finally {
      console_.restore();
    }
  });
});

test("toggles reflects private mode", () => {
  withConfigDir((configPath) => {
    const defaults = createDefaultConfig();
    savePackageConfig({
      ...defaults,
      privateMode: { enabled: true },
    }, { configFilePath: configPath });

    const console_ = captureConsole();
    try {
      expect(main(["toggles", "--config", configPath])).toBe(0);
      expect(console_.logged.join("\n")).toContain("Private mode: on");
    } finally {
      console_.restore();
    }
  });
});

test("toggles shows routing disabled when mode is disabled", () => {
  withConfigDir((configPath) => {
    const defaults = createDefaultConfig();
    savePackageConfig({
      ...defaults,
      routing: { ...defaults.routing, mode: "disabled" },
    }, { configFilePath: configPath });

    const console_ = captureConsole();
    try {
      expect(main(["toggles", "--config", configPath])).toBe(0);
      const output = console_.logged.join("\n");
      expect(output).toContain("routing:        disabled");
    } finally {
      console_.restore();
    }
  });
});

test("config unknown subcommand fails", () => {
  withConfigDir((configPath) => {
    const console_ = captureConsole();
    try {
      expect(main(["config", "unknown", "--config", configPath])).toBe(1);
      expect(console_.errors.join("\n")).toContain("Unknown config subcommand");
    } finally {
      console_.restore();
    }
  });
});
