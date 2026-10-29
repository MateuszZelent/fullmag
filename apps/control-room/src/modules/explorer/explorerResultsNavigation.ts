import type { LayoutController } from "@/kernel/layout/LayoutController";

import type { ExplorerTabId } from "./explorerTypes";

/**
 * Explorer's Results panel always displays Current outputs. Keep the ribbon
 * source aligned when that host activates or its selected tab changes.
 */
export function synchronizeExplorerResultsSource(
  activeTab: ExplorerTabId,
  layout: Pick<LayoutController, "setResultsSource">,
): void {
  if (activeTab === "results") layout.setResultsSource("current");
}
