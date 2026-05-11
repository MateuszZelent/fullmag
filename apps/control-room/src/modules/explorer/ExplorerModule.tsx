"use client";

import { useMemo } from "react";
import { Search } from "lucide-react";

import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { useSelection } from "@/kernel/selection/useSelection";
import type { ModuleProps } from "@/kernel/types";

import {
  buildExplorerTree,
  buildModelTree,
  filterExplorerNodes,
} from "./builders/buildModelTree";
import { modelTreeSnapshotFromScene } from "./builders/sceneModelTreeAdapter";
import { ExplorerTabBar } from "./ExplorerTabBar";
import {
  setExplorerActiveTab,
  setExplorerFilterText,
  useExplorerStore,
} from "./explorerStore";
import { ExplorerTreeView } from "./ExplorerTreeView";

export default function ExplorerModule({ kernel, moduleId }: ModuleProps) {
  const explorer = useExplorerStore();
  const { selection } = useSelection(moduleId);
  const modelResource = useSceneResource();

  const nodes = useMemo(() => {
    const modelSnapshot = modelTreeSnapshotFromScene(modelResource.data);
    const baseNodes =
      explorer.activeTab === "model"
        ? buildModelTree(modelSnapshot)
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
