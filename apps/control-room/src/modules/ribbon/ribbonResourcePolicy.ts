import type { RibbonTabId } from "./ribbonTypes";

const RUNTIME_COMMAND_TABS = new Set<RibbonTabId>(["home", "study"]);

export function ribbonTabNeedsRuntimeResources(tabId: RibbonTabId): boolean {
  return RUNTIME_COMMAND_TABS.has(tabId);
}
