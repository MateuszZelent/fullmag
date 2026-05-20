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
import {
  shouldLoadRuntimeMeshBuild,
  shouldLoadRuntimeMeshManifest,
  shouldLoadRuntimeMeshSummary,
  shouldLoadRuntimeStageExecution,
  useStageExecutionResource,
} from "@/kernel/resources/studyRuntimeResources";
import { WorkspaceRenderProfiler } from "@/kernel/performance/reactRenderProfiler";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import { useSelectionSelector } from "@/kernel/selection/useSelection";
import type { ModuleProps } from "@/kernel/types";
import {
  meshPipelineStatusIsActive,
  normalizeMeshPipelineStatus,
  resolveMeshBuildStatusLabel,
} from "@/shared/domain/mesh/buildPipeline";

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
  useExplorerStoreSelector,
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
  const activeTab = useExplorerStoreSelector((explorer) => explorer.activeTab);
  const filterText = useExplorerStoreSelector((explorer) => explorer.filterText);
  const keyboardRow = useExplorerStoreSelector((explorer) => explorer.keyboardRow);
  const expandedIds = useExplorerStoreSelector(
    (explorer) => explorer.expandedIds[activeTab],
  );
  const selectedNodeId = useSelectionSelector((selection) => selection.nodeId);
  const modelTabActive = activeTab === "model";
  const sessionStatusData = useSessionStatusSelector(
    (sessionStatus) => (modelTabActive ? sessionStatus.data : null),
    { enabled: modelTabActive },
  );
  const modelResource = useSceneResource({ enabled: modelTabActive });
  const meshSummary = useMeshSummaryResource({
    enabled: shouldLoadRuntimeMeshSummary(modelTabActive, sessionStatusData),
  });
  const activeBuild = useMeshBuildCurrent({
    enabled: shouldLoadRuntimeMeshBuild(modelTabActive, sessionStatusData),
  });
  const manifest = useMeshSharedDomainManifestResource({
    enabled: shouldLoadRuntimeMeshManifest(modelTabActive, sessionStatusData),
  });
  const qualityGates = useMeshSharedDomainQualityGatesResource({
    enabled: shouldLoadRuntimeMeshManifest(modelTabActive, sessionStatusData),
  });
  const realizedSizeFields = useMeshSharedDomainRealizedSizeFieldsResource({
    enabled: shouldLoadRuntimeMeshManifest(modelTabActive, sessionStatusData),
  });
  const stageExecution = useStageExecutionResource({
    enabled: shouldLoadRuntimeStageExecution(
      modelTabActive,
      sessionStatusData,
    ),
  });

  const nodes = useMemo(() => {
    const modelSnapshot = modelTreeSnapshotWithStageExecution(
      modelTreeSnapshotFromScene(modelResource.data),
      stageExecution.data,
    );
    const activeBuildStatus = resolveMeshBuildStatusLabel(
      record(activeBuild.data?.active_build),
      normalizeMeshPipelineStatus(activeBuild.data?.mesh_pipeline_status),
    );
    const mesh: ModelTreeMeshSnapshot = {
      activeBuildStatus: meshPipelineStatusIsActive(activeBuildStatus)
        ? activeBuildStatus
        : null,
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
      activeTab === "model"
        ? buildModelTree({ ...modelSnapshot, mesh })
        : buildExplorerTree(activeTab);
    return filterExplorerNodes(baseNodes, filterText);
  }, [
    activeBuild.data,
    activeTab,
    filterText,
    manifest.data,
    meshSummary.data,
    modelResource.data,
    stageExecution.data,
    qualityGates.data,
    realizedSizeFields.data,
  ]);

  return (
    <WorkspaceRenderProfiler id="ExplorerModule">
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
        activeTab={activeTab}
        onTabChange={setExplorerActiveTab}
      />
      <label className="fm-explorer-filter">
        <Search size={13} aria-hidden="true" />
        <input
          aria-label="Filter explorer"
          value={filterText}
          onChange={(event) => setExplorerFilterText(event.target.value)}
          placeholder="Filter"
          type="search"
        />
      </label>
      <ExplorerTreeView
        activeNodeId={selectedNodeId}
        expandedIds={expandedIds}
        keyboardRowId={keyboardRow}
        kernel={kernel}
        moduleId={moduleId}
        nodes={nodes}
        tabId={activeTab}
      />
      </section>
    </WorkspaceRenderProfiler>
  );
}
