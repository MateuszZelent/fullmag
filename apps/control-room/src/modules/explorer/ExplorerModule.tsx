"use client";

import { useMemo } from "react";
import { Search } from "lucide-react";

import {
  useMeshBuildCurrent,
  useMeshSharedDomainManifestResource,
  useMeshSharedDomainQualityGatesResource,
  useMeshSharedDomainRealizedSizeFieldsResource,
  useMeshSummaryResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { useStageExecutionResource } from "@/kernel/resources/studyRuntimeResources";
import { useSelection } from "@/kernel/selection/useSelection";
import type { ModuleProps } from "@/kernel/types";

import {
  buildExplorerTree,
  buildModelTree,
  filterExplorerNodes,
} from "./builders/buildModelTree";
import {
  modelTreeSnapshotFromScene,
  modelTreeSnapshotWithStageExecution,
} from "./builders/sceneModelTreeAdapter";
import { ExplorerTabBar } from "./ExplorerTabBar";
import {
  setExplorerActiveTab,
  setExplorerFilterText,
  useExplorerStore,
} from "./explorerStore";
import type { ModelTreeMeshSnapshot } from "./explorerTypes";
import { ExplorerTreeView } from "./ExplorerTreeView";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function qualityStatus(value: unknown): string | null {
  const status = stringValue(record(value)?.status);
  if (status) return status;
  const checks = record(value)?.checks;
  if (Array.isArray(checks) && checks.some((entry) => record(entry)?.status === "failed")) {
    return "failed";
  }
  if (Array.isArray(checks) && checks.some((entry) => record(entry)?.status === "warning")) {
    return "warning";
  }
  return Array.isArray(checks) && checks.length > 0 ? "pass" : null;
}

export default function ExplorerModule({ kernel, moduleId }: ModuleProps) {
  const explorer = useExplorerStore();
  const { selection } = useSelection(moduleId);
  const modelTabActive = explorer.activeTab === "model";
  const modelResource = useSceneResource({ enabled: modelTabActive });
  const meshSummary = useMeshSummaryResource({ enabled: modelTabActive });
  const activeBuild = useMeshBuildCurrent({ enabled: modelTabActive });
  const manifest = useMeshSharedDomainManifestResource({
    enabled: modelTabActive,
  });
  const qualityGates = useMeshSharedDomainQualityGatesResource({
    enabled: modelTabActive,
  });
  const realizedSizeFields = useMeshSharedDomainRealizedSizeFieldsResource({
    enabled: modelTabActive,
  });
  const stageExecution = useStageExecutionResource({ enabled: modelTabActive });

  const nodes = useMemo(() => {
    const modelSnapshot = modelTreeSnapshotWithStageExecution(
      modelTreeSnapshotFromScene(modelResource.data),
      stageExecution.data,
    );
    const mesh: ModelTreeMeshSnapshot = {
      activeBuildStatus:
        stringValue(record(activeBuild.data?.active_build)?.status) ??
        stringValue(record(activeBuild.data?.mesh_pipeline_status)?.status),
      buildRevision: activeBuild.data?.revision,
      domainMeshMode: manifest.data?.domain_mesh_mode,
      generationId: manifest.data?.generation_id,
      lastError: activeBuild.data?.last_build_error,
      meshName: manifest.data?.mesh_name,
      meshRevision: meshSummary.data?.revision ?? manifest.data?.revision,
      objectSegmentCount: manifest.data?.object_segments?.length ?? null,
      partCount: manifest.data?.mesh_parts?.length ?? null,
      qualityStatus: qualityStatus(qualityGates.data?.gates),
      realizedSizeFieldCount:
        realizedSizeFields.data?.realized_size_fields?.fields?.length ?? null,
      regionCount: manifest.data?.regions?.length ?? null,
    };
    const baseNodes =
      explorer.activeTab === "model"
        ? buildModelTree({ ...modelSnapshot, mesh })
        : buildExplorerTree(explorer.activeTab);
    return filterExplorerNodes(baseNodes, explorer.filterText);
  }, [
    activeBuild.data,
    explorer.activeTab,
    explorer.filterText,
    manifest.data,
    meshSummary.data,
    modelResource.data,
    stageExecution.data,
    qualityGates.data,
    realizedSizeFields.data,
  ]);

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
