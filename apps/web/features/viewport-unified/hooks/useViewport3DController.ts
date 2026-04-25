import { useCallback, useMemo } from "react";
import type { FieldComponent, LiveStatus } from "@/src/api/types";
import { resourcesToViewportModel } from "@/src/features/view3d/adapters/resourcesToViewportModel";
import {
  resolveViewport3DResourceState,
  runtimeToViewport3DToolbarState,
} from "@/src/features/view3d/adapters/runtimeToToolbarState";
import { statusToViewport3DCapabilities } from "@/src/features/view3d/adapters/statusToCapabilities";
import {
  buildToolbarStateFromLegacy,
  buildViewport3DModelFromAdapter,
  type Viewport3DFdmSettingsInput,
} from "../model/viewport3dAdapters";
import type { UnifiedRenderState } from "../model/unifiedViewportTypes";
import type {
  Viewport3DAuthoringModel,
  Viewport3DCapabilities,
  Viewport3DControlState,
  Viewport3DDiscretization,
  Viewport3DFallbackMode,
  Viewport3DInteractionMode,
  Viewport3DModel,
  Viewport3DNavigationProfile,
  Viewport3DObjectViewMode,
  Viewport3DProjectionMode,
  Viewport3DToolbarState,
} from "../model/viewport3dContracts";
import { resolveViewport3DCapabilities } from "../model/viewport3dCapabilities";

type StatusResourcesSnapshot = Pick<LiveStatus, "resources"> | null;

export interface Viewport3DControllerResourcesInput {
  statusResources?: LiveStatus["resources"] | null;
  quantityId: string | null;
  component: FieldComponent | null;
  selection?: {
    objectId?: string | null;
    partId?: string | null;
  };
  clip?: {
    enabled: boolean;
    axis: "x" | "y" | "z";
    position: number;
    invert: boolean;
  };
  topologyFallbackRevision?: string | number | null;
  femMeshFieldRevision?: string | number | null;
  dataPlaneFieldRevision?: string | number | null;
  selectedVectorCount?: number | null;
}

export interface Viewport3DControllerToolbarInput {
  clipFlip: boolean;
  interactionMode: Viewport3DInteractionMode;
  snapEnabled: boolean;
  objectViewMode: Viewport3DObjectViewMode;
  vectorsVisible: boolean;
  legendVisible: boolean;
  partExplorerVisible: boolean;
  projection: Viewport3DProjectionMode;
  navProfile: Viewport3DNavigationProfile;
  popovers?: Partial<Viewport3DToolbarState["popovers"]>;
}

export interface Viewport3DControllerModelInput {
  discretization: Viewport3DDiscretization;
  worldExtent?: [number, number, number] | null;
  worldCenter?: [number, number, number] | null;
  selectedEntityFallbackId?: string | null;
  focusedEntityId?: string | null;
  selectedSidebarNodeId?: string | null;
  loading?: boolean;
  message?: string | null;
  error?: string | null;
  pendingMeshBuild?: boolean;
  sourceKind?: "preview" | "live" | "none";
  fieldDataTimestamp?: number | null;
  effectiveStep?: number | null;
  authoring?: Viewport3DAuthoringModel | null;
  fdmSettings?: Viewport3DFdmSettingsInput | null;
  fdmVectorsVisible?: boolean;
}

export interface UseViewport3DControllerArgs {
  capabilities: LiveStatus["capabilities"] | null | undefined;
  authoringEnabled: boolean;
  diagnosticsEnabled: boolean;
  renderState: UnifiedRenderState;
  resources: Viewport3DControllerResourcesInput;
  toolbar: Viewport3DControllerToolbarInput;
  model: Viewport3DControllerModelInput;
}

export interface Viewport3DControlReasons {
  quantity: string | null;
  component: string | null;
  clip: string | null;
  renderMode: string | null;
}

