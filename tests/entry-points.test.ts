import { expect, spyOn, test } from "bun:test";

import { getCliHelp, main } from "../src/cli/index.js";
import { PACKAGE_NAME, createCoreContext } from "../src/core/index.js";
import { createOpenCodeAdapter } from "../src/opencode/index.js";

test("entry points load and remain separated", () => {
  const core = createCoreContext();
  const adapter = createOpenCodeAdapter(core);
  const log = spyOn(console, "log").mockImplementation(() => {});

  try {
    expect(PACKAGE_NAME).toBe("opencode-swe-factory");
    expect(core).toEqual({ packageName: PACKAGE_NAME });
    expect(adapter).toEqual({ kind: "opencode-adapter", core });
    expect(getCliHelp()).toBe("opencode-swe-factory CLI scaffold");
    expect(main(["--help"])).toBe(0);
    expect(log).toHaveBeenCalledWith("opencode-swe-factory CLI scaffold");
  } finally {
    log.mockRestore();
  }
});
