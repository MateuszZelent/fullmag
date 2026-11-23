import type { ModuleManifest } from "../types";

/**
 * Resolves the module mounted in a layout slot.
 *
 * ExplorerModule is the single canonical owner of `panel-left` across all
 * Ribbon tabs (including `results`, which switches Explorer's active tab to
 * the Physics-First Results tree rather than unmounting ExplorerModule for
 * legacy `results-navigator`).
 */
export function resolveSlotModuleManifest(
  registered: readonly ModuleManifest[],
  activeModuleTab: string,
): ModuleManifest | null {
  const canonical = registered.filter(
    (candidate) => candidate.id !== "results-navigator",
  );
  return (
    canonical.find((candidate) => candidate.activationTab === activeModuleTab) ??
    canonical[0] ??
    registered.find((candidate) => candidate.activationTab === activeModuleTab) ??
    registered[0] ??
    null
  );
}
