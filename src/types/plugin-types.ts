import type { ConfigV1 } from "./config-types.js";
import type { OpenCodeCompatibility } from "./compatibility-types.js";
import type { SqliteConnection } from "./sqlite-types.js";

export type PluginDependencies = Readonly<{
  connection: SqliteConnection;
  config: ConfigV1;
  projectId: string;
  compatibility: OpenCodeCompatibility;
  diagnosticsPath: string;
}>;

export type PluginInitFailure = Readonly<{
  status: "failed";
  error: string;
}>;
