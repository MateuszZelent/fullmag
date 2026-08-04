import type { RibbonTabId } from "./ribbonTypes";

const RUNTIME_COMMAND_TABS = new Set<RibbonTabId>(["home", "study"]);
const LANE_GATED_TABS = new Set<RibbonTabId>(["geometry", "physics", "view"]);

export function ribbonTabNeedsRuntimeResources(tabId: RibbonTabId): boolean {
  return RUNTIME_COMMAND_TABS.has(tabId);
}

/**
 * Session status carries the resolved discretization used to gate ribbon
 * actions. Geometry needs that lane identity even though it must not pull FEM
 * mesh resources for an FDM session.
 */
export function ribbonTabNeedsSessionStatusResources(
  tabId: RibbonTabId,
  needsMeshResources: boolean,
): boolean {
  return (
    LANE_GATED_TABS.has(tabId) ||
    needsMeshResources ||
    ribbonTabNeedsRuntimeResources(tabId)
  );
}
