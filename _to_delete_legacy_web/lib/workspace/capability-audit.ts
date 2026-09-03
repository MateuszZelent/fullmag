import { CORE_UI_CAPABILITIES } from "./capability-contract";

export function summarizeCapabilityCoverage() {
  const total = CORE_UI_CAPABILITIES.length;
  const implemented = CORE_UI_CAPABILITIES.filter((item) => item.status === "implemented").length;
  const partial = CORE_UI_CAPABILITIES.filter((item) => item.status === "partial").length;
  const missing = CORE_UI_CAPABILITIES.filter((item) => item.status === "missing").length;
  return { total, implemented, partial, missing };
}

