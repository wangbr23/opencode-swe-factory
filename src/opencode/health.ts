import type { HealthCheck } from "../core/diagnostics.js";
import { checkOpenCodeCompatibility } from "./compatibility.js";

export function getOpenCodeCompatibilityHealth(version: string): HealthCheck {
  const compatibility = checkOpenCodeCompatibility(version);
  return compatibility.status === "supported"
    ? { component: "opencode-compatibility", status: "healthy" }
    : {
        component: "opencode-compatibility",
        status: "degraded",
        reason: compatibility.reason,
      };
}
