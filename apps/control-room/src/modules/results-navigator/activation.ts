import type { RibbonTabId } from "@/kernel/layout/layoutTypes";

export const RESULTS_NAVIGATOR_TAB_ID: RibbonTabId = "results";

export function resultsNavigatorIsActiveForTab(
  activeTab: RibbonTabId,
): boolean {
  return activeTab === RESULTS_NAVIGATOR_TAB_ID;
}
