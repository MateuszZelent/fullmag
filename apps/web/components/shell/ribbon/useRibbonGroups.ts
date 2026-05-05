import { useMemo } from "react";
import { useVisualizationStore, type VisualizationStoreState } from "@/features/visualization/store/useVisualizationStore";
import { parseStudyNodeContext } from "@/lib/study-builder/node-context";
import type { GeometryCapabilitiesResource } from "@/src/api/types";
import { resolveFemDiscretization } from "@/src/domain/capabilities";
import {
  resolveRibbonGroups,
  type ContextualTabId,
  type RibbonBuildContext,
  type RibbonTabId,
} from "@/features/shell/registry/ribbonRegistry";
import {
  canExecuteRibbonCommand,
  executeRibbonCommand,
  type RibbonCommand,
} from "./command-registry";
import type { RibbonBarProps } from "../RibbonBar";

interface RibbonGroupsInput {
  activeTabId: RibbonTabId;
  activeContextualTabId: string | null;
  builderEnabled: boolean;
  builderDirtyGeometry: boolean;
  builderDirtyMesh: boolean;
  builderHasRealization: boolean;
  builderSceneObjectCount: number;
  builderSelectedPrimitiveId: string | null;
  geometryCapabilities: GeometryCapabilitiesResource | null;
}

type RibbonVisualizationStore = Pick<VisualizationStoreState,
  | "meshRenderMode" | "meshOpacity"
  | "meshClipEnabled" | "meshClipAxis" | "meshClipPos" | "meshClipFlip"
  | "meshShowArrows" | "femVectorGlyphBudget"
  | "femArrowColorMode" | "femArrowMonoColor" | "femArrowAlpha"
  | "femArrowLengthScale" | "femArrowThickness"
  | "femVectorDomainFilter" | "femFerromagnetVisibilityMode"
  | "airMeshOpacity"
  | "viewportLegendVisible" | "viewportAxesScope" | "universeWireframeVisible"
>;

