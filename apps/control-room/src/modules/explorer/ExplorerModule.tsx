"use client";

import { useCallback, useMemo } from "react";
import { Search } from "lucide-react";

import { useResource } from "@/kernel/resources/useResource";
import { useSelection } from "@/kernel/selection/useSelection";
import type { ModuleProps } from "@/kernel/types";

import {
  buildExplorerTree,
  buildModelTree,
  filterExplorerNodes,
} from "./builders/buildModelTree";
import { ExplorerTabBar } from "./ExplorerTabBar";
import {
  setExplorerActiveTab,
  setExplorerFilterText,
  useExplorerStore,
} from "./explorerStore";
import type { ModelTreeSnapshot } from "./explorerTypes";
import { ExplorerTreeView } from "./ExplorerTreeView";

export default function ExplorerModule({ kernel, moduleId }: ModuleProps) {
  const explorer = useExplorerStore();
  const { selection } = useSelection(moduleId);
  const loadModelSnapshot = useCallback(async (): Promise<ModelTreeSnapshot | null> => null, []);
  const modelResource = useResource<ModelTreeSnapshot | null>({
    load: loadModelSnapshot,
    resourceKey: "model:scene",
  });

  const nodes = useMemo(() => {
    const baseNodes =
      explorer.activeTab === "model"
        ? buildModelTree(modelResource.data)
        : buildExplorerTree(explorer.activeTab);
    return filterExplorerNodes(baseNodes, explorer.filterText);
  }, [explorer.activeTab, explorer.filterText, modelResource.data]);

  return (
    <section className="fm-explorer" aria-label="Explorer">
      <header className="fm-explorer__header">
        <div>
          <h2>Explorer</h2>
          <span data-resource-status={modelResource.status}>
            {modelResource.status === "ready" ? "model resource" : modelResource.status}
          </span>
        </div>
      </header>
      <ExplorerTabBar
        activeTab={explorer.activeTab}
        onTabChange={setExplorerActiveTab}
      />
      <label className="fm-explorer-filter">
        <Search size={13} aria-hidden="true" />
        <input
          aria-label="Filter explorer"
          value={explorer.filterText}
          onChange={(event) => setExplorerFilterText(event.target.value)}
          placeholder="Filter"
          type="search"
        />
      </label>
      <ExplorerTreeView
        activeNodeId={selection.nodeId}
        expandedIds={explorer.expandedIds[explorer.activeTab]}
        kernel={kernel}
        moduleId={moduleId}
        nodes={nodes}
        tabId={explorer.activeTab}
      />
    </section>
  );
}
