"use client";

import { useAnalysisResultDatasetCatalogResource } from "@/kernel/resources/analysisResultResources";
import { usePostprocessingDefinitionsResource } from "@/kernel/resources/postprocessingDefinitionResources";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronsDownUp,
  ChevronsUpDown,
  RefreshCw,
  Search,
  X,
} from "lucide-react";

import type {
  LiveStatusResource,
  SolverProfileResource,
} from "@/kernel/api/apiTypes";
import { createCommandContext } from "@/kernel/commands/commandContext";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import type { EventBus } from "@/kernel/events/EventBus";
import {
  useMeshBuildCurrent,
  useMeshBuildLatestSuccessful,
  useGeometryValidationResource,
  useMeshRegionMembershipsResource,
  useMeshSharedDomainManifestResource,
  useMeshSharedDomainQualityGatesResource,
  useMeshSharedDomainRealizedSizeFieldsResource,
  useMeshSummaryResource,
  useDomainMetaResource,
  useFdmMultilayerLayoutResource,
  useFdmRegionMembershipResource,
  useModelCouplingsResource,
  useModelMaterialFieldsResource,
  useModelRegionsResource,
  useSceneResource,
  useUniverseMeshPolicyResource,
} from "@/kernel/resources/geometryLifecycleResources";
import {
  buildDomainPresentation,
  deriveAuthoredFdmUniverseOutsideMagneticSupport,
} from "@/shared/domain/mesh/domainPresentation";
import {
  shouldLoadRuntimeMeshBuild,
  shouldLoadRuntimeMeshManifest,
  shouldLoadRuntimeMeshSummary,
  shouldLoadRuntimeStageExecution,
  useFrequencyDomainEigenBranchesResource,
  useFrequencyDomainEigenDispersionResource,
  useFrequencyDomainEigenSpectrumResource,
  useFrequencyDomainManifestResource,
  useFrequencyDomainResponseSweepResource,
  useHysteresisExecutionTreeResource,
  useArtifactsResource,
  useFieldCatalogResource,
  useTableListResource,
  useStageExecutionResource,
  useCurrentRunResource,
  useResultContextRunResource,
  useCommandQueueResource,
  useSolverProfileResource,
  useSolverStatusResource,
} from "@/kernel/resources/studyRuntimeResources";
import {
  projectFlatActiveLaneDiscretization,
  resolveSessionAuthoringDiscretization,
  resolveSessionDiscretization,
  resolveSessionTopologyDiscretization,
  type SessionDiscretizationCapabilitiesProjection,
} from "@/kernel/resources/sessionDiscretization";
import { WorkspaceRenderProfiler } from "@/kernel/performance/reactRenderProfiler";
import { usePhysicsGraphResource } from "@/kernel/resources/physicsGraphResources";
import { useObservationFrameListPages } from "@/kernel/resources/useObservationFrameListPages";
import { useCurrentTransportsResource } from "@/kernel/resources/spinAuthoringResources";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import {
  usePlatformCapabilitiesResource,
  usePlatformHealthResource,
  useRuntimeCommandDetailsResource,
} from "@/kernel/resources/runtimeExplorerResources";
import { runtimeExplorerDetailStore } from "@/kernel/resources/runtimeExplorerDetailStore";
import { useSelectionSelector } from "@/kernel/selection/useSelection";
import {
  isVisualizationAirboxIdentity,
  selectionRefEquals,
} from "@/kernel/selection/selectionTypes";
import {
  buildSemanticRenderTargetCatalog,
  isUniverseOuterBoundaryCarrier,
  semanticRenderTargetCarriersFromManifest,
} from "@/kernel/selection/semanticRenderTargetCatalog";
import { useAnalysisFieldOverlayContext } from "@/kernel/visualization/AnalysisFieldOverlayController";
import { AnalysisFieldOverlayContextNotice } from "@/kernel/visualization/AnalysisFieldOverlayContextNotice";
import {
  resolveActiveObjectExtensionExplorerItems,
} from "@/kernel/object-extensions/ObjectExtensionsSectionModel";
import {
  useObjectExtensionActivationSnapshot,
} from "@/kernel/object-extensions/useObjectExtensionActivation";
import type { ModuleProps } from "@/kernel/types";
import { useCrossSectionWorkspaceSelector } from "@/kernel/workspace/useCrossSectionWorkspace";
import { useQuickChartWorkspaceSelector } from "@/kernel/workspace/useQuickChartWorkspace";
import { useObservationSourceWorkspaceSelector } from "@/kernel/workspace/useObservationSourceWorkspace";
import { usePlanarMonitorsResource } from "@/kernel/resources/planarMonitorResources";
import { useFrozenSpinsCollectionResource } from "@/kernel/resources/frozenSpinsResources";
import {
  meshPipelineStatusIsActive,
  normalizeMeshPipelineStatus,
  resolveMeshBuildStatusLabel,
} from "@/shared/domain/mesh/buildPipeline";