export interface Viewport3DController {
  capabilities: Viewport3DCapabilities;
  toolbarState: Viewport3DToolbarState;
  controlStates: Partial<Record<string, Viewport3DControlState>>;
  controlReasons: Viewport3DControlReasons;
  model: Viewport3DModel;
  createModel: (
    discretization?: Viewport3DDiscretization,
    fallbackMode?: Viewport3DFallbackMode,
  ) => Viewport3DModel;
}

function toStatusResourcesSnapshot(
  resources: LiveStatus["resources"] | null | undefined,
): StatusResourcesSnapshot {
  if (!resources) {
    return null;
  }
  return { resources };
}

export function useViewport3DController({
  capabilities,
  authoringEnabled,
  diagnosticsEnabled,
  renderState,
  resources,
  toolbar,
  model,
}: UseViewport3DControllerArgs): Viewport3DController {
  const contractCapabilities = useMemo(
    () =>
      statusToViewport3DCapabilities(
        capabilities ? { capabilities } : null,
      ),
    [capabilities],
  );
  const unifiedCapabilities = useMemo(
    () =>
      resolveViewport3DCapabilities({
        capabilities: capabilities ?? null,
        authoringEnabled,
        diagnosticsEnabled,
      }),
    [authoringEnabled, capabilities, diagnosticsEnabled],
  );

  const contractModel = useMemo(
    () =>
      resourcesToViewportModel({
        status: toStatusResourcesSnapshot(resources.statusResources),
        quantity_id: resources.quantityId,
        component: resources.component,
        selection: {
          object_id: resources.selection?.objectId ?? null,
          part_id: resources.selection?.partId ?? null,
        },
        clip: resources.clip,
      }),
    [
      resources.clip,
      resources.component,
      resources.quantityId,
      resources.selection?.objectId,
      resources.selection?.partId,
      resources.statusResources,
    ],
  );

  const resourceState = useMemo(
    () =>
      resolveViewport3DResourceState({
        statusTopologyRevision: contractModel.topology_revision,
        topologyFallbackRevision: resources.topologyFallbackRevision,
        statusFieldRevision: contractModel.field_revision,
        femMeshFieldRevision: resources.femMeshFieldRevision,
        dataPlaneFieldRevision: resources.dataPlaneFieldRevision,
        selectedVectorCount: resources.selectedVectorCount,
      }),
    [
      contractModel.field_revision,
      contractModel.topology_revision,
      resources.dataPlaneFieldRevision,
      resources.femMeshFieldRevision,
      resources.selectedVectorCount,
      resources.topologyFallbackRevision,
    ],
  );

  const contractToolbarState = useMemo(
    () =>
      runtimeToViewport3DToolbarState({
        capabilities: contractCapabilities,
        has_topology: resourceState.hasTopology,
        has_field_data: resourceState.hasFieldData,
      }),
    [contractCapabilities, resourceState.hasFieldData, resourceState.hasTopology],
  );

  const toolbarState = useMemo(() => {
    const legacyToolbarState = buildToolbarStateFromLegacy({
      renderState,
      quantityId: resources.quantityId,
      clipFlip: toolbar.clipFlip,
      interactionMode: toolbar.interactionMode,
      snapEnabled: toolbar.snapEnabled,
      objectViewMode: toolbar.objectViewMode,
      vectorsVisible: toolbar.vectorsVisible,
      legendVisible: toolbar.legendVisible,
      partExplorerVisible: toolbar.partExplorerVisible,
      projection: toolbar.projection,
      navProfile: toolbar.navProfile,
      popovers: toolbar.popovers,
    });

    return {
      ...legacyToolbarState,
      rowA: {
        ...legacyToolbarState.rowA,
        clipEnabled:
          legacyToolbarState.rowA.clipEnabled && contractToolbarState.clip_enabled,
      },
      controlStates: {
        ...legacyToolbarState.controlStates,
        quantity: contractToolbarState.quantity_enabled ? "inactive" : "disabled",
        component: contractToolbarState.component_enabled ? "inactive" : "disabled",
        clip: contractToolbarState.clip_enabled ? "inactive" : "disabled",
        renderMode: contractToolbarState.render_mode_enabled ? "inactive" : "disabled",
      },
    } satisfies Viewport3DToolbarState;
  }, [
    contractToolbarState.clip_enabled,
    contractToolbarState.component_enabled,
    contractToolbarState.quantity_enabled,
    contractToolbarState.render_mode_enabled,
    renderState,
    resources.quantityId,
    toolbar.clipFlip,
    toolbar.interactionMode,
    toolbar.legendVisible,
    toolbar.navProfile,
    toolbar.objectViewMode,
    toolbar.partExplorerVisible,
    toolbar.popovers,
    toolbar.projection,
    toolbar.snapEnabled,
    toolbar.vectorsVisible,
  ]);

  const controlReasons = useMemo<Viewport3DControlReasons>(
    () => ({
      quantity: contractToolbarState.reasons.quantity,
      component: contractToolbarState.reasons.component,
      clip: contractToolbarState.reasons.clip,
      renderMode: contractToolbarState.reasons.render_mode,
    }),
    [
      contractToolbarState.reasons.clip,
      contractToolbarState.reasons.component,
      contractToolbarState.reasons.quantity,
      contractToolbarState.reasons.render_mode,
    ],
  );

  const createModel = useCallback(
    (
      discretization: Viewport3DDiscretization = model.discretization,
      fallbackMode?: Viewport3DFallbackMode,
    ): Viewport3DModel => {
      const nextModel = buildViewport3DModelFromAdapter({
        discretization,
        renderState,
        toolbarState,
        capabilities: unifiedCapabilities,
        worldExtent: model.worldExtent ?? null,
        worldCenter: model.worldCenter ?? null,
        topologyRevision: resourceState.topologyRevision,
        fieldRevision: resourceState.fieldRevision,
        quantityId: contractModel.quantity_id,
        selectedObjectId: contractModel.selection.object_id,
        selectedEntityId:
          contractModel.selection.part_id ?? model.selectedEntityFallbackId ?? null,
        focusedEntityId: model.focusedEntityId ?? null,
        selectedSidebarNodeId: model.selectedSidebarNodeId ?? null,
        loading: model.loading ?? false,
        message: model.message ?? null,
        error: model.error ?? null,
        pendingMeshBuild: model.pendingMeshBuild ?? false,
        sourceKind: model.sourceKind ?? "none",
        fieldDataRevision: resourceState.fieldDataRevision,
        fieldDataTimestamp: model.fieldDataTimestamp ?? null,
        effectiveStep: model.effectiveStep ?? null,
        authoring: model.authoring ?? null,
        fdmSettings: model.fdmSettings ?? null,
        fdmVectorsVisible: model.fdmVectorsVisible,
      });

      if (!fallbackMode || nextModel.scene.fallbackMode === fallbackMode) {
        return nextModel;
      }
      return {
        ...nextModel,
        scene: {
          ...nextModel.scene,
          fallbackMode,
        },
      };
    },
    [
      contractModel.quantity_id,
      contractModel.selection.object_id,
      contractModel.selection.part_id,
      model.authoring,
      model.discretization,
      model.effectiveStep,
      model.error,
      model.fdmSettings,
      model.fdmVectorsVisible,
      model.fieldDataTimestamp,
      model.focusedEntityId,
      model.loading,
      model.message,
      model.pendingMeshBuild,
      model.selectedEntityFallbackId,
      model.selectedSidebarNodeId,
      model.sourceKind,
      model.worldCenter,
      model.worldExtent,
      renderState,
      resourceState.fieldDataRevision,
      resourceState.fieldRevision,
      resourceState.topologyRevision,
      toolbarState,
      unifiedCapabilities,
    ],
  );

  const viewportModel = useMemo(
    () => createModel(model.discretization),
    [createModel, model.discretization],
  );

  return {
    capabilities: unifiedCapabilities,
    toolbarState,
    controlStates: toolbarState.controlStates,
    controlReasons,
    model: viewportModel,
    createModel,
  };
}
