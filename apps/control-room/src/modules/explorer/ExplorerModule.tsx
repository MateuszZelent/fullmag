"use client";

import { useEffect, useMemo } from "react";
import { Search } from "lucide-react";

import type { LiveStatusResource } from "@/kernel/api/apiTypes";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import type { EventBus } from "@/kernel/events/EventBus";
import {
  useMeshBuildCurrent,
  useMeshBuildLatestSuccessful,
  useMeshSharedDomainManifestResource,
  useMeshSharedDomainQualityGatesResource,
  useMeshSharedDomainRealizedSizeFieldsResource,
  useMeshSummaryResource,
  useModelCouplingsResource,
  useModelMaterialFieldsResource,
  useModelRegionsResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import {
  shouldLoadRuntimeMeshBuild,
  shouldLoadRuntimeMeshManifest,
  shouldLoadRuntimeMeshSummary,
  shouldLoadRuntimeStageExecution,
  useFrequencyDomainEigenBranchesResource,
  useFrequencyDomainEigenDispersionResource,
  useFrequencyDomainEigenSpectrumResource,
  useFrequencyDomainManifestResource,
  useFrequencyDomainResponseCancelRequestedResource,
  useFrequencyDomainResponseProgressResource,
  useFrequencyDomainResponseSweepResource,
  useHysteresisExecutionTreeResource,
  useStageExecutionResource,
} from "@/kernel/resources/studyRuntimeResources";
import { WorkspaceRenderProfiler } from "@/kernel/performance/reactRenderProfiler";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import { useSelectionSelector } from "@/kernel/selection/useSelection";
import {
  resolveActiveObjectExtensionExplorerItems,
} from "@/modules/inspector/extensions/ObjectExtensionsSectionModel";
import {
  useObjectExtensionActivationSnapshot,
} from "@/modules/inspector/extensions/useObjectExtensionActivation";
import type { ModuleProps } from "@/kernel/types";
import { useCrossSectionWorkspaceSelector } from "@/kernel/workspace/useCrossSectionWorkspace";
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
  modelTreeSnapshotWithHysteresisExecutionTree,
  modelTreeSnapshotWithStageExecution,
} from "./builders/sceneModelTreeAdapter";
import { ExplorerTabBar } from "./ExplorerTabBar";
import {
  explorerCrossSectionsEqual,
  selectExplorerCrossSections,
} from "./explorerCrossSections";
import {
  activateTextureLoadNode,
  expandExplorerNodes,
  setExplorerActiveTab,
  setExplorerFilterText,
  useExplorerStoreSelector,
} from "./explorerStore";
import type { ModelTreeMeshSnapshot } from "./explorerTypes";
import { ExplorerTreeView } from "./ExplorerTreeView";

