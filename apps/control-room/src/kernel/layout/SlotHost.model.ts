import type { ModuleManifest } from "../types";

export function resolveSlotModuleManifest(
  registered: readonly ModuleManifest[],
  activeModuleTab: string,
): ModuleManifest | null {
  return registered.find((candidate) => candidate.activationTab === activeModuleTab) ??
    registered[0] ??
    null;
}
