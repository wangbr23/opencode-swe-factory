import type { PluginModule } from "@opencode-ai/plugin";

import { server } from "./plugin.js";

export default { id: "opencode-swe-factory", server } satisfies PluginModule;