import {
  buildExplorerTree,
  buildModelTree,
  collectExplorerNodeIds,
  filterExplorerNodes,
  findExplorerNodePath,
} from "./builders/buildModelTree";
import {
  resolveCurrentExplorerSelectionNode,
  selectionRefFromNode,
  selectExplorerNode,
} from "./explorerSelection";
import {
  runtimeExplorerSnapshotFromResources,
  runtimeResourceSnapshot,
  runtimeResourceSnapshotEquals,
} from "./builders/runtimeExplorerSnapshot";
import {
  modelTreeSnapshotFromScene,
  modelTreeSnapshotWithHysteresisExecutionTree,
  modelTreeSnapshotWithStageExecution,
} from "./builders/sceneModelTreeAdapter";
import { ExplorerTabBar } from "./ExplorerTabBar";
import { resolveCurrentFemAirboxEvidence } from "./femAirboxEvidence";
import {
  explorerCrossSectionsEqual,
  selectExplorerCrossSections,
} from "./explorerCrossSections";
import {
  activateTextureLoadNode,
  collapseExplorerNodes,
  expandExplorerNodes,
  ensureExplorerModelObjectDefaults,
  reconcileResultContextRunId,
  revealExplorerNode,
  setExplorerActiveTab,
  setExplorerFilterText,
  setExplorerResultContextRunId,
  toggleExplorerNode,
  shouldAutoRevealModelTab,
  useExplorerStoreSelector,
} from "./explorerStore";
import type { ModelTreeMeshSnapshot } from "./explorerTypes";
import { ExplorerTreeView } from "./ExplorerTreeView";
import { ResultContextSelector } from "./ResultContextSelector";
import { useAnalysisFieldOverlayResultContext } from "./useAnalysisFieldOverlayResultContext";

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
  capabilities: Pick<LiveStatusResource["capabilities"], "explicit_topology"> &
    SessionDiscretizationCapabilitiesProjection;
  domain: Pick<LiveStatusResource["domain"], "discretization"> &
    Partial<Pick<LiveStatusResource["domain"], "cell_count" | "generation_id">>;
  resources: Pick<
    LiveStatusResource["resources"],
    "mesh_build_revision" | "mesh_revision" | "stages_revision"
  > &
    Partial<
      Pick<
        LiveStatusResource["resources"],
        "domain_generation_id" | "topology_revision"
      >
    >;
};

function selectExplorerModelRuntimeStatus(status: {
  data: LiveStatusResource | null;
}): ExplorerModelRuntimeStatus | null {
  if (!status.data) return null;
  const sourceCapabilities = status.data.capabilities;
  const flatLane = projectFlatActiveLaneDiscretization(sourceCapabilities);
  const hasActiveLane = Object.prototype.hasOwnProperty.call(
    sourceCapabilities ?? {},
    "active_lane",
  );
  return {
    capabilities: {
      explicit_topology: status.data.capabilities?.explicit_topology ?? false,
      ...(hasActiveLane
        ? { active_lane: sourceCapabilities?.active_lane ?? null }
        : {}),
      ...(flatLane ? { active_lane_discretization: flatLane.value } : {}),
    },
    domain: {
      discretization: status.data.domain.discretization,
      cell_count: status.data.domain.cell_count,
      generation_id: status.data.domain.generation_id,
    },
    resources: {
      domain_generation_id: status.data.resources.domain_generation_id,
      mesh_build_revision: status.data.resources.mesh_build_revision,
      mesh_revision: status.data.resources.mesh_revision,
      stages_revision: status.data.resources.stages_revision,
      topology_revision: status.data.resources.topology_revision,
    },
  };
}

export function explorerModelRuntimeStatusEquals(
  previous: ExplorerModelRuntimeStatus | null,
  next: ExplorerModelRuntimeStatus | null,
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return previous === next;
  return (
    previous.capabilities.explicit_topology ===
      next.capabilities.explicit_topology &&
    Object.prototype.hasOwnProperty.call(
      previous.capabilities,
      "active_lane",
    ) === Object.prototype.hasOwnProperty.call(next.capabilities, "active_lane") &&
    Object.prototype.hasOwnProperty.call(previous.capabilities.active_lane ?? {}, "authored") ===
      Object.prototype.hasOwnProperty.call(next.capabilities.active_lane ?? {}, "authored") &&
    previous.capabilities.active_lane?.authored?.backend === next.capabilities.active_lane?.authored?.backend &&
    previous.capabilities.active_lane?.authored?.discretization === next.capabilities.active_lane?.authored?.discretization &&
    previous.capabilities.active_lane?.resolved?.discretization ===
      next.capabilities.active_lane?.resolved?.discretization &&
    Object.prototype.hasOwnProperty.call(
      previous.capabilities,
      "active_lane_discretization",
    ) ===
      Object.prototype.hasOwnProperty.call(
        next.capabilities,
        "active_lane_discretization",
      ) &&
    previous.capabilities.active_lane_discretization ===
      next.capabilities.active_lane_discretization &&
    previous.domain.discretization === next.domain.discretization &&
    previous.domain.cell_count === next.domain.cell_count &&
    previous.domain.generation_id === next.domain.generation_id &&
    previous.resources.domain_generation_id ===
      next.resources.domain_generation_id &&
    previous.resources.mesh_build_revision ===
      next.resources.mesh_build_revision &&
    previous.resources.mesh_revision === next.resources.mesh_revision &&
    previous.resources.stages_revision === next.resources.stages_revision &&
    previous.resources.topology_revision === next.resources.topology_revision
  );
}

export function resolveExplorerModelDiscretization({
  activeLaneDiscretization,
  domainDiscretization,
}: {
  activeLaneDiscretization: string | null | undefined;
  domainDiscretization: string | null | undefined;
}): "fdm" | "fem" | null {
  return resolveSessionAuthoringDiscretization({
    ...(activeLaneDiscretization !== undefined
      ? { capabilities: { active_lane_discretization: activeLaneDiscretization } }
      : {}),
    domain: { discretization: domainDiscretization },
  });
}

