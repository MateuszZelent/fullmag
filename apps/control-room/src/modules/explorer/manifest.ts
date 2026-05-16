import type { ModuleManifest } from "@/kernel/types";

import {
  buildExplorerTree,
  collectExplorerNodeIds,
} from "./builders/buildModelTree";
import {
  collapseExplorerNodes,
  expandExplorerNodes,
  explorerStore,
} from "./explorerStore";

function currentTabNodeIds(): string[] {
  const tabId = explorerStore.getSnapshot().activeTab;
  return collectExplorerNodeIds(buildExplorerTree(tabId));
}

export const explorerManifest: ModuleManifest = {
  id: "explorer",
  title: "Explorer",
  version: "0.1.0",
  slots: ["panel-left"],
  component: () => import("./ExplorerModule"),
  contributes: {
    commands: [
      {
        id: "explorer.expand-all",
        title: "Expand Explorer",
        group: "explorer",
        category: "Explorer",
        scope: "workspace",
        run: () => {
          const tabId = explorerStore.getSnapshot().activeTab;
          expandExplorerNodes(tabId, currentTabNodeIds());
          return { status: "completed" };
        },
      },
      {
        id: "explorer.collapse-all",
        title: "Collapse Explorer",
        group: "explorer",
        category: "Explorer",
        scope: "workspace",
        run: () => {
          const tabId = explorerStore.getSnapshot().activeTab;
          collapseExplorerNodes(tabId, currentTabNodeIds());
          return { status: "completed" };
        },
      },
      {
        id: "workspace.toggle-left-panel",
        title: "Toggle Explorer Panel",
        group: "workspace",
        category: "Window",
        scope: "workspace",
        run: (ctx) => {
          ctx.layout?.togglePanel("left");
          return { status: "completed" };
        },
      },
    ],
  },
  emits: ["workspace:selection-changed"],
};
