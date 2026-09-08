export type VersionProbeFn = () => Promise<string | undefined>;

// Structural stand-in for Bun's shell: the probe only needs the tagged
// template call with nothrow().text(). The plugin package types BunShell
// locally without re-exporting it.
export type ShellVersionRunner = (
  strings: TemplateStringsArray,
  ...expressions: never[]
) => { nothrow(): { text(): Promise<string> } };

const VERSION_PROBE_TIMEOUT_MS = 2000;

/**
 * Live OpenCode passes plugin options only as a config-tuple record and its
 * plugin input carries no version field, so the version must be probed from
 * the environment. An unresolvable version stays unsupported: injection and
 * routing fail safe rather than guessing compatibility.
 */
export function parseProbedVersion(text: string): string | undefined {
  const match = /\b\d+\.\d+\.\d+\b/.exec(text);
  return match ? match[0] : undefined;
}

export function createShellVersionProbe(shell: ShellVersionRunner | undefined): VersionProbeFn {
  if (shell === undefined) {
    return async () => undefined;
  }
  return async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const text = await Promise.race([
        shell`opencode --version`.nothrow().text(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("version probe timed out")), VERSION_PROBE_TIMEOUT_MS);
        }),
      ]);
      return parseProbedVersion(text);
    } catch {
      return undefined;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}

export async function resolveRuntimeOpenCodeVersion(
  optionsVersion: unknown,
  probe: VersionProbeFn,
): Promise<string | undefined> {
  if (typeof optionsVersion === "string" && optionsVersion.trim().length > 0) {
    return optionsVersion;
  }
  try {
    return await probe();
  } catch {
    return undefined;
  }
}