function buildContext(
  props: RibbonBarProps,
  builderState: Omit<RibbonGroupsInput, "activeTabId" | "activeContextualTabId">,
  vizStore: RibbonVisualizationStore,
): RibbonBuildContext {
  const run = (command: RibbonCommand) => {
    executeRibbonCommand(props, command);
  };
  const can = (command: RibbonCommand) => canExecuteRibbonCommand(props, command);

  return {
    isFemBackend: resolveFemDiscretization(
      props.domainCapabilities,
      Boolean(props.femDiscretization),
    ),
    domainCapabilities: props.domainCapabilities ?? null,
    canRun: Boolean(props.canRun),
    canRelax: Boolean(props.canRelax),
    canPause: Boolean(props.canPause),
    canStop: Boolean(props.canStop),
    canSkip: Boolean(props.canSkip),
    runDisabledReason: props.runDisabledReason ?? null,
    pauseDisabledReason: props.pauseDisabledReason ?? null,
    stopDisabledReason: props.stopDisabledReason ?? null,
    skipDisabledReason: props.skipDisabledReason ?? null,
    runAction: props.runAction ?? "run",
    runLabel: props.runLabel ?? "Run",

    meshGenerating: Boolean(props.meshGenerating),
    meshConfigDirty: Boolean(props.meshConfigDirty),
    meshTargetLabel: props.meshTargetLabel ?? null,

    selectedObjectId: props.selectedObjectId ?? null,
    selectedNodeId: props.selectedNodeId ?? null,
    selectedNodeKind: null,
    objectViewMode: props.objectViewMode ?? "context",
    activeTransformScope: props.activeTransformScope ?? null,

    viewMode: props.viewMode ?? null,
    sidebarVisible: Boolean(props.sidebarVisible),
    previewPending: Boolean(props.previewPending),
    viewport3DStatus: props.viewport3DStatus ?? "active",
    viewport3DStatusReason: props.viewport3DStatusReason ?? null,
    viewport3DStatusDetail: props.viewport3DStatusDetail ?? null,
    airboxVisible: Boolean(props.airboxVisible),
    magneticTextureVisible: props.magneticTextureVisible ?? true,
    magneticTextureDensity: props.magneticTextureDensity ?? null,
    quantityShaderVisible: props.quantityShaderVisible ?? true,
    femVectorGlyphBudget: vizStore.femVectorGlyphBudget,
    viewportAxesScope: vizStore.viewportAxesScope,
    universeWireframeVisible: vizStore.universeWireframeVisible,
    viewportLegendVisible: vizStore.viewportLegendVisible,
    explorerVisible: props.explorerVisible ?? Boolean(props.sidebarVisible),
    inspectorVisible: props.inspectorVisible ?? false,
    telemetryVisible: props.telemetryVisible ?? false,

    studyNodeContext: parseStudyNodeContext(props.selectedNodeId),

    quickPreviewTargets: props.quickPreviewTargets ?? [],
    selectedQuantity: props.selectedQuantity ?? null,
    requestedPreviewComponent: props.requestedPreviewComponent ?? null,
    requestedPreviewEveryN: props.requestedPreviewEveryN ?? null,
    requestedPreviewMaxPoints: props.requestedPreviewMaxPoints ?? null,
    requestedPreviewAutoScale: props.requestedPreviewAutoScale ?? null,
    requestedPreviewQuantityDataStatus: props.requestedPreviewQuantityDataStatus ?? null,
    primitiveVisible: props.primitiveVisible ?? true,
    meshRenderMode: vizStore.meshRenderMode,
    meshOpacity: vizStore.meshOpacity,
    selectedObjectTextureVisible: props.selectedObjectTextureVisible ?? null,
    selectedObjectOpacity: props.selectedObjectOpacity ?? null,
    selectedObjectRenderMode: props.selectedObjectRenderMode ?? null,
    meshClipEnabled: vizStore.meshClipEnabled,
    meshClipAxis: vizStore.meshClipAxis,
    meshClipPos: vizStore.meshClipPos,
    meshClipFlip: vizStore.meshClipFlip,
    meshShowArrows: vizStore.meshShowArrows,
    femArrowColorMode: vizStore.femArrowColorMode,
    femArrowMonoColor: vizStore.femArrowMonoColor,
    femArrowAlpha: vizStore.femArrowAlpha,
    femArrowLengthScale: vizStore.femArrowLengthScale,
    femArrowThickness: vizStore.femArrowThickness,
    femVectorDomainFilter: vizStore.femVectorDomainFilter,
    femFerromagnetVisibilityMode: vizStore.femFerromagnetVisibilityMode,
    airMeshOpacity: vizStore.airMeshOpacity,
    airMeshRenderMode: props.airMeshRenderMode ?? null,
    airMeshGeometryVisible: props.airMeshGeometryVisible ?? null,
    airMeshSurfaceVisible: props.airMeshSurfaceVisible ?? null,
    airMeshWireframeVisible: props.airMeshWireframeVisible ?? null,
    airMeshPointsVisible: props.airMeshPointsVisible ?? null,
    airMeshVectorsVisible: props.airMeshVectorsVisible ?? null,
    airMeshWireframeScope: props.airMeshWireframeScope ?? null,
    airMeshPointsScope: props.airMeshPointsScope ?? null,
    airMeshVectorsScope: props.airMeshVectorsScope ?? null,
    slice2DEnabled: Boolean(props.slice2DEnabled),
    slice2DToolbar: props.slice2DToolbar ?? null,
    slice2DDiagnostics: props.slice2DDiagnostics ?? null,

    antennaSources: props.antennaSources ?? [],
    selectedAntennaName: props.selectedAntennaName ?? null,

    canSyncScriptBuilder: Boolean(props.canSyncScriptBuilder),
    scriptSyncBusy: Boolean(props.scriptSyncBusy),

    builderEnabled: builderState.builderEnabled,
    builderDirtyGeometry: builderState.builderDirtyGeometry,
    builderDirtyMesh: builderState.builderDirtyMesh,
    builderHasRealization: builderState.builderHasRealization,
    builderSceneObjectCount: builderState.builderSceneObjectCount,
    builderSelectedPrimitiveId: builderState.builderSelectedPrimitiveId,
    geometryCapabilities: builderState.geometryCapabilities,

    run,
    can,
    dispatchVisualization: props.onDispatchVisualization,
  };
}