function planarMonitorTargetCapabilitiesFromResources({
  discretization,
  fdmMembership,
  femTopologyReady,
  regions,
  scene,
}: {
  discretization: string | null | undefined;
  fdmMembership: ReturnType<typeof useFdmRegionMembershipResource>;
  femTopologyReady: boolean;
  regions: ReturnType<typeof useModelRegionsResource>;
  scene: ReturnType<typeof useSceneResource>;
}) {
  const objects: Record<string, { enabled: boolean; reason: string }> = {};
  const regionCapabilities: Record<string, { enabled: boolean; reason: string }> = {};
  const sceneObjectIds = (scene.data?.objects ?? []).map((entry) => entry.id);
  const regionRefs = (regions.data?.regions ?? []).flatMap((entry) =>
    entry.owner_object_id
      ? [{ objectId: entry.owner_object_id, regionId: entry.region_id }]
      : [],
  );
  const lane = discretization?.toLowerCase();
  const fdmReady = lane === "fdm" && fdmMembership.availability.status === "ready";
  const fdmObjectIds = new Set(fdmMembership.data?.object_ids ?? []);
  const fdmRegionRefs = new Set(
    (fdmMembership.data?.region_legend ?? []).map(
      (entry) => `${entry.object_id}\u0000${entry.region_id}`,
    ),
  );
  for (const objectId of sceneObjectIds) {
    const enabled = lane === "fem"
      ? femTopologyReady
      : lane === "fdm"
        ? fdmReady && fdmObjectIds.has(objectId)
        : false;
    objects[objectId] = {
      enabled,
      reason: enabled
        ? "Published by current-session planar target resources."
        : lane === "fdm"
          ? "Current-session FDM object membership is not materialized."
          : lane === "fem"
            ? "Current-session FEM topology and object catalog are not materialized."
            : "Active-session discretization capability is unavailable.",
    };
  }
  for (const { objectId, regionId } of regionRefs) {
    const enabled = lane === "fem"
      ? femTopologyReady
      : lane === "fdm"
        ? fdmReady && fdmRegionRefs.has(`${objectId}\u0000${regionId}`)
        : false;
    regionCapabilities[`${objectId}\u0000${regionId}`] = {
      enabled,
      reason: enabled
        ? "Published by current-session planar target resources."
        : lane === "fdm"
          ? "Current-session FDM region membership is not materialized."
          : lane === "fem"
            ? "Current-session FEM topology and region catalog are not materialized."
            : "Active-session discretization capability is unavailable.",
    };
  }
  return { objects, regions: regionCapabilities };
}