type TextureLoadNodeRequestedEvent =
  KernelEventMap["explorer:texture-load-node-requested"];

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function subscribeExplorerTextureLoadNodeRequested(
  bus: EventBus<KernelEventMap>,
  listener: (event: TextureLoadNodeRequestedEvent) => void,
): () => void {
  return bus.on("explorer:texture-load-node-requested", listener);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function revisionValue(value: unknown): number | string | null {
  return typeof value === "number" || typeof value === "string" ? value : null;
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

type ExplorerModelRuntimeStatus = {
  capabilities: Pick<LiveStatusResource["capabilities"], "explicit_topology">;
  domain: Pick<LiveStatusResource["domain"], "discretization">;
  resources: Pick<
    LiveStatusResource["resources"],
    "mesh_build_revision" | "mesh_revision" | "stages_revision"
  >;
};

function selectExplorerModelRuntimeStatus(status: {
  data: LiveStatusResource | null;
}): ExplorerModelRuntimeStatus | null {
  if (!status.data) return null;
  return {
    capabilities: {
      explicit_topology: status.data.capabilities.explicit_topology,
    },
    domain: {
      discretization: status.data.domain.discretization,
    },
    resources: {
      mesh_build_revision: status.data.resources.mesh_build_revision,
      mesh_revision: status.data.resources.mesh_revision,
      stages_revision: status.data.resources.stages_revision,
    },
  };
}

function explorerModelRuntimeStatusEquals(
  previous: ExplorerModelRuntimeStatus | null,
  next: ExplorerModelRuntimeStatus | null,
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return previous === next;
  return (
    previous.capabilities.explicit_topology ===
      next.capabilities.explicit_topology &&
    previous.domain.discretization === next.domain.discretization &&
    previous.resources.mesh_build_revision ===
      next.resources.mesh_build_revision &&
    previous.resources.mesh_revision === next.resources.mesh_revision &&
    previous.resources.stages_revision === next.resources.stages_revision
  );
}

export default function ExplorerModule({ kernel, moduleId }: ModuleProps) {
  const activeTab = useExplorerStoreSelector((explorer) => explorer.activeTab);
  const filterText = useExplorerStoreSelector((explorer) => explorer.filterText);
  const keyboardRow = useExplorerStoreSelector((explorer) => explorer.keyboardRow);
  const expandedIds = useExplorerStoreSelector(
    (explorer) => explorer.expandedIds[activeTab],
  );
  const textureLoadObjectIds = useExplorerStoreSelector(
    (explorer) => explorer.textureLoadObjectIds,
  );
  const objectExtensionActivation = useObjectExtensionActivationSnapshot();
  const selectedNodeId = useSelectionSelector((selection) => selection.nodeId);
  const crossSections = useCrossSectionWorkspaceSelector(
    selectExplorerCrossSections,
    { isEqual: explorerCrossSectionsEqual },
  );
  const crossSectionExpansionIds = useMemo(() => {
    const ids: string[] = [];
    if (crossSections.draft || crossSections.plots.length > 0) {
      ids.push("model:visualizations-2d");
    }
    if (crossSections.draft) {
      ids.push("model:visualizations-2d:draft");
    }
    for (const plot of crossSections.plots) {
      ids.push(`model:visualizations-2d:${plot.id}`);
    }
    return ids;
  }, [crossSections]);
  const modelTabActive = activeTab === "model";
  const frequencyDomainTabActive =
    activeTab === "results" ||
    activeTab === "resources" ||
    activeTab === "jobs" ||
    activeTab === "diagnostics";
  const sessionStatusData = useSessionStatusSelector(
    selectExplorerModelRuntimeStatus,
    { enabled: modelTabActive, isEqual: explorerModelRuntimeStatusEquals },
  );
  const modelResource = useSceneResource({ enabled: modelTabActive });
  const modelRegions = useModelRegionsResource({ enabled: modelTabActive });
  const modelMaterialFields = useModelMaterialFieldsResource({
    enabled: modelTabActive,
  });
  const modelCouplings = useModelCouplingsResource({ enabled: modelTabActive });
  const meshSummary = useMeshSummaryResource({
    enabled: shouldLoadRuntimeMeshSummary(modelTabActive, sessionStatusData),
  });
  const activeBuild = useMeshBuildCurrent({
    enabled: shouldLoadRuntimeMeshBuild(modelTabActive, sessionStatusData),
  });
  const latestSuccessfulBuild = useMeshBuildLatestSuccessful({
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
  const activeHysteresisStageId = useMemo(
    () => activeHysteresisStageIdFromExecution(stageExecution.data),
    [stageExecution.data],
  );
  const hysteresisExecutionTree = useHysteresisExecutionTreeResource(
    activeHysteresisStageId,
    {
      after: 3,
      before: 2,
      enabled: modelTabActive && Boolean(activeHysteresisStageId),
    },
  );
  const frequencyDomainManifest = useFrequencyDomainManifestResource({
    enabled: frequencyDomainTabActive,
  });
  const frequencyDomainSpectrum = useFrequencyDomainEigenSpectrumResource({
    enabled: activeTab === "results",
  });
  const frequencyDomainBranches = useFrequencyDomainEigenBranchesResource({
    enabled: activeTab === "results",
  });
  const frequencyDomainDispersion = useFrequencyDomainEigenDispersionResource({
    enabled: activeTab === "results",
  });
  const frequencyDomainResponseSweep = useFrequencyDomainResponseSweepResource({
    enabled: activeTab === "results",
  });
  const frequencyDomainResponseProgress =
    useFrequencyDomainResponseProgressResource({
      enabled: frequencyDomainTabActive,
    });
  const frequencyDomainCancelRequested =
    useFrequencyDomainResponseCancelRequestedResource({
      enabled: frequencyDomainTabActive,
    });

  const nodes = useMemo(() => {
    const modelSnapshot = modelTreeSnapshotWithHysteresisExecutionTree(
      modelTreeSnapshotWithStageExecution(
        modelTreeSnapshotFromScene(modelResource.data, {
          couplings: modelCouplings.data,
          materialFields: modelMaterialFields.data,
          regions: modelRegions.data,
        }),
        stageExecution.data,
      ),
      hysteresisExecutionTree.data,
    );
    const activeBuildStatus = resolveMeshBuildStatusLabel(
      record(activeBuild.data?.active_build),
      normalizeMeshPipelineStatus(activeBuild.data?.mesh_pipeline_status),
    );
    const latestSuccessfulBuildRecord = record(latestSuccessfulBuild.data);
    const latestBuildProvenance = record(latestSuccessfulBuildRecord?.provenance);
    const modelResourceRecord = record(modelResource.data);
    const mesh: ModelTreeMeshSnapshot = {
      activeBuildStatus: meshPipelineStatusIsActive(activeBuildStatus)
        ? activeBuildStatus
        : null,
      buildRevision: activeBuild.data?.revision,
      domainMeshMode: manifest.data?.domain_mesh_mode,
      generationId: manifest.data?.generation_id,
      latestBuildSourceSceneRevision:
        revisionValue(latestBuildProvenance?.scene_revision),
      latestBuildStatus: stringValue(latestSuccessfulBuildRecord?.status),
      lastError: activeBuild.data?.last_build_error,
      manifestSourceSceneRevision: manifest.data?.source_scene_revision,
      meshName: manifest.data?.mesh_name,
      meshRevision: meshSummary.data?.revision ?? manifest.data?.revision,
      objectSegmentCount: manifest.data?.object_segments?.length ?? null,
      partCount: manifest.data?.mesh_parts?.length ?? null,
      qualityStatus: qualityStatus(qualityGates.data?.gates),
      realizedSizeFieldCount:
        realizedSizeFields.data?.realized_size_fields?.fields?.length ?? null,
      regionCount: manifest.data?.regions?.length ?? null,
      sourceSceneRevision: revisionValue(modelResourceRecord?.revision),
    };
    const objects = modelSnapshot.objects?.map((object) => ({
      ...object,
      extensions: resolveActiveObjectExtensionExplorerItems(
        object.id,
        objectExtensionActivation,
      ),
      textureLoadEnabled: textureLoadObjectIds.has(object.id),
    }));
    const baseNodes =
      activeTab === "model"
        ? buildModelTree({ ...modelSnapshot, crossSections, mesh, objects })
        : buildExplorerTree(activeTab, {
            frequencyDomainBranches: frequencyDomainBranches.data,
            frequencyDomainCancelRequested: frequencyDomainCancelRequested.data,
            frequencyDomainDispersion: frequencyDomainDispersion.data,
            frequencyDomainManifest: frequencyDomainManifest.data,
            frequencyDomainResponseProgress: frequencyDomainResponseProgress.data,
            frequencyDomainResponseSweep: frequencyDomainResponseSweep.data,
            frequencyDomainSpectrum: frequencyDomainSpectrum.data,
          });
    return filterExplorerNodes(baseNodes, filterText);
  }, [
    activeBuild.data,
    latestSuccessfulBuild.data,
    activeTab,
    filterText,
    crossSections,
    manifest.data,
    meshSummary.data,
    modelResource.data,
    modelCouplings.data,
    modelMaterialFields.data,
    modelRegions.data,
    stageExecution.data,
    hysteresisExecutionTree.data,
    textureLoadObjectIds,
    objectExtensionActivation,
    qualityGates.data,
    realizedSizeFields.data,
    frequencyDomainBranches.data,
    frequencyDomainCancelRequested.data,
    frequencyDomainDispersion.data,
    frequencyDomainManifest.data,
    frequencyDomainResponseProgress.data,
    frequencyDomainResponseSweep.data,
    frequencyDomainSpectrum.data,
  ]);

  useEffect(() => {
    const unsubscribe = subscribeExplorerTextureLoadNodeRequested(
      kernel.bus,
      (event) => {
        activateTextureLoadNode(event.objectId);
        kernel.selection.set(
          {
            kind: "object.magnetic-texture.load",
            label: "Load texture",
            nodeId: `model:object:${event.objectId}:magnetic-texture:load`,
            objectId: event.objectId,
            ref: {
              kind: "object.magnetic-texture.load",
              nodeId: `model:object:${event.objectId}:magnetic-texture:load`,
              objectId: event.objectId,
              type: "scene-object",
              visualizationTargetId: `object:${event.objectId}`,
            },
          },
          event.source,
        );
      },
    );
    return unsubscribe;
  }, [kernel.bus, kernel.selection]);

  useEffect(() => {
    if (crossSectionExpansionIds.length === 0) return;
    expandExplorerNodes("model", crossSectionExpansionIds);
  }, [crossSectionExpansionIds]);

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

function activeHysteresisStageIdFromExecution(
  stageExecution: ReturnType<typeof useStageExecutionResource>["data"],
): string | null {
  if (stageExecution?.active_stage_kind !== "hysteresis") return null;
  const activeIndex = stageExecution.active_stage_index;
  const activeStage = stageExecution.stages.find((stage) =>
    typeof activeIndex === "number" ? stage.index === activeIndex : false,
  ) ?? stageExecution.stages.find((stage) => stage.status === "running");
  return typeof activeStage?.stage_id === "string" ? activeStage.stage_id : null;
}