export function useRibbonGroups(props: RibbonBarProps, input: RibbonGroupsInput) {
  const vizMeshRenderMode = useVisualizationStore((s) => s.meshRenderMode);
  const vizMeshOpacity = useVisualizationStore((s) => s.meshOpacity);
  const vizMeshClipEnabled = useVisualizationStore((s) => s.meshClipEnabled);
  const vizMeshClipAxis = useVisualizationStore((s) => s.meshClipAxis);
  const vizMeshClipPos = useVisualizationStore((s) => s.meshClipPos);
  const vizMeshClipFlip = useVisualizationStore((s) => s.meshClipFlip);
  const vizMeshShowArrows = useVisualizationStore((s) => s.meshShowArrows);
  const vizFemVectorGlyphBudget = useVisualizationStore((s) => s.femVectorGlyphBudget);
  const vizFemArrowColorMode = useVisualizationStore((s) => s.femArrowColorMode);
  const vizFemArrowMonoColor = useVisualizationStore((s) => s.femArrowMonoColor);
  const vizFemArrowAlpha = useVisualizationStore((s) => s.femArrowAlpha);
  const vizFemArrowLengthScale = useVisualizationStore((s) => s.femArrowLengthScale);
  const vizFemArrowThickness = useVisualizationStore((s) => s.femArrowThickness);
  const vizFemVectorDomainFilter = useVisualizationStore((s) => s.femVectorDomainFilter);
  const vizFemFerromagnetVisibilityMode = useVisualizationStore((s) => s.femFerromagnetVisibilityMode);
  const vizAirMeshOpacity = useVisualizationStore((s) => s.airMeshOpacity);
  const vizViewportLegendVisible = useVisualizationStore((s) => s.viewportLegendVisible);
  const vizViewportAxesScope = useVisualizationStore((s) => s.viewportAxesScope);
  const vizUniverseWireframeVisible = useVisualizationStore((s) => s.universeWireframeVisible);

  return useMemo(() => {
    const ctx = buildContext(props, {
      builderEnabled: input.builderEnabled,
      builderDirtyGeometry: input.builderDirtyGeometry,
      builderDirtyMesh: input.builderDirtyMesh,
      builderHasRealization: input.builderHasRealization,
      builderSceneObjectCount: input.builderSceneObjectCount,
      builderSelectedPrimitiveId: input.builderSelectedPrimitiveId,
      geometryCapabilities: input.geometryCapabilities,
    }, {
      meshRenderMode: vizMeshRenderMode,
      meshOpacity: vizMeshOpacity,
      meshClipEnabled: vizMeshClipEnabled,
      meshClipAxis: vizMeshClipAxis,
      meshClipPos: vizMeshClipPos,
      meshClipFlip: vizMeshClipFlip,
      meshShowArrows: vizMeshShowArrows,
      femVectorGlyphBudget: vizFemVectorGlyphBudget,
      femArrowColorMode: vizFemArrowColorMode,
      femArrowMonoColor: vizFemArrowMonoColor,
      femArrowAlpha: vizFemArrowAlpha,
      femArrowLengthScale: vizFemArrowLengthScale,
      femArrowThickness: vizFemArrowThickness,
      femVectorDomainFilter: vizFemVectorDomainFilter,
      femFerromagnetVisibilityMode: vizFemFerromagnetVisibilityMode,
      airMeshOpacity: vizAirMeshOpacity,
      viewportLegendVisible: vizViewportLegendVisible,
      viewportAxesScope: vizViewportAxesScope,
      universeWireframeVisible: vizUniverseWireframeVisible,
    });

    const baseGroups = resolveRibbonGroups(input.activeTabId, ctx);
    const ctxTabId = input.activeContextualTabId as ContextualTabId | null;
    const contextualGroups = ctxTabId
      ? resolveRibbonGroups(ctxTabId, ctx)
      : [];
    const combined = contextualGroups.length > 0
      ? [...baseGroups, ...contextualGroups]
      : baseGroups;
    const seen = new Set<string>();
    const deduped: typeof combined = [];
    for (let i = combined.length - 1; i >= 0; i--) {
      if (!seen.has(combined[i].id)) {
        seen.add(combined[i].id);
        deduped.unshift(combined[i]);
      }
    }
    return deduped;
  }, [
    input.activeTabId,
    input.activeContextualTabId,
    props.workspaceMode,
    props.viewMode,
    props.viewport3DStatus,
    props.viewport3DStatusReason,
    props.viewport3DStatusDetail,
    props.airboxVisible,
    props.femDiscretization,
    props.solverRunning,
    props.sidebarVisible,
    props.explorerVisible,
    props.inspectorVisible,
    props.telemetryVisible,
    props.selectedNodeId,
    props.canRun,
    props.canRelax,
    props.canPause,
    props.canStop,
    props.canSkip,
    props.runDisabledReason,
    props.pauseDisabledReason,
    props.stopDisabledReason,
    props.skipDisabledReason,
    props.quickPreviewTargets,
    props.selectedQuantity,
    props.requestedPreviewComponent,
    props.requestedPreviewEveryN,
    props.requestedPreviewMaxPoints,
    props.requestedPreviewAutoScale,
    props.requestedPreviewQuantityDataStatus,
    props.primitiveVisible,
    props.magneticTextureVisible,
    props.magneticTextureDensity,
    props.quantityShaderVisible,
    props.selectedObjectTextureVisible,
    props.selectedObjectOpacity,
    props.selectedObjectRenderMode,
    props.airMeshRenderMode,
    props.airMeshGeometryVisible,
    props.airMeshSurfaceVisible,
    props.airMeshWireframeVisible,
    props.airMeshPointsVisible,
    props.airMeshVectorsVisible,
    props.airMeshWireframeScope,
    props.airMeshPointsScope,
    props.airMeshVectorsScope,
    props.slice2DEnabled,
    props.slice2DToolbar,
    props.slice2DDiagnostics,
    props.antennaSources,
    props.selectedAntennaName,
    props.canSyncScriptBuilder,
    props.scriptSyncBusy,
    props.selectedObjectId,
    props.objectViewMode,
    props.onStudyAddPrimitive,
    props.onStudyAddMacro,
    props.onStudyDuplicateSelected,
    props.onStudyToggleSelectedEnabled,
    props.onObjectAddInteraction,
    props.onAssignMagnetizationPreset,
    props.onSetTextureTransformMode,
    props.onSetPreviewComponent,
    props.onSetPreviewEveryN,
    props.onSetPreviewMaxPoints,
    props.onSetFemVectorGlyphBudget,
    props.onSetPreviewColormap,
    props.onSetPreviewAutoScale,
    props.onSetPrimitiveVisible,
    props.onSetMagneticTextureVisible,
    props.onSetMagneticTextureDensity,
    props.onSetQuantityShaderVisible,
    props.onSetMeshRenderMode,
    props.onSetMeshOpacity,
    props.onSetSelectedObjectTextureVisible,
    props.onSetSelectedObjectOpacity,
    props.onSetSelectedObjectRenderMode,
    props.onClearSelectedDisplayOverrides,
    props.onSetMeshClipEnabled,
    props.onSetMeshClipAxis,
    props.onSetMeshClipPos,
    props.onSetMeshClipFlip,
    props.onSetMeshShowArrows,
    props.onSetFemArrowStyle,
    props.onSetAirboxDisplay,
    props.onSetSlice2DToolbar,
    props.onSetObjectViewMode,
    props.onBuilderAddPrimitive,
    props.onBuilderCreateBoolean,
    props.onBuilderBuildGeometry,
    props.onBuilderBuildMesh,
    props.onToggleAirbox,
    props.meshGenerating,
    props.meshConfigDirty,
    props.meshTargetLabel,
    props.runAction,
    props.runLabel,
    props.previewPending,
    vizMeshRenderMode,
    vizMeshOpacity,
    vizMeshClipEnabled,
    vizMeshClipAxis,
    vizMeshClipPos,
    vizMeshClipFlip,
    vizMeshShowArrows,
    vizFemVectorGlyphBudget,
    vizFemArrowColorMode,
    vizFemArrowMonoColor,
    vizFemArrowAlpha,
    vizFemArrowLengthScale,
    vizFemArrowThickness,
    vizFemVectorDomainFilter,
    vizFemFerromagnetVisibilityMode,
    vizAirMeshOpacity,
    vizViewportLegendVisible,
    vizViewportAxesScope,
    vizUniverseWireframeVisible,
    input.builderEnabled,
    input.builderDirtyGeometry,
    input.builderDirtyMesh,
    input.builderHasRealization,
    input.builderSceneObjectCount,
    input.builderSelectedPrimitiveId,
    input.geometryCapabilities,
  ]);
}