export default function ExplorerModule({ kernel, moduleId }: ModuleProps) {
  const activeTab = useExplorerStoreSelector((explorer) => explorer.activeTab);
  const filterText = useExplorerStoreSelector((explorer) => explorer.filterText);
  const keyboardRow = useExplorerStoreSelector((explorer) => explorer.keyboardRow);
  const expandedIds = useExplorerStoreSelector(
    (explorer) => explorer.expandedIds[activeTab],
  );
  const [filterCollapse, setFilterCollapse] = useState({ key: "", ids: new Set<string>() });
  const textureLoadObjectIds = useExplorerStoreSelector(
    (explorer) => explorer.textureLoadObjectIds,
  );
  const objectExtensionActivation = useObjectExtensionActivationSnapshot();
  const pinnedQuickChart = useQuickChartWorkspaceSelector((state) => state.pinned);
  const pinnedObservationSource = useObservationSourceWorkspaceSelector(
    (state) => state.pinned,
  );
  const selectedNodeId = useSelectionSelector((selection) => selection.nodeId);
  const selectedRef = useSelectionSelector((selection) => selection.ref);
  const resultContextRunId = useExplorerStoreSelector(
    (explorer) => explorer.resultContextRunId,
  );
  const previousSelectedNodeId = useRef<string | null>(null);
  const lastRevealedSelectionPath = useRef<string | null>(null);
  const previousCurrentRunId = useRef<string | null>(null);
  const crossSections = useCrossSectionWorkspaceSelector(
    selectExplorerCrossSections,
    { isEqual: explorerCrossSectionsEqual },
  );
  const planarMonitorDraft = useCrossSectionWorkspaceSelector(
    (state) => state.planarMonitorDraft,
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
  const planarMonitors = usePlanarMonitorsResource({ enabled: modelTabActive });
  const frozenSpins = useFrozenSpinsCollectionResource({ enabled: modelTabActive });
  const analysisFieldOverlayContext = useAnalysisFieldOverlayContext(
    kernel.analysisFieldOverlay,
  );
  const activeAnalysisFieldOverlay = analysisFieldOverlayContext.overlay;
  const modeVisualizationResourceActive =
    modelTabActive && Boolean(activeAnalysisFieldOverlay);
  const frequencyDomainTabActive =
    activeTab === "results" ||
    activeTab === "resources" ||
    activeTab === "jobs" ||
    activeTab === "diagnostics";
  const runtimeTabActive =
    activeTab === "resources" ||
    activeTab === "jobs" ||
    activeTab === "diagnostics";
  const resultsResourceActive = runtimeTabActive || activeTab === "results";
  const runtimeSessionStatus = useSessionStatusSelector(
    runtimeResourceSnapshot,
    {
      enabled: runtimeTabActive,
      isEqual: runtimeResourceSnapshotEquals,
    },
  );
  const sessionStatusData = useSessionStatusSelector(
    selectExplorerModelRuntimeStatus,
    { enabled: modelTabActive, isEqual: explorerModelRuntimeStatusEquals },
  );
  const modelDiscretization = resolveSessionAuthoringDiscretization(sessionStatusData);
  const runtimeDiscretization = resolveSessionDiscretization(sessionStatusData);
  const topologyPreviewDiscretization =
    resolveSessionTopologyDiscretization(sessionStatusData);
  const unresolvedRuntimeFemPreview =
    runtimeDiscretization === null && topologyPreviewDiscretization === "fem";
  const modelResource = useSceneResource({ enabled: modelTabActive });
  const domainMeta = useDomainMetaResource({ enabled: modelTabActive });
  const fdmMultilayerLayout = useFdmMultilayerLayoutResource({
    enabled: modelTabActive && modelDiscretization === "fdm",
  });
  const universeMeshPolicy = useUniverseMeshPolicyResource({
    enabled: modelTabActive && modelDiscretization === "fem",
  });
  const fdmRegionMembership = useFdmRegionMembershipResource({
    enabled: modelTabActive && modelDiscretization === "fdm",
  });
  const modelRegions = useModelRegionsResource({ enabled: modelTabActive });
  const regionIds = useMemo(
    () => (modelRegions.data?.regions ?? []).map((region) => region.region_id),
    [modelRegions.data?.regions],
  );
  const regionMemberships = useMeshRegionMembershipsResource(regionIds, {
    enabled: shouldLoadRuntimeMeshManifest(modelTabActive, sessionStatusData),
  });
  const modelMaterialFields = useModelMaterialFieldsResource({
    enabled: modelTabActive,
  });
  const modelCouplings = useModelCouplingsResource({ enabled: modelTabActive });
  const physicsGraph = usePhysicsGraphResource({ enabled: modelTabActive });
  const currentTransports = useCurrentTransportsResource({ enabled: modelTabActive });
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
    enabled: shouldLoadRuntimeMeshManifest(
      modelTabActive || runtimeTabActive,
      modelTabActive ? sessionStatusData : runtimeSessionStatus.data,
    ) || (modelTabActive && unresolvedRuntimeFemPreview),
  });
  const qualityGates = useMeshSharedDomainQualityGatesResource({
    enabled: shouldLoadRuntimeMeshManifest(modelTabActive, sessionStatusData),
  });
  const realizedSizeFields = useMeshSharedDomainRealizedSizeFieldsResource({
    enabled: shouldLoadRuntimeMeshManifest(modelTabActive, sessionStatusData),
  });
  const stageExecution = useStageExecutionResource({
    enabled: shouldLoadRuntimeStageExecution(
      modelTabActive || runtimeTabActive,
      modelTabActive ? sessionStatusData : runtimeSessionStatus.data,
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
    enabled: frequencyDomainTabActive || modeVisualizationResourceActive,
  });
  const currentRun = useCurrentRunResource({
    enabled: frequencyDomainTabActive || Boolean(activeAnalysisFieldOverlay),
  });
  const commandQueue = useCommandQueueResource({ enabled: runtimeTabActive });
  const artifacts = useArtifactsResource({ enabled: resultsResourceActive });
  const fieldCatalog = useFieldCatalogResource({ enabled: runtimeTabActive });
  const tableCatalog = useTableListResource({ enabled: resultsResourceActive });
  const runtimeCommandIds = useMemo(
    () => (commandQueue.data?.commands ?? []).map((command) => command.command_id),
    [commandQueue.data?.commands],
  );
  const commandDetails = useRuntimeCommandDetailsResource(runtimeCommandIds, {
    enabled: runtimeTabActive,
  });
  const geometryValidation = useGeometryValidationResource({
    enabled: runtimeTabActive,
  });
  const platformCapabilities = usePlatformCapabilitiesResource({
    enabled: runtimeTabActive,
  });
  const platformHealth = usePlatformHealthResource({ enabled: runtimeTabActive });
  const solverProfile = useSolverProfileResource({ enabled: runtimeTabActive });
  const solverStatus = useSolverStatusResource({ enabled: runtimeTabActive });
  const currentRunId = currentRun.data?.run_id ?? null;
  const selectedResultRunId =
    selectedRef?.type === "frequency-domain" ? selectedRef.analysisRunId ?? null : null;
  const reconciledResultContextRunId = reconcileResultContextRunId({
    currentRunId,
    previousCurrentRunId: previousCurrentRunId.current,
    selectedRunId: resultContextRunId,
    selectedResultRunId,
  });
  const resolvedResultContextRunId = reconciledResultContextRunId;
  const resultContextIsCurrent = resolvedResultContextRunId === currentRunId;
  const observationFrames = useObservationFrameListPages({
    enabled: resultsResourceActive && resultContextIsCurrent,
    runId: resultContextIsCurrent ? resolvedResultContextRunId : null,
  });
  const resultContextRun = useResultContextRunResource(
    resultContextIsCurrent ? null : resolvedResultContextRunId,
    { enabled: resultsResourceActive },
  );
  const resultsRun = resultContextIsCurrent ? currentRun : resultContextRun;
  const resultContextContractGaps = useMemo(
    () => resultContextIsCurrent
      ? []
      : resultContextRun.status === "ready" && resultContextRun.data
        ? [
            "Selected run is not the current session run; run-scoped result resources are not published.",
          ]
        : resultContextRun.status === "error"
          ? ["Selected result run could not be loaded."]
          : ["Selected result run is loading."],
    [resultContextIsCurrent, resultContextRun.data, resultContextRun.status],
  );
  const knownResultContextRunIds = [
    resultContextRunId,
    selectedResultRunId,
  ].filter((runId): runId is string => Boolean(runId));
  const overlayCommandContext = createCommandContext("explorer", kernel, {
    sourceDetail: "active-analysis-overlay-context",
  });
  const rebindCommand = kernel.commands.get(
    "analysis.frequency-domain.rebind-3d-overlay",
  );
  const rebindDisabledReason = rebindCommand
    ? rebindCommand.disabledReason?.(overlayCommandContext) ?? null
    : "Analysis overlay rebind command is unavailable.";
  const frequencyDomainSpectrum = useFrequencyDomainEigenSpectrumResource({
    enabled: activeTab === "results" || modeVisualizationResourceActive,
  });
  const analysisDefinitions = usePostprocessingDefinitionsResource({
    enabled: activeTab === "results",
  });
  const analysisDatasetCatalog = useAnalysisResultDatasetCatalogResource(currentRunId, {
    enabled: activeTab === "results",
  });
  const frequencyDomainBranches = useFrequencyDomainEigenBranchesResource({
    enabled: activeTab === "results",
  });
  const frequencyDomainDispersion = useFrequencyDomainEigenDispersionResource({
    enabled: activeTab === "results",
  });
  const frequencyDomainResponseSweep = useFrequencyDomainResponseSweepResource({
    enabled: activeTab === "results" || modeVisualizationResourceActive,
  });
  const runtimeSnapshot = useMemo(
    () => runtimeExplorerSnapshotFromResources({
      artifacts: runtimeResourceSnapshot(artifacts),
      commandDetails: runtimeResourceSnapshot(commandDetails),
      commandQueue: runtimeResourceSnapshot(commandQueue),
      currentRun: runtimeResourceSnapshot(currentRun),
      fieldCatalog: runtimeResourceSnapshot(fieldCatalog),
      frequencyDomainManifest: runtimeResourceSnapshot(frequencyDomainManifest),
      geometryValidation: runtimeResourceSnapshot(geometryValidation),
      meshManifest: runtimeResourceSnapshot(manifest),
      platformCapabilities: runtimeResourceSnapshot(platformCapabilities),
      platformHealth: runtimeResourceSnapshot(platformHealth),
      sessionStatus: runtimeSessionStatus,
      solverProfile: runtimeResourceSnapshot<SolverProfileResource>({
        ...solverProfile,
        data: solverProfile.data ?? null,
      }),
      solverStatus: runtimeResourceSnapshot(solverStatus),
      stageExecution: runtimeResourceSnapshot(stageExecution),
      tableCatalog: runtimeResourceSnapshot(tableCatalog),
    }),
    [
      artifacts,
      commandDetails,
      commandQueue,
      currentRun,
      fieldCatalog,
      frequencyDomainManifest,
      geometryValidation,
      manifest,
      platformCapabilities,
      platformHealth,
      runtimeSessionStatus,
      solverProfile,
      solverStatus,
      stageExecution,
      tableCatalog,
    ],
  );
  const planarMonitorTargetCapabilities = useMemo(
    () => planarMonitorTargetCapabilitiesFromResources({
      discretization: modelDiscretization,
      fdmMembership: fdmRegionMembership,
      femTopologyReady: manifest.status === "ready" && manifest.data !== null,
      regions: modelRegions,
      scene: modelResource,
    }),
    [
      fdmRegionMembership,
      manifest.data,
      manifest.status,
      modelRegions,
      modelResource,
      modelDiscretization,
    ],
  );

  useEffect(() => {
    runtimeExplorerDetailStore.publish([
      ...runtimeSnapshot.resources,
      ...runtimeSnapshot.jobs,
      ...runtimeSnapshot.diagnostics,
    ]);
  }, [runtimeSnapshot]);

  useEffect(() => () => runtimeExplorerDetailStore.clear(), []);

  const baseNodes = useMemo(() => {
    let domainPresentation = null as ReturnType<typeof buildDomainPresentation> | null;
    let domainPresentationStatus = domainMeta.status;
    if (domainMeta.data) {
      try {
        const authoredFdmRole =
          domainMeta.data.discretization.toLowerCase() === "fdm"
            ? deriveAuthoredFdmUniverseOutsideMagneticSupport({
                domainBounds: domainMeta.data.bounds,
                objects: modelResource.data?.objects,
              })
            : null;
        domainPresentation = buildDomainPresentation({
          domainMeta: domainMeta.data,
          fdmMembership: fdmRegionMembership.data,
          fdmMembershipStatus: fdmRegionMembership.status,
          universeOutsideMagneticSupport: authoredFdmRole,
        });
      } catch {
        // Keep DomainMeta's discretization visible to the Explorer. A failed
        // derived presentation must never fall through to FEM controls.
        domainPresentationStatus = "error";
      }
    }
    const modelSnapshot = modelTreeSnapshotWithHysteresisExecutionTree(
      modelTreeSnapshotWithStageExecution(
        modelTreeSnapshotFromScene(modelResource.data, {
          couplings: modelCouplings.data,
          materialFields: modelMaterialFields.data,
          regions: modelRegions.data,
          regionMemberships: regionMemberships.data,
          // The graph resource is authoritative for electrical module
          // presence. While it is unresolved, the builder shows one
          // diagnostic node and never falls back to family list rows.
          physicsGraph: physicsGraph.data,
          physicsGraphStatus: physicsGraph.status,
          meshManifest: manifest.data,
          domainMeta: domainMeta.data,
          fdmMultilayerLayout: fdmMultilayerLayout.data,
          fdmMultilayerLayoutStatus: fdmMultilayerLayout.status,
          domainDiscretization: modelDiscretization,
          domainPresentationStatus,
          domainPresentation,
        }),
        stageExecution.data,
      ),
      hysteresisExecutionTree.data,
    );
    const activeBuildStatus = resolveMeshBuildStatusLabel(
      record(activeBuild.data?.active_build),
      normalizeMeshPipelineStatus(activeBuild.data?.mesh_pipeline_status),
    );
    const latestSuccessfulBuildRecord = record(
      latestSuccessfulBuild.data?.last_success,
    );
    const latestBuildProvenance = record(latestSuccessfulBuildRecord?.provenance);
    const modelResourceRecord = record(modelResource.data);
    const semanticTargetCatalog = buildSemanticRenderTargetCatalog({
      parts: semanticRenderTargetCarriersFromManifest(manifest.data),
      sceneObjectIds: new Set(
        (modelSnapshot.objects ?? []).map((object) => object.id),
      ),
    });
    const mesh: ModelTreeMeshSnapshot = {
      activeBuildStatus: meshPipelineStatusIsActive(activeBuildStatus)
        ? activeBuildStatus
        : null,
      buildRevision: activeBuild.data?.revision,
      domainMeshMode: manifest.data?.domain_mesh_mode,
      generationId: manifest.data?.generation_id,
      latestBuildSourceSceneRevision:
        revisionValue(
          latestBuildProvenance?.scene_revision ??
            latestSuccessfulBuildRecord?.source_scene_revision,
        ),
      latestBuildStatus: stringValue(latestSuccessfulBuildRecord?.status),
      lastError:
        activeBuild.data?.last_build_error ??
        latestSuccessfulBuild.data?.last_build_error,
      manifestSourceSceneRevision: manifest.data?.source_scene_revision,
      meshName: manifest.data?.mesh_name,
      meshRevision: meshSummary.data?.revision ?? manifest.data?.revision,
      objectSegmentCount: manifest.data?.object_segments?.length ?? null,
      outerBoundaryPartCount:
        manifest.data?.mesh_parts?.filter(isUniverseOuterBoundaryCarrier).length ?? null,
      partCount: manifest.data?.mesh_parts?.length ?? null,
      qualityStatus: qualityStatus(qualityGates.data?.gates),
      realizedSizeFieldCount:
        realizedSizeFields.data?.realized_size_fields?.fields?.length ?? null,
      regionCount: manifest.data?.regions?.length ?? null,
      sourceSceneRevision: revisionValue(modelResourceRecord?.revision),
      visualizationPartFallbacks: semanticTargetCatalog.entries
        .flatMap((entry) =>
          entry.targetKind === "part"
            ? entry.carrierIds.slice(0, 1).map((carrierId) => ({
            id: carrierId,
            label: entry.label,
            visualizationTargetId: entry.targetId,
              }))
            : [],
        ),
    };
    const objects = modelSnapshot.objects?.flatMap((object) =>
      isVisualizationAirboxIdentity(object)
        ? []
        : [{
            ...object,
            extensions: resolveActiveObjectExtensionExplorerItems(
              object.id,
              objectExtensionActivation,
            ),
            textureLoadEnabled: textureLoadObjectIds.has(object.id),
          }],
    );
    const femAirbox =
      modelDiscretization === "fem"
        ? resolveCurrentFemAirboxEvidence({
            currentMeshRevision: sessionStatusData?.resources.mesh_revision ?? null,
            manifest: { data: manifest.data, status: manifest.status },
            policy: {
              data: universeMeshPolicy.data,
              status: universeMeshPolicy.status,
            },
            scene: { data: modelResource.data, status: modelResource.status },
            summary: { data: meshSummary.data, status: meshSummary.status },
          })
        : null;
    const baseNodes =
      activeTab === "model"
        ? buildModelTree(
            {
              ...modelSnapshot,
              airbox: femAirbox,
              crossSections,
              mesh,
              objects,
              domainPresentation,
            },
            {
              activeAnalysisFieldOverlay,
              currentTransports: currentTransports.data,
              frozenSpins: frozenSpins.data,
              scene: modelResource.data,
              frequencyDomainManifest: frequencyDomainManifest.data,
              frequencyDomainResponseSweep: frequencyDomainResponseSweep.data,
              frequencyDomainSpectrum: frequencyDomainSpectrum.data,
              planarMonitorDraft,
              planarMonitors: planarMonitors.data,
              planarMonitorTargetCapabilities,
            },
          )
        : buildExplorerTree(activeTab, {
              activeAnalysisFieldOverlay,
              analysisDefinitions: analysisDefinitions.data?.definitions ?? null,
              analysisDatasets: resultContextIsCurrent ? analysisDatasetCatalog.data?.items ?? null : null,
    artifacts: resultContextIsCurrent ? runtimeSnapshot.source.artifacts : undefined,
              resultContextContractGaps,
              resultContextRunId: resolvedResultContextRunId,
              frequencyDomainBranches: resultContextIsCurrent ? frequencyDomainBranches.data : null,
              frequencyDomainDispersion: resultContextIsCurrent ? frequencyDomainDispersion.data : null,
              frequencyDomainManifest: resultContextIsCurrent ? frequencyDomainManifest.data : null,
              frequencyDomainResponseSweep: resultContextIsCurrent ? frequencyDomainResponseSweep.data : null,
              frequencyDomainSpectrum: resultContextIsCurrent ? frequencyDomainSpectrum.data : null,
              observationFrames: resultContextIsCurrent
                ? runtimeResourceSnapshot(observationFrames)
                : undefined,
              pinnedObservationFrameId:
                pinnedObservationSource?.runId === resolvedResultContextRunId
                  ? pinnedObservationSource.frameId
                  : null,
              pinnedQuickChart,
    tableCatalog: resultContextIsCurrent ? runtimeSnapshot.source.tableCatalog : undefined,
              currentRun: resultsRun.data,
          }, runtimeSnapshot);
    return baseNodes;
  }, [
    activeBuild.data,
    latestSuccessfulBuild.data,
    activeTab,
    analysisDatasetCatalog.data,
    analysisDefinitions.data,
    crossSections,
    currentTransports.data,
    frozenSpins.data,
    manifest.data,
    manifest.status,
    meshSummary.data,
    meshSummary.status,
    modelResource.data,
    modelResource.status,
    domainMeta.data,
    domainMeta.status,
    fdmMultilayerLayout.data,
    fdmMultilayerLayout.status,
    universeMeshPolicy.data,
    universeMeshPolicy.status,
    sessionStatusData,
    modelDiscretization,
    fdmRegionMembership.data,
    fdmRegionMembership.status,
    modelCouplings.data,
    modelMaterialFields.data,
    modelRegions.data,
    planarMonitorDraft,
    planarMonitors.data,
    planarMonitorTargetCapabilities,
    physicsGraph.data,
    physicsGraph.status,
    regionMemberships.data,
    stageExecution.data,
    hysteresisExecutionTree.data,
    textureLoadObjectIds,
    objectExtensionActivation,
    activeAnalysisFieldOverlay,
    qualityGates.data,
    realizedSizeFields.data,
    frequencyDomainBranches.data,
    frequencyDomainDispersion.data,
    frequencyDomainManifest.data,
    frequencyDomainResponseSweep.data,
    frequencyDomainSpectrum.data,
    pinnedQuickChart,
    pinnedObservationSource,
    observationFrames,
    resultContextContractGaps,
    resultContextIsCurrent,
    resolvedResultContextRunId,
    resultsRun.data,
    runtimeSnapshot,
  ]);

  const nodes = useMemo(
    () => filterExplorerNodes(baseNodes, filterText, selectedNodeId),
    [baseNodes, filterText, selectedNodeId],
  );
  const filtering = filterText.trim().length > 0;
  const filterKey = JSON.stringify([modelResource.sessionScopeKey, activeTab, filterText.trim().toLowerCase()]);
  const filteredExpandedIds = useMemo(() => {
    if (!filtering) return expandedIds;
    const ids = new Set(collectExplorerNodeIds(nodes));
    if (filterCollapse.key === filterKey) {
      for (const id of filterCollapse.ids) ids.delete(id);
    }
    return ids;
  }, [expandedIds, filterCollapse, filterKey, filtering, nodes]);
  const hasFilterMatches = useMemo(
    () => !filtering || filterExplorerNodes(baseNodes, filterText).length > 0,
    [baseNodes, filtering, filterText],
  );
  const sceneError = modelResource.refreshError ?? modelResource.error;
  const sceneNotice = !modelTabActive ? null
    : sceneError ? `Model could not be refreshed. ${modelResource.data ? "Showing the last available model. " : ""}${sceneError.message}`
    : modelResource.status === "loading" ? "Loading model…"
    : modelResource.status === "stale" ? "Refreshing model. Showing the last available model."
    : !modelResource.data ? "Model is not available yet."
    : null;

  function updateFilterText(value: string): void {
    setFilterCollapse({ key: "", ids: new Set() });
    setExplorerFilterText(value);
  }

  function toggleVisibleNode(nodeId: string): void {
    if (!filtering) {
      toggleExplorerNode(activeTab, nodeId);
      return;
    }
    setFilterCollapse((current) => {
      const ids = new Set(current.key === filterKey ? current.ids : []);
      if (ids.has(nodeId)) ids.delete(nodeId);
      else ids.add(nodeId);
      return { key: filterKey, ids };
    });
  }

  function refreshExplorer(): void {
    // Resource hooks own retries, session fences and request deduplication.
    // Refresh never rewrites the user's filter, expansion or selection.
    const resources = modelTabActive
      ? [modelResource, domainMeta, fdmMultilayerLayout, universeMeshPolicy,
          fdmRegionMembership, regionMemberships, modelRegions, modelMaterialFields, modelCouplings,
          physicsGraph, currentTransports, meshSummary, activeBuild,
          latestSuccessfulBuild, manifest, qualityGates, realizedSizeFields,
          stageExecution, hysteresisExecutionTree, planarMonitors, frozenSpins,
          frequencyDomainManifest, frequencyDomainSpectrum, frequencyDomainResponseSweep]
      : activeTab === "results"
        ? [resultsRun, artifacts, tableCatalog, observationFrames, analysisDefinitions,
            analysisDatasetCatalog, frequencyDomainManifest, frequencyDomainSpectrum,
            frequencyDomainBranches, frequencyDomainDispersion, frequencyDomainResponseSweep]
        : [currentRun, artifacts, fieldCatalog, tableCatalog, commandQueue, commandDetails,
            geometryValidation, platformCapabilities, platformHealth, solverProfile,
            solverStatus, stageExecution, manifest, frequencyDomainManifest];
    for (const resource of resources) {
      if (resource.status !== "idle") resource.refetch();
    }
  }

  useEffect(() => {
    previousCurrentRunId.current = currentRunId;
    if (
      resolvedResultContextRunId &&
      resultContextRunId !== resolvedResultContextRunId
    ) {
      setExplorerResultContextRunId(resolvedResultContextRunId);
    }
  }, [currentRunId, resolvedResultContextRunId, resultContextRunId]);

  useAnalysisFieldOverlayResultContext(
    kernel.analysisFieldOverlay,
    resolvedResultContextRunId,
  );

  useEffect(() => {
    if (activeTab !== "model") return;
    ensureExplorerModelObjectDefaults(
      baseNodes
        .filter((node) => node.kind === "object.root")
        .map((node) => node.id),
    );
  }, [activeTab, baseNodes]);

  useEffect(() => {
    const previous = previousSelectedNodeId.current;
    previousSelectedNodeId.current = selectedNodeId;
    if (shouldAutoRevealModelTab(previous, selectedNodeId, activeTab)) {
      setExplorerActiveTab("model");
    }
  }, [activeTab, selectedNodeId]);

  useEffect(() => {
    const path = selectedNodeId ? findExplorerNodePath(baseNodes, selectedNodeId) : null;
    if (!selectedNodeId || !path) {
      lastRevealedSelectionPath.current = null;
      return;
    }
    const revealKey = JSON.stringify([modelResource.sessionScopeKey, activeTab, path]);
    // Resource refreshes must not undo an explicit collapse of the selected path.
    if (lastRevealedSelectionPath.current === revealKey) return;
    lastRevealedSelectionPath.current = revealKey;
    revealExplorerNode(activeTab, selectedNodeId, path.slice(0, -1));
  }, [activeTab, modelResource.sessionScopeKey, baseNodes, selectedNodeId]);

  useEffect(() => {
    if (activeTab !== "results") return;
    const currentNode = resolveCurrentExplorerSelectionNode(
      nodes,
      selectedNodeId,
      selectedRef,
      baseNodes,
    );
    if (!currentNode) {
      if (
        selectedRef?.type === "postprocessing" ||
        selectedRef?.type === "observation-frame"
      ) {
        kernel.selection.clear("explorer");
      }
      return;
    }
    const currentRef = selectionRefFromNode(currentNode);
    if (selectionRefEquals(selectedRef, currentRef)) return;
    selectExplorerNode(kernel, currentNode, "explorer");
  }, [activeTab, baseNodes, kernel, nodes, selectedNodeId, selectedRef]);

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
    return kernel.bus.subscribe("explorer:tab-requested", ({ tab }) => {
      setExplorerActiveTab(tab);
    });
  }, [kernel.bus]);

  useEffect(() => {
    if (crossSectionExpansionIds.length === 0) return;
    expandExplorerNodes("model", crossSectionExpansionIds);
  }, [crossSectionExpansionIds]);

  return (
    <WorkspaceRenderProfiler id="ExplorerModule">
      <section className="fm-explorer" aria-label="Explorer">
        <ExplorerTabBar
          activeTab={activeTab}
          onTabChange={setExplorerActiveTab}
        />
        {activeTab === "results" ? (
          <ResultContextSelector
            currentRunId={currentRunId}
            knownRunIds={knownResultContextRunIds}
            onChange={setExplorerResultContextRunId}
            selectedRunId={resolvedResultContextRunId}
          />
        ) : null}
        <AnalysisFieldOverlayContextNotice
          context={analysisFieldOverlayContext}
          onClear={() => {
            void kernel.commands.execute(
              "analysis.frequency-domain.clear-3d-overlay",
              overlayCommandContext,
            );
          }}
          onRebind={() => {
            void kernel.commands.execute(
              "analysis.frequency-domain.rebind-3d-overlay",
              overlayCommandContext,
            );
          }}
          rebindDisabledReason={rebindDisabledReason}
        />
        <div className="fm-explorer-filter">
          <Search size={13} aria-hidden="true" className="fm-explorer-filter__search-icon" />
          <input
            aria-label="Filter explorer"
            value={filterText}
            onChange={(event) => updateFilterText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && filterText) {
                event.preventDefault();
                event.stopPropagation();
                updateFilterText("");
              }
            }}
            placeholder="Filter nodes..."
            type="search"
          />
          {filterText ? (
            <button
              aria-label="Clear explorer filter"
              className="fm-explorer-filter__clear"
              title="Clear filter (Escape)"
              type="button"
              onClick={(event) => {
                event.currentTarget.parentElement?.querySelector("input")?.focus();
                updateFilterText("");
              }}
            >
              <X size={13} aria-hidden="true" />
            </button>
          ) : null}
        </div>
        {sceneNotice ? (
          <p className={`fm-explorer-notice${sceneError ? " fm-explorer-notice--error" : ""}`} role={sceneError ? "alert" : "status"}>
            {sceneNotice}
          </p>
        ) : null}
        {filtering && !hasFilterMatches && (!modelTabActive || modelResource.data) ? (
          <p className="fm-explorer-notice" role="status">
            No matching nodes.{nodes.length > 0 ? " The current selection is kept visible." : " Try another filter."}
          </p>
        ) : null}
        <ExplorerTreeView
          activeNodeId={selectedNodeId}
          expandedIds={filteredExpandedIds}
          keyboardRowId={keyboardRow}
          kernel={kernel}
          moduleId={moduleId}
          nodes={modelTabActive && !modelResource.data ? [] : nodes}
          onToggleNode={toggleVisibleNode}
          sceneResourceData={
            modelResource.status === "ready" ? modelResource.data : null
          }
          tabId={activeTab}
        />
        {activeTab === "results" && resultContextIsCurrent && (observationFrames.hasMore || observationFrames.refreshError || observationFrames.error || (observationFrames.loading && observationFrames.data)) ? (
          <div className="fm-explorer-notice" role="group" aria-label="State snapshot pagination" aria-busy={observationFrames.loading}>
            <p className="m-0" role={observationFrames.refreshError || observationFrames.error ? "alert" : "status"}>
              {observationFrames.refreshError?.message ?? observationFrames.error?.message
                ?? (observationFrames.loading ? "Loading state snapshots…" : `${observationFrames.data?.frames.length ?? 0} state snapshots loaded. More are available.`)}
            </p>
            <button className="fm-explorer-toolbar__action" type="button"
              disabled={observationFrames.loading}
              onClick={observationFrames.refreshError || observationFrames.error ? observationFrames.retry : observationFrames.loadMore}>
              {observationFrames.loading ? "Loading snapshots…" : observationFrames.refreshError || observationFrames.error ? "Retry snapshots" : "Load more snapshots"}
            </button>
          </div>
        ) : null}
        <footer className="fm-explorer-toolbar">
          <button
            className="fm-explorer-toolbar__action"
            aria-label="Expand all explorer nodes"
            title="Expand All"
            type="button"
            onClick={() => {
              if (filtering) setFilterCollapse({ key: filterKey, ids: new Set() });
              else expandExplorerNodes(activeTab, collectExplorerNodeIds(nodes));
            }}
          >
            <ChevronsUpDown size={13} aria-hidden="true" />
            <span>Expand All</span>
          </button>
          <button
            className="fm-explorer-toolbar__action"
            aria-label="Collapse all explorer nodes"
            title="Collapse All"
            type="button"
            onClick={() => {
              if (filtering) setFilterCollapse({ key: filterKey, ids: new Set(collectExplorerNodeIds(nodes)) });
              else collapseExplorerNodes(activeTab, collectExplorerNodeIds(nodes));
            }}
          >
            <ChevronsDownUp size={13} aria-hidden="true" />
            <span>Collapse All</span>
          </button>
          <button
            className="fm-explorer-toolbar__action"
            aria-label="Refresh explorer"
            title="Refresh"
            type="button"
            onClick={refreshExplorer}
          >
            <RefreshCw size={13} aria-hidden="true" />
            <span>Refresh</span>
          </button>
        </footer>
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
