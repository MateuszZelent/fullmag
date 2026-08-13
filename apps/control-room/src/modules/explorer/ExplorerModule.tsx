"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  ChevronsDownUp,
  ChevronsUpDown,
  RefreshCw,
  Search,
  SlidersHorizontal,
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
import { WorkspaceRenderProfiler } from "@/kernel/performance/reactRenderProfiler";
import { usePhysicsGraphResource } from "@/kernel/resources/physicsGraphResources";
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
import { usePlanarMonitorsResource } from "@/kernel/resources/planarMonitorResources";
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
  const textureLoadObjectIds = useExplorerStoreSelector(
    (explorer) => explorer.textureLoadObjectIds,
  );
  const objectExtensionActivation = useObjectExtensionActivationSnapshot();
  const pinnedQuickChart = useQuickChartWorkspaceSelector((state) => state.pinned);
  const selectedNodeId = useSelectionSelector((selection) => selection.nodeId);
  const selectedRef = useSelectionSelector((selection) => selection.ref);
  const resultContextRunId = useExplorerStoreSelector(
    (explorer) => explorer.resultContextRunId,
  );
  const previousSelectedNodeId = useRef<string | null>(null);
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
  const modelResource = useSceneResource({ enabled: modelTabActive });
  const domainMeta = useDomainMetaResource({ enabled: modelTabActive });
  const fdmMultilayerLayout = useFdmMultilayerLayoutResource({
    enabled:
      modelTabActive &&
      sessionStatusData?.domain.discretization.toLowerCase() === "fdm",
  });
  const universeMeshPolicy = useUniverseMeshPolicyResource({
    enabled:
      modelTabActive &&
      sessionStatusData?.domain.discretization.toLowerCase() === "fem",
  });
  const fdmRegionMembership = useFdmRegionMembershipResource({
    enabled:
      modelTabActive && sessionStatusData?.domain.discretization.toLowerCase() === "fdm",
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
    ),
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
      discretization: sessionStatusData?.domain.discretization,
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
      sessionStatusData?.domain.discretization,
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
          domainDiscretization:
            sessionStatusData?.domain.discretization.toLowerCase() === "fdm"
              ? "fdm"
              : sessionStatusData?.domain.discretization.toLowerCase() === "fem"
                ? "fem"
                : null,
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
    const latestSuccessfulBuildRecord = record(latestSuccessfulBuild.data);
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
        revisionValue(latestBuildProvenance?.scene_revision),
      latestBuildStatus: stringValue(latestSuccessfulBuildRecord?.status),
      lastError: activeBuild.data?.last_build_error,
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
      sessionStatusData?.domain.discretization.toLowerCase() === "fem"
        ? resolveCurrentFemAirboxEvidence({
            currentMeshRevision: sessionStatusData.resources.mesh_revision,
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
    artifacts: resultContextIsCurrent ? runtimeSnapshot.source.artifacts : undefined,
              resultContextContractGaps,
              resultContextRunId: resolvedResultContextRunId,
              frequencyDomainBranches: resultContextIsCurrent ? frequencyDomainBranches.data : null,
              frequencyDomainDispersion: resultContextIsCurrent ? frequencyDomainDispersion.data : null,
              frequencyDomainManifest: resultContextIsCurrent ? frequencyDomainManifest.data : null,
              frequencyDomainResponseSweep: resultContextIsCurrent ? frequencyDomainResponseSweep.data : null,
              frequencyDomainSpectrum: resultContextIsCurrent ? frequencyDomainSpectrum.data : null,
              pinnedQuickChart,
    tableCatalog: resultContextIsCurrent ? runtimeSnapshot.source.tableCatalog : undefined,
              currentRun: resultsRun.data,
          }, runtimeSnapshot);
    return baseNodes;
  }, [
    activeBuild.data,
    latestSuccessfulBuild.data,
    activeTab,
    crossSections,
    currentTransports.data,
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
      nodes
        .filter((node) => node.kind === "object.root")
        .map((node) => node.id),
    );
  }, [activeTab, nodes]);

  useEffect(() => {
    const previous = previousSelectedNodeId.current;
    previousSelectedNodeId.current = selectedNodeId;
    if (shouldAutoRevealModelTab(previous, selectedNodeId, activeTab)) {
      setExplorerActiveTab("model");
    }
  }, [activeTab, selectedNodeId]);

  useEffect(() => {
    if (!selectedNodeId) return;
    const path = findExplorerNodePath(nodes, selectedNodeId);
    if (!path) return;
    revealExplorerNode(activeTab, selectedNodeId, path.slice(0, -1));
  }, [activeTab, nodes, selectedNodeId]);

  useEffect(() => {
    if (activeTab !== "results") return;
    const currentNode = resolveCurrentExplorerSelectionNode(
      nodes,
      selectedNodeId,
      selectedRef,
      baseNodes,
    );
    if (!currentNode) {
      if (selectedRef?.type === "postprocessing") {
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
        <label className="fm-explorer-filter">
          <Search size={13} aria-hidden="true" className="fm-explorer-filter__search-icon" />
          <input
            aria-label="Filter explorer"
            value={filterText}
            onChange={(event) => setExplorerFilterText(event.target.value)}
            placeholder="Filter nodes..."
            type="search"
          />
          <SlidersHorizontal size={13} aria-hidden="true" className="fm-explorer-filter__options-icon" />
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
        <footer className="fm-explorer-toolbar">
          <button
            className="fm-explorer-toolbar__action"
            title="Expand All"
            type="button"
            onClick={() => {
              expandExplorerNodes(activeTab, collectExplorerNodeIds(nodes));
            }}
          >
            <ChevronsUpDown size={13} aria-hidden="true" />
            <span>Expand All</span>
          </button>
          <button
            className="fm-explorer-toolbar__action"
            title="Collapse All"
            type="button"
            onClick={() => {
              collapseExplorerNodes(activeTab, collectExplorerNodeIds(nodes));
            }}
          >
            <ChevronsDownUp size={13} aria-hidden="true" />
            <span>Collapse All</span>
          </button>
          <button
            className="fm-explorer-toolbar__action"
            title="Refresh"
            type="button"
            onClick={() => {
              setExplorerFilterText("");
              expandExplorerNodes(activeTab, collectExplorerNodeIds(nodes));
            }}
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
