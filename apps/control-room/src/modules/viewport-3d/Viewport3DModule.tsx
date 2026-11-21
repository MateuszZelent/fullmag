"use client";
import { useSavedResultsPlaybackSelection } from "@/kernel/saved-results/useSavedResultsPlayback";
import SavedResultsPlaybackViewport from "./SavedResultsPlaybackViewport";
import { hasViewport3DQuantityData } from "./model/viewport3DQuantityData";
import { Viewport3DFieldLabel } from "./Viewport3DFieldLabel";
import { artifactRenderedSurfaceRanges } from "./model/artifactFieldOverlayModel";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/Select";

import { useArtifactFieldOverlay } from "./hooks/useArtifactFieldOverlay";
import { useAntennaFieldOverlay } from "./hooks/useAntennaFieldOverlay";
import { antennaFieldDisplayLabel } from "@/kernel/visualization/antennaFieldIntent";

import { observationSourceWorkspaceStore } from "@/kernel/workspace/observationSourceWorkspace";
import { returnToCurrentFieldView } from "@/kernel/visualization/savedFieldPresentation";
import { createViewport3DVisibleColorScaleStore } from "./model/viewport3DVisibleColorScaleStore";
import { createPortal } from "react-dom";
import { registerViewport3DProjectionOwner } from "./viewport3dCameraCommands";
import { useThree } from "@react-three/fiber";
import { useSavedFieldPresentation } from "@/kernel/visualization/useObjectVisualization";
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useReducer, useRef, useState, useSyncExternalStore, useMemo, memo, type ComponentProps, type CSSProperties, type FocusEvent as ReactFocusEvent, type PointerEvent as ReactPointerEvent } from "react";

import type { VisualizationStatePatch, VisualizationStateResource } from "@/kernel/api/apiTypes";
import { isScalarSpatialQuantityId, quantityDisplayName } from "@/kernel/api/quantityIds";
import {
  viewport3DAuditRenderErrorInjectionEnabledFromBrowserConfig,
  viewport3DOrbitDebugEnabledFromBrowserConfig,
  viewport3DVectorLayersEnabledFromBrowserConfig,
} from "@/kernel/browserFullmagConfig";
import { resolveViewport3DMaterialProfile } from "./layers/viewport3DMaterialProfile";
import type { MeshSizeHistogramHighlight } from "@/kernel/events/eventTypes";
import { useInstanceTabHidden } from "@/kernel/layout/instanceTabVisibility";
import { useMeshHistogramBinElementsResource } from "@/kernel/resources/geometryLifecycleResources";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import { sessionResourceIdentityKey, type SessionResourceIdentity } from "@/kernel/resources/sessionResourceIdentity";
import { useFieldMetaResource, useSolverStatusResource } from "@/kernel/resources/studyRuntimeResources";
import {
  frozenSpinsMaskIdFromResource,
  useFrozenSpinsActivePreviewId,
  useFrozenSpinsMaskResource,
  useFrozenSpinsPreviewResource,
} from "@/kernel/resources/frozenSpinsResources";
import {
  selectionSnapshotEquals,
  useSelectionActions,
  useSelectionSelector,
} from "@/kernel/selection/useSelection";

import { resolveVisualizationTargetForMeshPart } from "@/kernel/selection/visualizationTargetResolver";
import {
  resolveSemanticTargetForMeshPart,
  type SemanticRenderTargetCatalog,
} from "@/kernel/selection/semanticRenderTargetCatalog";
import { WorkspaceRenderProfiler } from "@/kernel/performance/reactRenderProfiler";
import { useObjectEditSelector } from "@/kernel/authoring/object-edit/useObjectEditSelector";
import type { ModuleProps } from "@/kernel/types";
import { AIRBOX_VISUALIZATION_TARGET, type VisualizationTargetRef } from "@/kernel/visualization/ObjectVisualizationController";
import { useVisualizationClientAckSender } from "@/kernel/visualization/useVisualizationClientAck";
import { Button } from "@/shared/ui/Button";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/Popover";
import { displayUnitItemsForSourceUnit, formatValueWithDisplayUnit, hasDisplayUnitOptions, normalizeDisplayUnit } from "@/shared/domain/physics/displayUnits";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";

import { useViewport3DColors } from "./hooks/useViewport3DColors";
import { withObjectPlacementDraftPreview } from "./viewport3dPrimitiveModel";
import {
  useViewport3DSceneModel,
  type Viewport3DFieldDataIssue,
  type Viewport3DFieldPresentationFreshness,
} from "./hooks/useViewport3DSceneModel";
import { createViewport3DVisualizationDebugCandidateBuilder, useViewport3DVisualizationDebugPublisher, type Viewport3DVisualizationDebugSource } from "./hooks/useViewport3DVisualizationDebugPublisher";
import { createViewport3DRenderAdoptionRegistry } from "./model/viewport3DRenderAdoptionRegistry";
import { VIEWPORT_3D_WORLD_UP } from "./layers/CameraControls";
import { resolveViewport3DCameraFit, normalizeViewport3DOrbitDebugAngles, type Viewport3DCameraChange, type Viewport3DOrbitDebugAngles, VIEWPORT_3D_ORBIT_DEBUG_LIMITS } from "./layers/CameraControls.model";
import { Viewport3DScene } from "./layers/Viewport3DScene";
import { Viewport3DFrameCommitQueueProvider } from "./layers/Viewport3DFrameCommitQueueContext";
import {
  useViewport3DObjectMoveInteraction,
  Viewport3DMoveStatus,
} from "./Viewport3DObjectMoveInteraction";
import type { Viewport3DAirboxFrameState } from "./layers/Viewport3DScene";
import { createViewport3DFrameCommitQueue } from "./model/viewport3DFrameCommitQueue";
import { createViewport3DOrbitDebugStore } from "./model/viewport3DOrbitDebugStore";
import { recordViewport3DCameraTrajectorySample } from "./layers/viewport3DCameraTrajectoryProbe";

import type { RegionOverlaySelection } from "./layers/RegionOverlayLayer";
import { buildFrozenSpinsOverlayModel, buildFrozenSpinsOverlayModelFromField } from "./layers/FrozenSpinsOverlay.model";
import {
  DEFAULT_REGION_DIAGNOSTIC_OVERLAY_STATE,
  regionDiagnosticOverlayMode,
  type RegionDiagnosticOverlaySource,
  type RegionDiagnosticOverlayState,
} from "./regionOverlayMode";
import { Viewport3DCameraDialog } from "./components/Viewport3DCameraDialog";
import { Viewport3DSettingsContent } from "./components/Viewport3DSettingsContent";
import { Viewport3DToolbar } from "./components/Viewport3DToolbar";
import { Viewport3DExportPanel } from "./export/Viewport3DExportPanel";
import { Viewport3DExportMenu, Viewport3DExportOutlet } from "./export/Viewport3DExportSurface";
import type { ViewportModelSource } from "./export/Viewport3DExportDialog";
import {
  setViewport3DExportMode,
  setViewport3DInspectorSection,
  useViewport3DInspectorDestination,
} from "./viewport3dInspectorState";
import { Viewport3DAppearanceHud } from "./components/Viewport3DAppearanceHud";
import { Viewport3DCanvas } from "./Viewport3DCanvas";
import { Viewport3DErrorBoundary } from "./Viewport3DErrorBoundary";
import { type Viewport3DPartSelection } from "./viewport3dDomainAdapter";
import {
  currentViewport3DMeshCellAuditTopology,
  listViewport3DMeshCellSelections,
  resolveViewport3DMeshCellSelection,
  type Viewport3DMeshCellSelectionIdentity,
  type Viewport3DMeshCellSelectionRequest,
} from "./viewport3dMeshCellSelection";
import { type HysteresisReplayGlyphModel, type HysteresisStepViewportTarget } from "./model/viewport3DTargets";

import { planViewport3DColorbars, resolveViewport3DColorbarRangeStates, type Viewport3DColorbarPlan } from "./model/viewport3DColorbarPlan";
export { resolveViewport3DColorbarRangeStates } from "./model/viewport3DColorbarPlan";

import {
  useViewport3DResourceCounts,
  useViewport3DResourceTracker,
} from "./viewport3dDiagnostics";
import { useViewport3DWorkerRuntime } from "./viewport3dWorkerRuntime";
import { createViewport3DEventManager } from "./viewport3dEventManager";
import {
  useViewport3DFieldVectorRequest,
} from "./viewport3dResources";
import { retainViewport3DMeshSizeHighlight } from "./viewport3dMeshSizeHighlight";
import { formatViewport3DInspectComponents, type Viewport3DInspectSample, type Viewport3DInspectScreenPosition } from "./viewport3dInspect";
import {
  type Viewport3DPrimitiveObject,
} from "./viewport3dPrimitiveModel";
import { toCameraTuple } from "./viewport3dCameraModel";
import { DEFAULT_VIEWPORT_3D_CAMERA_FOV_DEGREES } from "./viewport3dCameraFov";
import {
  viewportSelectionForMeshPart,
  viewportSelectionForDomain,
  viewportSelectionForFdmCell,
  viewportSelectionForFdmUniverseOutsideSupport,
  viewportSelectionForFdmTarget,
  viewportSelectionForObject,
  viewportSelectionForRegion,
} from "./viewport3dSelection";
import {
  EMPTY_VIEWPORT_3D_REFRESH_SAMPLE,
  resolveViewport3DRefreshCountdownDisplay,
  resolveViewport3DRefreshCountdownNextTickDelay,
  updateViewport3DRefreshSample,
  type Viewport3DFieldRefreshState,
} from "./viewport3dRefreshCountdown";
import {
  DEFAULT_VIEWPORT_3D_CAMERA_STATE,
  buildViewport3DRenderedScalarRangeAliases,
  viewport3dStore,
  useViewport3DCommandState,
} from "./viewport3dStore";
import type { MeshQualityColorMetric } from "./viewport3dQualityMapping";
import { VIEWPORT_3D_FRAMELOOP } from "./viewport3dTypes";

import {
  configureViewport3DRenderer,
  getViewport3DVisualProfile,
  resolveViewport3DCanvasDpr,
  type Viewport3DVisualProfile,
} from "./viewport3dVisualProfile";
import {
  createViewport3DInteractionFieldHold,
} from "./viewport3dFieldUpdateHold";

import { installViewport3DThreeConsolePolicy } from "./viewport3dThreeConsolePolicy";
import {
  captureViewport3DThumbnail,
  resolveViewport3DThumbnailColouring,
  type Viewport3DThumbnailColouring,
} from "./viewport3dThumbnail";
import { registerViewport3DThumbnailCapture } from "./viewport3dThumbnailRegistry";
import { captureViewport3DImage } from "./viewport3dImageExport";
import { EMPTY_VIEWPORT_3D_COLORBAR_PLANS, type Viewport3DSceneProps, type MeshQualityRange, resolveViewport3DFdmSelectionAnnouncement, buildViewport3DCameraRegistryPatch, formatHysteresisReplayLabel, type Viewport3DInspectHover, resolveViewport3DMeshQualityLegend, type Viewport3DColorbarTargetPart, buildViewport3DColorbarTargetPlans, resolveViewport3DColorbarPlansForRender, resolveViewport3DColorbarLegendsFromPlans, resolveSavedFieldColorbars, resolveArtifactFieldColorbars, resolveRetainedViewport3DColorbarPlansForStore, buildViewport3DVisualizationDebugFrameCommit, resolveViewport3DVisualizationFrameAck, resolveViewport3DVisualizationAckDataIdentity, notifyMeshTopologyRendered, resolveViewport3DVisualizationAckRegistration, resolveViewport3DInspectSelectionProvenance, resolveViewport3DVectorSegmentLengthRange, formatHysteresisReplayGlyphVector, type Viewport3DColorbarLegend, formatViewport3DColorbarQuantityLabel } from "./Viewport3DModule.model";

type Viewport3DCanvasCreatedState = Parameters<
  NonNullable<ComponentProps<typeof Viewport3DCanvas>["onCreated"]>
>[0];

declare global {
  interface Window {
    __FULLMAG_LIST_VIEWPORT_3D_MESH_CELLS__?: () =>
      Viewport3DMeshCellSelectionIdentity[];
    __FULLMAG_SELECT_VIEWPORT_3D_MESH_CELL__?: (
      request: Viewport3DMeshCellSelectionRequest,
    ) => Viewport3DMeshCellSelectionIdentity;
  }
}

const VIEWPORT_3D_CANVAS_GL_NO_ANTIALIAS = {
  alpha: false,
  antialias: false,
  powerPreference: "high-performance" as const,
  preserveDrawingBuffer: false,
};

const VIEWPORT_3D_CANVAS_GL_ANTIALIAS = {
  alpha: false,
  antialias: true,
  powerPreference: "high-performance" as const,
  preserveDrawingBuffer: false,
};

const VIEWPORT_3D_CANVAS_GL_CAPTURE = {
  alpha: false,
  antialias: true,
  powerPreference: "high-performance" as const,
  preserveDrawingBuffer: true,
};

const VIEWPORT_3D_CANVAS_GL_CAPTURE_NO_ANTIALIAS = {
  alpha: false,
  antialias: false,
  powerPreference: "high-performance" as const,
  preserveDrawingBuffer: true,
};

installViewport3DThreeConsolePolicy();

/**
 * S-15: mirrors resolveViewport3DCanvasGlOptions (viewport3dVisualProfile.ts)
 * but returns one of four module-level frozen objects, because the returned
 * value is handed to R3F as the `gl` prop -- a fresh object literal per render
 * would make the canvas re-create its renderer. The user-facing
 * "Antialiasing" toggle now reaches the WebGL context here (it previously only
 * fed the EffectComposer's `multisampling`, which does not exist while both
 * post effects are off); the visual profile keeps its veto so
 * `interactive-lite` stays MSAA-free for performance.
 */
function resolveStableViewport3DCanvasGlOptions(
  profile: Viewport3DVisualProfile,
  antialiasEnabled = true,
) {
  const antialias = profile.antialias && antialiasEnabled;
  if (profile.preserveDrawingBuffer) {
    return antialias
      ? VIEWPORT_3D_CANVAS_GL_CAPTURE
      : VIEWPORT_3D_CANVAS_GL_CAPTURE_NO_ANTIALIAS;
  }
  return antialias
    ? VIEWPORT_3D_CANVAS_GL_ANTIALIAS
    : VIEWPORT_3D_CANVAS_GL_NO_ANTIALIAS;
}

function resolveViewport3DColorbarRangeLabel({
  hasBufferRange,
  hasMetadataRange,
  rangeState,
}: {
  hasBufferRange: boolean;
  hasMetadataRange: boolean;
  rangeState?: Viewport3DColorbarPlan["rangeState"];
}): string {
  if (rangeState === "stale-compatible") {
    return hasBufferRange
      ? "Previous compatible range"
      : "Loading field range";
  }
  if (rangeState === "pending") {
    return hasMetadataRange
      ? "Metadata range; rendered range pending"
      : "Loading field range";
  }
  if (rangeState === "unavailable") {
    return hasMetadataRange ? "Metadata range" : "Field range unavailable";
  }
  if (rangeState === "current") {
    if (hasBufferRange) return "Rendered range";
    if (hasMetadataRange) return "Metadata range";
    return "Loading field range";
  }
  if (hasBufferRange) return "Rendered range";
  if (hasMetadataRange) return "Metadata range";
  return "Loading field range";
}

const retainedViewport3DColorbarPlansBySlot = new Map<
  string,
  readonly Viewport3DColorbarPlan[]
>();
const retainedViewport3DColorbarPlanListeners = new Set<() => void>();

function sameViewport3DColorbarPlans(
  left: readonly Viewport3DColorbarPlan[],
  right: readonly Viewport3DColorbarPlan[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const plan = left[index];
    const other = right[index];
    if (!plan || !other) return false;
    if (
      plan.groupKey !== other.groupKey ||
      plan.range?.min !== other.range?.min ||
      plan.range?.max !== other.range?.max ||
      plan.rangeState !== other.rangeState ||
      plan.targetIds.length !== other.targetIds.length
    ) {
      return false;
    }
    for (let targetIndex = 0; targetIndex < plan.targetIds.length; targetIndex += 1) {
      if (plan.targetIds[targetIndex] !== other.targetIds[targetIndex]) {
        return false;
      }
    }
  }
  return true;
}

function subscribeRetainedViewport3DColorbarPlans(
  listener: () => void,
): () => void {
  retainedViewport3DColorbarPlanListeners.add(listener);
  return () => {
    retainedViewport3DColorbarPlanListeners.delete(listener);
  };
}

function getRetainedViewport3DColorbarPlans(
  slotId: string,
): readonly Viewport3DColorbarPlan[] {
  return (
    retainedViewport3DColorbarPlansBySlot.get(slotId) ??
    EMPTY_VIEWPORT_3D_COLORBAR_PLANS
  );
}

function setRetainedViewport3DColorbarPlans(
  slotId: string,
  plans: readonly Viewport3DColorbarPlan[],
): void {
  const current = getRetainedViewport3DColorbarPlans(slotId);
  if (sameViewport3DColorbarPlans(current, plans)) return;
  if (plans.length > 0) {
    retainedViewport3DColorbarPlansBySlot.set(slotId, plans);
  } else {
    retainedViewport3DColorbarPlansBySlot.delete(slotId);
  }
  for (const listener of retainedViewport3DColorbarPlanListeners) {
    listener();
  }
}

async function completePendingViewport3DCapture(
  canvasRef: { current: HTMLCanvasElement | null },
  pendingCaptureRevisionRef: { current: number | null },
  captureRevision: number,
): Promise<void> {
  if (
    captureRevision <= 0 ||
    pendingCaptureRevisionRef.current !== captureRevision
  ) {
    return;
  }
  const canvas = canvasRef.current;
  if (!canvas) return;
  pendingCaptureRevisionRef.current = null;
  const { appearance } = viewport3dStore.getSnapshot();
  let url: string | null = null;
  try {
    const blob = await captureViewport3DImage(canvas, {
      scale: appearance.exportScale,
      background: appearance.exportBackground,
      annotations: appearance.exportAnnotations,
    });
    url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.download = "fullmag-viewport-3d.png";
    link.href = url;
    link.click();
  } catch (error) {
    viewport3dStore.setCaptureError(error instanceof Error ? error.message : "Viewport PNG export failed.");
  } finally {
    if (url) URL.revokeObjectURL(url);
    viewport3dStore.completeCapture();
  }
}

function useMeshSizeHistogramHighlight(
  bus: ModuleProps["kernel"]["bus"],
): MeshSizeHistogramHighlight | null {
  const [highlight, setHighlight] =
    useState<MeshSizeHistogramHighlight | null>(null);
  useEffect(
    () =>
      bus.subscribe("viewport:mesh-size-bin-hovered", (event) => {
        setHighlight((current) =>
          retainViewport3DMeshSizeHighlight(current, event.highlight),
        );
      }),
    [bus],
  );
  return highlight;
}

interface Viewport3DFrameProps
  extends Omit<
    Viewport3DSceneProps,
    | "colors"
    | "moveDraftResetRevision"
    | "moveToolObjectId"
    | "onMoveCommit"
    | "onBeginGesture"
    | "onMoveGestureActiveChange"
    | "orbitDebugAngles"
    | "orbitDebugCommitRevision"
    | "orbitDebugRevision"
  > {
  getExportSource: () => Promise<ViewportModelSource>;
  analysisOverlayQuantityId: string | null;
  artifactInspectionDefinitions: ReadonlyArray<{ id?: string; source_object_id?: string }>;
  artifactPresentationTarget: VisualizationTargetRef | null;
  cameraOwnerKey: string;
  cameraResource: VisualizationStateResource["camera"] | null;
  clientReady: boolean;
  colors: Viewport3DSceneProps["colors"] | null;
  colorsUnavailable: boolean;
  captureRevision: number;
  canvasContextProfileId: Viewport3DSceneProps["visualProfileId"];
  diagnostics: string;
  domainSummary: string;
  effectAntialias: boolean;
  fieldDataIssue: Viewport3DFieldDataIssue | null;
  fieldPresentationFreshness: Viewport3DFieldPresentationFreshness | null;
  preparedMagnetizationLabel: string | null;
  fieldRefresh: Viewport3DFieldRefreshState;
  fdmFieldIdentityCompatible: boolean;
  fdmSelectionCellOrdinal: number | null;
  fdmSelectionAnnouncement: string | null;
  hysteresisReplayGlyphModel: HysteresisReplayGlyphModel | null;
  hysteresisReplayTarget: HysteresisStepViewportTarget | null;
  inspectRevision: number;
  kernel: ModuleProps["kernel"];
  meshQualityMetric: MeshQualityColorMetric;
  meshQualityRange: MeshQualityRange | null;
  onCameraPatch: (
    patch: NonNullable<VisualizationStatePatch["camera"]>,
  ) => void;
  onClearSelection: () => void;
  onReturnToCurrentView: () => void;
  onFdmUniverseOverlayVisibilityChange: (visible: boolean) => void;
  onFrozenSpinsOverlayVisibilityChange: (visible: boolean) => void;
  onRegionOverlaySourceChange: (source: RegionDiagnosticOverlaySource) => void;
  onRegionOverlayVisibilityChange: (visible: boolean) => void;
  regionDiagnosticOverlayState: RegionDiagnosticOverlayState;
  quantityId: string;
  /** Human label for the HUD: the mode while a mode field is the viewport quantity. */
  quantityLabel: string;
  renderedMeshRevision: number | string | null;
  scalarColorPalette: string;
  savedViewportActive: boolean;
  savedFieldUnit: string | null;
  sessionIdentity: SessionResourceIdentity | null;
  sessionDiscretization: "fdm" | "fem" | null;
  selectedLabel: string;
  slotId: ModuleProps["slotId"];
  status: string;
  topologyRevision: number | string | null;
  visualizationEffectiveRenderMode: string;
  visualizationError: string | null;
  visualizationDebugSource: Viewport3DVisualizationDebugSource;
}

export default function Viewport3DModule(props: ModuleProps) {
  const saved = useSavedResultsPlaybackSelection();
  return saved ? <SavedResultsPlaybackViewport /> : <LiveViewport3DModule {...props} />;
}

function LiveViewport3DModule({
  kernel,
  moduleId,
  slotId,
}: ModuleProps) {
  const { clientReady, colors, colorsUnavailable } = useViewport3DColors();
  const sessionIdentity = useSessionResourceIdentity();
  const selection = useSelectionSelector((state) => state, {
    isEqual: selectionSnapshotEquals,
  });
  const { presentation: savedPresentation, projectId: savedProjectId } = useSavedFieldPresentation();
  const savedViewportSelectionActive = savedPresentation !== null || (
    selection.kind === "results.materialized_dataset" && selection.ref?.type === "materialized-dataset"
  );
  useEffect(() => {
    if (savedPresentation && savedProjectId && savedProjectId !== savedPresentation.selection.projectId) {
      kernel.visualization.clearSavedFieldPresentation();
    }
  }, [kernel.visualization, savedPresentation, savedProjectId]);
  const { select, clear } = useSelectionActions(moduleId);
  const tracker = useViewport3DResourceTracker();
  const sessionIdentityKey = sessionIdentity ? sessionResourceIdentityKey(sessionIdentity) : null;
  const previousSessionIdentityKeyRef = useRef(sessionIdentityKey);
  useEffect(() => {
    if (previousSessionIdentityKeyRef.current === sessionIdentityKey) return;
    previousSessionIdentityKeyRef.current = sessionIdentityKey;
    tracker.recordDirtyFrame("session-identity-changed");
  }, [sessionIdentityKey, tracker]);
  const reportWorkerRuntimeCounts = useCallback(
    (counts: Parameters<typeof tracker.setWorkerRuntimeCounts>[0]) =>
      tracker.setWorkerRuntimeCounts(counts),
    [tracker],
  );
  useViewport3DWorkerRuntime(reportWorkerRuntimeCounts);
  const resourceCounts = useViewport3DResourceCounts(tracker);
  useEffect(() => {
    tracker.publishDebugResourceCounts();
  }, [resourceCounts, tracker]);
  const commandState = useViewport3DCommandState();
  const meshSizeHighlight = useMeshSizeHistogramHighlight(kernel.bus);
  const [regionDiagnosticOverlayState, setRegionDiagnosticOverlayState] =
    useState<RegionDiagnosticOverlayState>(
      DEFAULT_REGION_DIAGNOSTIC_OVERLAY_STATE,
    );
  const [frozenSpinsOverlayVisible, setFrozenSpinsOverlayVisible] =
    useState(true);
  const meshHistogramBinElements = useMeshHistogramBinElementsResource(
    meshSizeHighlight?.resource ?? null,
    { enabled: !savedViewportSelectionActive },
  );
  const {
    domainId,
    savedViewportCamera,
    ...sceneModel
  } = useViewport3DSceneModel({
    commandState,
    colors,
    meshSizeHighlight,
    meshSizeHighlightSelection: meshSizeHighlight
      ? meshHistogramBinElements.data
      : null,
    resourceCounts,
    selection,
    tracker,
  });
  const solverStatus = useSolverStatusResource({ enabled: true });
  const runtimeFrozenSpins = solverStatus.data?.frozen_spins ?? null;
  const runtimeFrozenSpinsFieldRequest = useMemo(
    () => ({
      consumers: ["frozen-spins-runtime-overlay"],
      quantityId: "frozen_spins",
      query: { component: "full", scope_kind: "full" } as const,
      requestId: "frozen_spins-runtime-overlay",
    }),
    [],
  );
  const runtimeFrozenSpinsFieldEnabled = Boolean(
    !sceneModel.savedViewportActive &&
      frozenSpinsOverlayVisible &&
      solverStatus.data?.run_id &&
      runtimeFrozenSpins?.mask_sha256 &&
      runtimeFrozenSpins.topology_fingerprint &&
      runtimeFrozenSpins.frozen_site_count > 0 &&
      sceneModel.publishedModelQuantityIds.has(runtimeFrozenSpinsFieldRequest.quantityId),
  );
  const runtimeFrozenSpinsFieldResource = useViewport3DFieldVectorRequest(
    runtimeFrozenSpinsFieldRequest,
    runtimeFrozenSpinsFieldEnabled,
  );
  const runtimeFrozenSpinsFieldVector = runtimeFrozenSpinsFieldEnabled
    ? runtimeFrozenSpinsFieldResource.data
    : null;
  const objectEditSnapshot = useObjectEditSelector(kernel.objectEditSession);
  const primitiveModelWithPlacementDraft = useMemo(
    () => withObjectPlacementDraftPreview(
      sceneModel.primitiveModel,
      objectEditSnapshot.draft,
      sceneModel.selectedObjectId,
    ),
    [
      objectEditSnapshot.draft,
      sceneModel.primitiveModel,
      sceneModel.selectedObjectId,
    ],
  );
  const {
    beginInteraction: beginSavedCameraInteraction,
    endInteraction: endSavedCameraInteraction,
    patchCamera: patchSavedCamera,
    saveCameraState: saveSavedCameraState,
  } = savedViewportCamera;
  const frozenSpinsPreviewId = useFrozenSpinsActivePreviewId();
  const frozenSpinsPreview = useFrozenSpinsPreviewResource(
    frozenSpinsPreviewId ?? "",
    {
      enabled:
        !sceneModel.savedViewportActive && frozenSpinsPreviewId !== null,
    },
  );
  const frozenSpinsMaskId = !sceneModel.savedViewportActive && frozenSpinsPreview.data
    ? frozenSpinsMaskIdFromResource(frozenSpinsPreview.data.mask_resource)
    : null;
  const frozenSpinsMask = useFrozenSpinsMaskResource(
    frozenSpinsMaskId ?? "",
    {
      enabled: !sceneModel.savedViewportActive && frozenSpinsMaskId !== null,
    },
  );
  const femFrozenSpinsCarrier = useMemo(() => {
    const topology = sceneModel.topologyModel;
    if (
      !topology ||
      !topology.meshTopologyHash ||
      topology.nodeCount <= 0 ||
      topology.positions.length !== topology.nodeCount * 3
    ) {
      return null;
    }
    return {
      schemaVersion: "fullmag.fem-local-node-render.v1" as const,
      carrierFingerprint: topology.meshTopologyHash,
      meshFingerprint: topology.meshTopologyHash,
      feSpaceOrder: 1,
      vectorOrdering: "by_nodes" as const,
      localNodeCount: topology.nodeCount,
      renderVertexPositions: topology.positions,
    };
  }, [sceneModel.topologyModel]);
  const frozenSpinsOverlayModel = useMemo(
    () => {
      if (sceneModel.savedViewportActive) return null;
      return buildFrozenSpinsOverlayModel({
        current: frozenSpinsPreview.data?.current ?? false,
        expectedTopologyFingerprint:
          frozenSpinsPreview.data?.resolved.topology_fingerprint ?? null,
        fdmDomain: sceneModel.fdmDomain,
        // FEM frozen masks use the backend's local-node AoS state space. The
        // published FMMT topology uses the same local-node ordering for P1.
        femCarrier: femFrozenSpinsCarrier,
        mask: frozenSpinsMask.data,
        previewId: frozenSpinsPreviewId ?? "",
      });
    },
    [
      frozenSpinsMask.data,
      frozenSpinsPreview.data,
      frozenSpinsPreviewId,
      femFrozenSpinsCarrier,
      sceneModel.savedViewportActive,
      sceneModel.fdmDomain,
    ],
  );
  const runtimeFrozenSpinsRunId = solverStatus.data?.run_id ?? "";
  const runtimeFrozenSpinsFieldRevision =
    runtimeFrozenSpinsFieldResource.payloadRevision ?? "field";
  const runtimeFrozenSpinsPreviewId = runtimeFrozenSpinsRunId
    ? `runtime:${runtimeFrozenSpinsRunId}:${runtimeFrozenSpins?.mask_sha256 ?? runtimeFrozenSpinsFieldRevision}`
    : "";
  const runtimeFrozenSpinsOverlayModel = useMemo(
    () =>
      buildFrozenSpinsOverlayModelFromField({
        current: true,
        expectedTopologyFingerprint: runtimeFrozenSpins?.topology_fingerprint,
        fdmDomain: sceneModel.fdmDomain,
        femCarrier: femFrozenSpinsCarrier,
        fieldVector: runtimeFrozenSpinsFieldVector,
        maskSha256:
          runtimeFrozenSpins?.mask_sha256 ?? runtimeFrozenSpinsFieldRevision,
        previewId: runtimeFrozenSpinsPreviewId,
      }),
    [
      femFrozenSpinsCarrier,
      runtimeFrozenSpins,
      runtimeFrozenSpinsFieldRevision,
      runtimeFrozenSpinsFieldVector,
      runtimeFrozenSpinsPreviewId,
      sceneModel.fdmDomain,
    ],
  );
  const effectiveFrozenSpinsOverlayModel =
    frozenSpinsOverlayModel ?? runtimeFrozenSpinsOverlayModel;
  const { onSelectDomain, onSelectFdmCell, onSelectFdmTarget, onSelectFdmUniverseOutsideSupport, onSelectObject, onSelectPart, onSelectPlanarMonitor, onSelectRegion } =
    useViewport3DSelectionHandlers({
      domainId,
      fdmDomain: sceneModel.fdmDomain,
      fdmInstanceModel: sceneModel.fdmInstanceModel,
      fdmRegionMembership: sceneModel.fdmRegionMembership,
      fdmRegionMembershipBinary: sceneModel.fdmRegionMembershipBinary,
      semanticTargetCatalog: sceneModel.semanticTargetCatalog,
      select,
  });
  const fdmSelectionAnnouncement = useMemo(
    () =>
      resolveViewport3DFdmSelectionAnnouncement({
        domainGenerationId:
          sceneModel.visualizationDebugSource.fullFieldBufferIdentity
            ?.currentDomainGenerationId ?? null,
        fieldIdentityCompatible: sceneModel.fdmFieldIdentityCompatible,
        fieldRevision:
          sceneModel.fieldRefresh.status === "ready"
            ? sceneModel.fieldRefresh.payloadRevision ??
              sceneModel.fieldRefresh.revision
            : null,
        membership: sceneModel.fdmRegionMembership,
        quantityId: sceneModel.quantityId,
        selection:
          selection.ref?.type === "fdm-cell" ? selection.ref : null,
      }),
    [
      sceneModel.fdmFieldIdentityCompatible,
      sceneModel.fdmRegionMembership,
      sceneModel.fieldRefresh.payloadRevision,
      sceneModel.fieldRefresh.revision,
      sceneModel.fieldRefresh.status,
      sceneModel.quantityId,
      sceneModel.visualizationDebugSource.fullFieldBufferIdentity,
      selection.ref,
    ],
  );
  const fdmSelectionCellOrdinal =
    fdmSelectionAnnouncement && selection.ref?.type === "fdm-cell"
      ? Number(selection.ref.cellOrdinal)
      : null;
  useViewport3DMeshCellAuditSelection({
    onSelectPart,
    topologyModel: currentViewport3DMeshCellAuditTopology(
      sceneModel.topologyModel,
      sceneModel.topologyFreshness,
    ),
  });
  const patchCameraState = useCallback(
    (patch: NonNullable<VisualizationStatePatch["camera"]>) => {
      if (sceneModel.savedViewportActive) {
        patchSavedCamera(patch);
        return;
      }
      kernel.cameraRegistry.patchCamera(patch);
      if (patch.position && patch.target) {
        const nextCamera = {
          position: toCameraTuple(patch.position),
          target: toCameraTuple(patch.target),
          up: toCameraTuple(patch.up ?? VIEWPORT_3D_WORLD_UP),
        };
        if (patch.projection || "orthographic_scale" in patch) {
          viewport3dStore.setCameraView({
            camera: nextCamera,
            orthographicScale: patch.orthographic_scale,
            projection:
              patch.projection ??
              viewport3dStore.getSnapshot().widgets.cameraProjection,
          });
        } else {
          viewport3dStore.setCamera(nextCamera);
        }
      }
      if (patch.projection) {
        viewport3dStore.setCameraProjection(patch.projection);
      }
      if ("orthographic_scale" in patch) {
        viewport3dStore.setCameraOrthographicScale(patch.orthographic_scale ?? null);
      }
    },
    [kernel.cameraRegistry, patchSavedCamera, sceneModel.savedViewportActive],
  );
  const saveCameraState = useCallback(
    (camera: Viewport3DCameraChange, epoch?: number) => {
      if (sceneModel.savedViewportActive) {
        saveSavedCameraState(camera, epoch);
        return;
      }
      const accepted = kernel.cameraRegistry.patchCamera(
        buildViewport3DCameraRegistryPatch(camera),
        epoch,
      );
      const registry = kernel.cameraRegistry.getSnapshot();
      if (accepted) {
        viewport3dStore.setCameraView({
          camera: {
            position: toCameraTuple(registry.camera.position),
            target: toCameraTuple(registry.camera.target),
            up: toCameraTuple(registry.camera.up),
          },
          orthographicScale: registry.camera.orthographic_scale,
          projection: registry.camera.projection,
        });
      }
      recordViewport3DCameraTrajectorySample({
        active: epoch !== undefined,
        committedCamera: registry.camera,
        epoch: epoch ?? -1,
        frame: registry.localVersion,
        liveCamera: null,
        reason: "commit",
        registry: {
          dirty: registry.dirty,
          lastRemoteRevision: registry.lastRemoteRevision,
          localVersion: registry.localVersion,
          persistedShadow: registry.persistedShadow,
        },
        source: null,
        storeCamera: viewport3dStore.getSnapshot().camera,
        timestamp: performance.now(),
      });
    },
    [kernel.cameraRegistry, saveSavedCameraState, sceneModel.savedViewportActive],
  );
  const cameraFieldUpdateHold = useMemo(() => createViewport3DInteractionFieldHold(), []);
  const beginCameraInteraction = useCallback((epoch?: number) => {
    cameraFieldUpdateHold.begin(epoch);
    if (sceneModel.savedViewportActive) {
      beginSavedCameraInteraction(epoch);
    } else {
      kernel.cameraRegistry.beginInteraction(epoch);
    }
  }, [cameraFieldUpdateHold, beginSavedCameraInteraction, kernel.cameraRegistry, sceneModel.savedViewportActive]);
  const endCameraInteraction = useCallback((epoch?: number) => {
    if (sceneModel.savedViewportActive) {
      endSavedCameraInteraction(epoch);
    } else {
      kernel.cameraRegistry.endInteraction(epoch);
    }
    cameraFieldUpdateHold.end(epoch);
  }, [cameraFieldUpdateHold, endSavedCameraInteraction, kernel.cameraRegistry, sceneModel.savedViewportActive]);
  useEffect(
    () => () => cameraFieldUpdateHold.end(),
    [cameraFieldUpdateHold],
  );
  useEffect(() => {
    if (!sceneModel.savedViewportActive) return;
    viewport3dStore.setCameraView({
      camera: sceneModel.cameraState,
      orthographicScale: sceneModel.cameraOrthographicScale,
      projection: sceneModel.cameraProjection,
    });
  }, [
    sceneModel.cameraOrthographicScale,
    sceneModel.cameraProjection,
    sceneModel.cameraState,
    sceneModel.savedViewportActive,
  ]);
  const changeRegionOverlaySource = useCallback(
    (source: RegionDiagnosticOverlaySource) => {
      setRegionDiagnosticOverlayState((state) => ({ ...state, source }));
    },
    [],
  );
  const changeRegionOverlayVisibility = useCallback((visible: boolean) => {
    setRegionDiagnosticOverlayState((state) => ({ ...state, visible }));
  }, []);
  const changeFdmUniverseOverlayVisibility = useCallback(
    (visible: boolean) => {
      kernel.visualization.patchTarget(AIRBOX_VISUALIZATION_TARGET, {
        visible,
      });
    },
    [kernel.visualization],
  );

  return (
    <Viewport3DErrorBoundary diagnosticRecorder={kernel.diagnosticRecorder}>
      {viewport3DAuditRenderErrorInjectionEnabledFromBrowserConfig() ? (
        <Viewport3DAuditRenderErrorInjection />
      ) : (
        <WorkspaceRenderProfiler id="Viewport3DModule">
        <Viewport3DFrame
      {...sceneModel}
      analysisOverlayQuantityId={sceneModel.analysisOverlay?.fieldId ?? null}
      primitiveModel={primitiveModelWithPlacementDraft ?? null}
      getExportSource={async () => {
        // Capture numbers before loading the exporter. The clocks keep moving while it loads.
        const overlay = sceneModel.analysisOverlay;
        const analysisOverlay = overlay
          ? {
              ...overlay,
              visualizationPhaseRad: kernel.analysisFieldOverlay.getDisplayedPhaseRadForOverlay(overlay),
            }
          : null;
        const modeCompositionPhaseByLayerId = new Map(
          Array.from(sceneModel.modeCompositionPhaseUniformByLayerId, ([layerId, { value }]) =>
            [layerId, value] as const,
          ),
        );
        const { extractViewport3DExportSource } = await import("./export/extractViewport3DExportSource");
        return extractViewport3DExportSource({
          ...sceneModel,
          analysisOverlay,
          modeCompositionPhaseByLayerId,
          domainId,
          topology: sceneModel.topology ?? null,
          primitiveModel: primitiveModelWithPlacementDraft ?? null,
          airboxSettings: sceneModel.savedViewportActive ? null : sceneModel.airboxSettings,
          includeHiddenAirbox: !sceneModel.savedViewportActive,
          vectorFallbackColor: colors ? String(colors.field) : undefined,
          vectorLayersEnabled: viewport3DVectorLayersEnabledFromBrowserConfig(),
          vectorOpacityScale: resolveViewport3DMaterialProfile(
            getViewport3DVisualProfile(sceneModel.visualProfileId),
          ).glyphs.opacityScale,
        });
      }}
      clientReady={clientReady}
      colors={colors}
      colorsUnavailable={colorsUnavailable}
      cameraOwnerKey={`${sessionIdentityKey ?? "no-session"}:${sceneModel.savedViewportActive ? sceneModel.savedFieldIdentity ?? "saved" : "live"}`}
      dimensionFrameAnnotation={commandState.widgets.dimensionFrameAnnotation}
      dimensionFrameDensity={commandState.widgets.dimensionFrameDensity}
      dimensionFrameMode={commandState.widgets.dimensionFrameMode}
      effectAntialias={commandState.widgets.effectAntialias}
      fitRevision={commandState.fitRevision}
      kernel={kernel}
      fdmSelectionCellOrdinal={fdmSelectionCellOrdinal}
      fdmSelectionAnnouncement={fdmSelectionAnnouncement}
      onCameraPatch={patchCameraState}
      onClearSelection={clear}
      onReturnToCurrentView={() => { returnToCurrentFieldView(kernel.visualization, kernel.selection, moduleId); }}
      onFdmUniverseOverlayVisibilityChange={changeFdmUniverseOverlayVisibility}
      frozenSpinsOverlayModel={effectiveFrozenSpinsOverlayModel}
      frozenSpinsOverlayVisible={frozenSpinsOverlayVisible}
      onFrozenSpinsOverlayVisibilityChange={setFrozenSpinsOverlayVisible}
      onRegionOverlaySourceChange={changeRegionOverlaySource}
      onRegionOverlayVisibilityChange={changeRegionOverlayVisibility}
      onSelectDomain={onSelectDomain}
      onSelectFdmCell={onSelectFdmCell}
      onSelectFdmTarget={onSelectFdmTarget}
      onSelectFdmUniverseOutsideSupport={onSelectFdmUniverseOutsideSupport}
      onSelectObject={onSelectObject}
      onSelectPlanarMonitor={onSelectPlanarMonitor}
      onSelectPart={onSelectPart}
      onSelectRegion={onSelectRegion}
      onCameraChange={saveCameraState}
      onCameraInteractionEnd={endCameraInteraction}
      onCameraInteractionStart={beginCameraInteraction}
      captureRevision={commandState.captureRevision}
      canvasContextProfileId={commandState.captureReturnProfileId ?? commandState.visualProfileId}
      inspectEnabled={commandState.widgets.inspectEnabled}
      inspectRevision={commandState.widgets.inspectRevision}
      requestDiagnostics={kernel.diagnostics}
      resetCameraRevision={commandState.resetCameraRevision}
      regionDiagnosticOverlayState={regionDiagnosticOverlayState}
      regionOverlayMode={regionDiagnosticOverlayMode(regionDiagnosticOverlayState)}
      rotationMode={commandState.widgets.rotationMode}
      savedViewportActive={sceneModel.savedViewportActive}
      scaleLabelsVisible={commandState.widgets.scaleLabelsVisible}
      scaleUnitMode={commandState.widgets.scaleUnitMode}
      sessionIdentity={sessionIdentity}
      slotId={slotId}
      tracker={tracker}
      viewCubeVisible={commandState.widgets.viewCubeVisible}
        />
        </WorkspaceRenderProfiler>
      )}
    </Viewport3DErrorBoundary>
  );
}

function Viewport3DAuditRenderErrorInjection(): never {
  throw new Error("Maximum update depth exceeded (viewport audit injection)");
}

function useViewport3DMeshCellAuditSelection({
  onSelectPart,
  topologyModel,
}: {
  onSelectPart: (partSelection: Viewport3DPartSelection) => void;
  topologyModel: Viewport3DSceneProps["topologyModel"];
}) {
  useEffect(() => {
    if (process.env.NODE_ENV === "production" && process.env.NEXT_PUBLIC_AUDIT_BUILD !== "1") {
      return undefined;
    }
    const config = (window as Window & {
      __FULLMAG_CONFIG__?: { enableAuditHooks?: unknown };
    }).__FULLMAG_CONFIG__;
    if (config?.enableAuditHooks !== true) return undefined;
    if (!topologyModel) return undefined;

    const list = () => listViewport3DMeshCellSelections(topologyModel);
    const selectMeshCell = (request: Viewport3DMeshCellSelectionRequest) => {
      const selection = resolveViewport3DMeshCellSelection(topologyModel, request);
      if (!selection || !selection.elementFamily || !selection.globalCellOrdinal) {
        throw new Error(
          `Viewport mesh-cell audit selection was not found: ${JSON.stringify(request)}`,
        );
      }
      onSelectPart(selection);
      return {
        carrier: request.carrier,
        carrierPartId: selection.carrierPartId,
        elementFamily: selection.elementFamily,
        globalCellOrdinal: selection.globalCellOrdinal,
      };
    };
    window.__FULLMAG_LIST_VIEWPORT_3D_MESH_CELLS__ = list;
    window.__FULLMAG_SELECT_VIEWPORT_3D_MESH_CELL__ = selectMeshCell;
    return () => {
      if (window.__FULLMAG_LIST_VIEWPORT_3D_MESH_CELLS__ === list) {
        delete window.__FULLMAG_LIST_VIEWPORT_3D_MESH_CELLS__;
      }
      if (window.__FULLMAG_SELECT_VIEWPORT_3D_MESH_CELL__ === selectMeshCell) {
        delete window.__FULLMAG_SELECT_VIEWPORT_3D_MESH_CELL__;
      }
    };
  }, [onSelectPart, topologyModel]);
}

function useViewport3DSelectionHandlers({
  domainId,
  fdmDomain,
  fdmInstanceModel,
  fdmRegionMembership,
  fdmRegionMembershipBinary,
  semanticTargetCatalog,
  select,
}: {
  domainId: string | null | undefined;
  fdmDomain: { shape: readonly [number, number, number] } | null;
  fdmInstanceModel: import("./layers/FdmCuboidLayer").FdmCuboidInstanceModel | null | undefined;
  fdmRegionMembership: import("@/kernel/api/apiTypes").FdmRegionMembershipResource | null | undefined;
  fdmRegionMembershipBinary: import("@/kernel/api/codecs").DecodedFdmRegionMembership | null | undefined;
  semanticTargetCatalog: SemanticRenderTargetCatalog;
  select: ReturnType<typeof useSelectionActions>["select"];
}) {
  const onSelectDomain = useCallback(() => {
    select(viewportSelectionForDomain(domainId));
  }, [domainId, select]);
  const onSelectFdmCell = useCallback(
    (instanceId: number) => {
      const selection = viewportSelectionForFdmCell({
        binary: fdmRegionMembershipBinary,
        domainShape: fdmDomain?.shape,
        instanceId,
        membership: fdmRegionMembership,
        model: fdmInstanceModel,
      });
      // Missing/stale/legacy identity deliberately produces no selection.
      if (selection) select(selection);
    },
    [fdmDomain?.shape, fdmInstanceModel, fdmRegionMembership, fdmRegionMembershipBinary, select],
  );
  const onSelectFdmUniverseOutsideSupport = useCallback(() => {
    select(viewportSelectionForFdmUniverseOutsideSupport());
  }, [select]);
  const onSelectFdmTarget = useCallback(
    (target: VisualizationTargetRef) => {
      const selection = viewportSelectionForFdmTarget(target);
      if (selection) select(selection);
    },
    [select],
  );
  const onSelectPart = useCallback(
    (partSelection: Viewport3DPartSelection) => {
      const address = resolveSemanticTargetForMeshPart(
        semanticTargetCatalog,
        partSelection.part,
      );
      if (!address) return;
      select(
        viewportSelectionForMeshPart(address, {
          boundaryFaceIndex: partSelection.boundaryFaceIndex,
          carrierPartId: partSelection.carrierPartId,
          elementFamily: partSelection.elementFamily,
          globalCellOrdinal: partSelection.globalCellOrdinal,
          label: partSelection.label,
        }),
      );
    },
    [select, semanticTargetCatalog],
  );
  const onSelectObject = useCallback(
    (object: Viewport3DPrimitiveObject) => {
      select(viewportSelectionForObject(object));
    },
    [select],
  );
  const onSelectPlanarMonitor = useCallback(
    (monitorId: string, isDraft: boolean) => {
      select({
        kind: isDraft ? "model.planar.monitor.draft" : "model.planar.monitor",
        label: isDraft ? "Planar monitor draft" : monitorId,
        nodeId: isDraft ? "model:definitions:planar-monitors:draft" : `model:definitions:planar-monitors:${monitorId}`,
        objectId: null,
        ref: {
          ...(isDraft
            ? { draftId: "draft", kind: "model.planar.monitor.draft" as const, nodeId: "model:definitions:planar-monitors:draft", type: "planar-monitor-draft" as const, visualizationTargetId: "planar-monitor:draft" }
            : { kind: "model.planar.monitor" as const, monitorId, nodeId: `model:definitions:planar-monitors:${monitorId}`, type: "planar-monitor" as const, visualizationTargetId: `planar-monitor:${monitorId}` as `planar-monitor:${string}` }),
        },
      });
    },
    [select],
  );
  const onSelectRegion = useCallback(
    (region: RegionOverlaySelection) => {
      select(viewportSelectionForRegion(region));
    },
    [select],
  );

  return {
    onSelectDomain,
    onSelectFdmCell,
    onSelectFdmUniverseOutsideSupport,
    onSelectFdmTarget,
    onSelectObject,
    onSelectPlanarMonitor,
    onSelectPart,
    onSelectRegion,
  };
}

const Viewport3DFrame = memo(function Viewport3DFrame({
  analysisOverlayQuantityId,
  artifactInspectionDefinitions,
  artifactPresentationTarget,
  captureRevision,
  canvasContextProfileId,
  cameraOwnerKey,
  cameraResource,
  clientReady,
  colors,
  colorsUnavailable,
  diagnostics,
  domainSummary,
  effectAntialias,
  fieldDataIssue,
  fieldPresentationFreshness,
  preparedMagnetizationLabel,
  fieldRefresh,
  fdmSelectionCellOrdinal,
  fdmSelectionAnnouncement,
  hysteresisReplayGlyphModel,
  hysteresisReplayTarget,
  inspectRevision,
  getExportSource,
  kernel,
  meshQualityMetric,
  meshQualityRange,
  onCameraPatch,
  onClearSelection,
  onReturnToCurrentView,
  onFdmUniverseOverlayVisibilityChange,
  onFrozenSpinsOverlayVisibilityChange,
  onRegionOverlaySourceChange,
  onRegionOverlayVisibilityChange,
  regionDiagnosticOverlayState,
  quantityId,
  quantityLabel,
  savedViewportActive,
  savedFieldIdentity,
  savedFieldUnit,
  sessionIdentity,
  sessionDiscretization,
  selectedLabel,
  slotId,
  status,
  visualizationEffectiveRenderMode,
  visualizationError,
  visualizationDebugSource,
  ...sceneProps
}: Viewport3DFrameProps) {
  const inspectorDestination = useViewport3DInspectorDestination();
  const onViewCommand = useCallback((id: string) => {
    void kernel.commands.execute(id, { source: "inspector", layout: kernel.layout, selection: kernel.selection, cameraRegistry: kernel.cameraRegistry });
  }, [kernel]);
  useLayoutEffect(() => registerViewport3DProjectionOwner(sceneProps.cameraProjection, onCameraPatch), [cameraOwnerKey, onCameraPatch, sceneProps.cameraProjection]);
  const savedScopeKey = savedFieldIdentity ?? null;
  const visibleSavedScaleStore = useMemo(
    () => createViewport3DVisibleColorScaleStore(savedScopeKey),
    [savedScopeKey],
  );
  const visibleSavedScales = useSyncExternalStore(
    visibleSavedScaleStore.subscribe,
    visibleSavedScaleStore.getSnapshot,
    visibleSavedScaleStore.getSnapshot,
  );
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const antennaFieldOverlay = useAntennaFieldOverlay(!savedViewportActive);
  const artifactTarget = sceneProps.primitiveModel?.objects.find(object => object.objectId === sceneProps.selectedObjectId);
  const artifactSettings = artifactPresentationTarget?.kind === "airbox" ? sceneProps.airboxSettings :
    artifactTarget ? sceneProps.getObjectSettings(artifactTarget) : sceneProps.fdmSettings;
  const artifactQuantityId = artifactPresentationTarget?.kind === "airbox" ? artifactSettings.activeQuantityId : quantityId;
  const artifactField = useArtifactFieldOverlay(artifactQuantityId, sceneProps.selectedObjectId, artifactSettings, Boolean(antennaFieldOverlay), artifactInspectionDefinitions, artifactPresentationTarget);
  const ownUniverseInspection = artifactPresentationTarget?.kind === "airbox" && artifactField.historical;
  const artifactBounds = ownUniverseInspection && artifactField.bounds ? artifactField.bounds : sceneProps.bounds;
  const liveQuantityDataAvailable = hasViewport3DQuantityData(quantityId, {
    fieldModel: sceneProps.fieldModel,
    fieldVectors: [visualizationDebugSource.fullFieldVector, sceneProps.fdmAirboxFieldVector, sceneProps.fdmMultilayerAirboxView?.fieldVector,
      ...sceneProps.fdmTargetViews.map(view => view.fieldVector), ...sceneProps.fdmNativeLayerViews.map(view => view.fieldVector)],
    fieldBuffers: [sceneProps.fdmMultilayerAirboxView?.fieldBuffer, ...sceneProps.fdmTargetViews.map(view => view.fieldBuffer)],
    scalarColors: [sceneProps.fdmSurfaceColors, sceneProps.fdmVectorColors, sceneProps.fdmVectorGlyphColors,
      sceneProps.fdmMultilayerAirboxView?.surfaceColors, ...sceneProps.fdmTargetViews.map(view => view.surfaceColors),
      ...sceneProps.fdmNativeLayerViews.map(view => view.surfaceColors)],
  });
  const antennaFieldSourceLabel = antennaFieldOverlay
    ? sceneProps.primitiveModel?.objects.find(
        (object) => object.objectId === antennaFieldOverlay.intent.sourceObjectId,
      )?.label ?? antennaFieldOverlay.intent.sourceObjectId
    : null;
  const createCanvasEvents = useCallback(
    (store: Parameters<typeof createViewport3DEventManager>[0]) =>
      createViewport3DEventManager(store, () => kernel.objectMoveTool.getSnapshot() !== null),
    [kernel.objectMoveTool],
  );
  const pendingCaptureRevisionRef = useRef<number | null>(null);
  const primitiveObjectIds =
    sceneProps.primitiveModel?.objects
      .map((object) => object.objectId)
      .join(" ") ?? "";
  const colorbarSceneObjectIds = useMemo(
    () => new Set(sceneProps.primitiveModel?.objects.map((object) => object.objectId)),
    [sceneProps.primitiveModel],
  );
  const visualProfile = getViewport3DVisualProfile(
    sceneProps.visualProfileId,
  );
  const canvasDpr = resolveViewport3DCanvasDpr({
    devicePixelRatio:
      typeof window === "undefined" ? 1 : window.devicePixelRatio,
    profile: getViewport3DVisualProfile(canvasContextProfileId),
  });
  const canvasGlOptions = resolveStableViewport3DCanvasGlOptions(
    getViewport3DVisualProfile(canvasContextProfileId),
    effectAntialias,
  );
  const canvasContextKey = `viewport-3d-canvas-aa:${canvasGlOptions.antialias ? "1" : "0"}-preserve:${canvasGlOptions.preserveDrawingBuffer ? "1" : "0"}`;
  // A hidden instance tab renders nothing; the root, its WebGL context and the
  // view stay, and going back to `demand` invalidates once (ADR 0069).
  const canvasFrameloop = useInstanceTabHidden() ? "never" : VIEWPORT_3D_FRAMELOOP;
  const orbitDebugEnabled = viewport3DOrbitDebugEnabledFromBrowserConfig();
  const hysteresisReplayLabel = formatHysteresisReplayLabel(hysteresisReplayTarget);
  const orbitDebugStore = useMemo(
    () => createViewport3DOrbitDebugStore(),
    [],
  );
  const orbitDebugSnapshot = useSyncExternalStore(
    orbitDebugStore.subscribe,
    orbitDebugStore.getSnapshot,
    orbitDebugStore.getSnapshot,
  );
  const visualizationFrameCommitQueue = useMemo(
    () => createViewport3DFrameCommitQueue<Viewport3DAirboxFrameState>(),
    [],
  );
  // The field-data issue dialog opens only on explicit request; the HUD
  // banner is the non-modal, persistent indication of the issue.
  const [openedResourceIssueKey, setOpenedResourceIssueKey] =
    useState<string | null>(null);
  const [inspectHover, setInspectHover] =
    useState<Viewport3DInspectHover | null>(null);
  const moveTargetEligible = Boolean(
    sceneProps.selectedObjectId &&
      sceneProps.primitiveModel?.objects.some(
        (object) =>
          object.objectId === sceneProps.selectedObjectId &&
          object.role === "magnet",
      ),
  );
  const moveInteraction = useViewport3DObjectMoveInteraction({
    moveTargetEligible,
    selectedObjectId: sceneProps.selectedObjectId,
    sessionId: sessionIdentity?.sessionId ?? null,
  });
  const lastRenderedMeshRevision = useRef<number | string | null>(null);
  const sendVisualizationAck = useVisualizationClientAckSender({ api: kernel.api });
  const visualizationAckRevisionRef = useRef<{
    resourceFrameKey: string;
    revision: number;
  } | null>(null);
  const visualizationAckKindsRef = useRef(
    new Map<number, {
      changeKind: "data" | "style";
      resourceKey: string;
    }>(),
  );
  const visualizationDebugAdoptionRegistry = useMemo(
    () => createViewport3DRenderAdoptionRegistry(),
    [],
  );
  visualizationDebugAdoptionRegistry.setSessionIdentity(sessionIdentity);
  const visualizationDebugCandidateBuilder = useMemo(
    () =>
      createViewport3DVisualizationDebugCandidateBuilder({
        source: visualizationDebugSource,
        viewportId: slotId,
      }),
    [slotId, visualizationDebugSource],
  );
  const visualizationDebugTargetIds = useMemo(
    () => visualizationDebugSource.targets.map(({ target }) => target.id),
    [visualizationDebugSource.targets],
  );
  const visualizationDebugCarrierTargets = useMemo(() => {
    const mapping = new Map<string, string[]>();
    const appendTarget = (carrierId: string, targetId: string) => {
      const targetIds = mapping.get(carrierId) ?? [];
      if (!targetIds.includes(targetId)) targetIds.push(targetId);
      mapping.set(carrierId, targetIds);
    };
    for (const { carrierIds, target } of visualizationDebugSource.targets) {
      for (const carrierId of carrierIds) appendTarget(carrierId, target.id);
    }
    if (visualizationDebugSource.fullFieldVector) {
      for (const { carrierIds, target } of visualizationDebugSource.targets) {
        if (carrierIds.length === 0 && target.kind !== "airbox") {
          appendTarget(target.id, target.id);
        }
      }
    }
    return mapping;
  }, [visualizationDebugSource]);
  const visualizationDebugPublisher = useViewport3DVisualizationDebugPublisher({
    adoptionRegistry: visualizationDebugAdoptionRegistry,
    buildCandidate: visualizationDebugCandidateBuilder,
    carrierTargets: visualizationDebugCarrierTargets,
    controller: kernel.visualizationDebug,
    revision: [
      visualizationDebugSource.visualizationRevision ?? "none",
      sceneProps.resourceFrameKey,
    ].join("|"),
    targetIds: visualizationDebugTargetIds,
    viewportId: slotId,
  });
  const initialCameraFit = resolveViewport3DCameraFit(null);
  const canvasCamera = useMemo(
    () => ({
      far: initialCameraFit.far,
      fov: DEFAULT_VIEWPORT_3D_CAMERA_FOV_DEGREES,
      near: initialCameraFit.near,
      position: DEFAULT_VIEWPORT_3D_CAMERA_STATE.position,
      up: VIEWPORT_3D_WORLD_UP,
    }),
    [initialCameraFit.far, initialCameraFit.near],
  );
  const discretizationKind = sessionDiscretization?.toUpperCase() ?? null;
  const meshQualityLegend = resolveViewport3DMeshQualityLegend(
    sceneProps.meshQualityOverlayVisible,
    meshQualityMetric,
    meshQualityRange,
  );
  const hudSampleSummary = artifactField.model
    ? `${artifactField.model.count} owned samples · ${ownUniverseInspection ? "accepted Universe" : "historical inspection"} · source ${artifactField.model.locator.owner.object_id} · run ${artifactField.model.locator.owner.run_id} · ${artifactField.model.unit}`
    : antennaFieldOverlay
      ? `${antennaFieldOverlay.count} samples`
      : domainSummary;
  const meshSizeHighlightSummary = sceneProps.meshSizeHighlightModel
    ? `${sceneProps.meshSizeHighlightModel.label} · ${sceneProps.meshSizeHighlightModel.sampledElementCount.toLocaleString("en-US")}/${sceneProps.meshSizeHighlightModel.matchedElementCount.toLocaleString("en-US")} highlighted`
    : null;
  const colorbarTopologyModel = sceneProps.topologyModel;
  const getColorbarPartSettings = sceneProps.getPartSettings;
  const colorbarParts = useMemo<Viewport3DColorbarTargetPart[]>(
    () => [
      ...(colorbarTopologyModel?.magneticParts ?? []).map((partModel) => {
        const target = resolveVisualizationTargetForMeshPart({
          part: partModel.part,
          sceneObjectIds: colorbarSceneObjectIds,
          targetRegistry: null,
        });
        return {
          id: partModel.part.id,
          label: partModel.part.label ?? partModel.part.id,
          objectScopeId: target.kind === "object" ? target.id : null,
          role: partModel.part.role ?? null,
          settings: getColorbarPartSettings(partModel.part),
          targetKind: "part" as const,
        };
      }),
      ...(colorbarTopologyModel?.airboxParts ?? []).map((partModel) => ({
        id: partModel.part.id,
        label: partModel.part.label ?? partModel.part.id,
        role: partModel.part.role ?? null,
        settings: getColorbarPartSettings(partModel.part),
        targetKind: "airbox" as const,
      })),
      ...sceneProps.fdmTargetViews.map((view) => ({
        id: view.target.id,
        label: view.target.label ?? view.target.id,
        objectScopeId: null,
        role: null,
        settings: view.settings,
        targetKind: "fdm-domain" as const,
      })),
    ],
    [
      colorbarSceneObjectIds,
      colorbarTopologyModel,
      getColorbarPartSettings,
      sceneProps.fdmTargetViews,
    ],
  );
  const renderSurfaceAvailable = Boolean(sceneProps.topology || sceneProps.fdmDomain);
  const retainedColorbarPlans = useSyncExternalStore(
    subscribeRetainedViewport3DColorbarPlans,
    () => getRetainedViewport3DColorbarPlans(slotId),
    () => EMPTY_VIEWPORT_3D_COLORBAR_PLANS,
  );
  const savedViewportColorbarReady =
    !savedViewportActive || sceneProps.fieldModel !== null;
  const colorbarTargetPlans = useMemo(
    () =>
      savedViewportColorbarReady
        ? buildViewport3DColorbarTargetPlans({
            analysisOverlayQuantityId,
            availableQuantityIds: sceneProps.availableQuantityIds,
            fdmSettings:
              sceneProps.fdmDomain && sceneProps.fdmTargetViews.length === 0
                ? sceneProps.fdmSettings
                : null,
            parts: colorbarParts,
          })
        : [],
    [
      analysisOverlayQuantityId,
      colorbarParts,
      sceneProps.availableQuantityIds,
      sceneProps.fdmDomain,
      sceneProps.fdmSettings,
      sceneProps.fdmTargetViews.length,
      savedViewportColorbarReady,
    ],
  );
  const initialColorbarPlans = useMemo(
    () =>
      planViewport3DColorbars({
        includeInspectorRanges: true,
        targets: colorbarTargetPlans,
      }),
    [colorbarTargetPlans],
  );
  const previousColorbarPlansByGroupKey = useMemo(
    () => new Map(retainedColorbarPlans.map((plan) => [plan.groupKey, plan])),
    [retainedColorbarPlans],
  );
  const colorbarRangeStates = useMemo(
    () =>
      resolveViewport3DColorbarRangeStates({
        fdmSurfaceColors: sceneProps.fdmSurfaceColors,
        fdmTargetColorBuffers: new Map(
          sceneProps.fdmTargetViews.map((view) => [
            view.target.id,
            [view.surfaceColors, view.vectorColors],
          ]),
        ),
        fdmVectorColors: sceneProps.fdmVectorColors,
        fieldModel: sceneProps.fieldModel,
        plans: initialColorbarPlans,
      }),
    [
      initialColorbarPlans,
      sceneProps.fdmSurfaceColors,
      sceneProps.fdmTargetViews,
      sceneProps.fdmVectorColors,
      sceneProps.fieldModel,
    ],
  );
  const plannedColorbars = useMemo(
    () =>
      planViewport3DColorbars({
        previousPlans: previousColorbarPlansByGroupKey,
        rangeStatesByGroupKey: colorbarRangeStates,
        targets: colorbarTargetPlans,
      }),
    [
      colorbarRangeStates,
      colorbarTargetPlans,
      previousColorbarPlansByGroupKey,
    ],
  );
  const viewportColorbarRequested = colorbarTargetPlans.some(
    (target) => target.colorbar.viewportVisible,
  );
  const colorbarTargetPlanAvailable = Boolean(
    sceneProps.fdmDomain || colorbarTopologyModel,
  );
  const colorbarPlans = savedViewportColorbarReady
    ? resolveViewport3DColorbarPlansForRender({
        fieldIdentityCompatible: sceneProps.fdmFieldIdentityCompatible,
        planned: plannedColorbars,
        renderSurfaceAvailable,
        retained: retainedColorbarPlans,
        targetPlanAvailable: colorbarTargetPlanAvailable,
        viewportColorbarRequested,
      })
    : EMPTY_VIEWPORT_3D_COLORBAR_PLANS;
  const colorbarLabelByTargetId = useMemo(() => {
    const labels = new Map<string, string>(
      colorbarParts.map((part) => [part.id, part.label]),
    );
    if (sceneProps.fdmDomain) {
      labels.set("fdm", "FDM domain");
    }
    return labels;
  }, [colorbarParts, sceneProps.fdmDomain]);
  const colorbarLegends = useMemo(
    () =>
      resolveViewport3DColorbarLegendsFromPlans({
        labelByTargetId: colorbarLabelByTargetId,
        plans: colorbarPlans,
      }),
    [colorbarLabelByTargetId, colorbarPlans],
  );
  const displayedColorbarLegends = useMemo(() => savedViewportActive
    ? resolveSavedFieldColorbars({ scales: visibleSavedScales, scopeKey: savedScopeKey, settings: sceneProps.fallbackSettings, quantityId, unit: savedFieldUnit })
    : artifactField.historical ? resolveArtifactFieldColorbars(artifactField.model) : colorbarLegends,
  [artifactField.historical, artifactField.model, colorbarLegends, quantityId, savedFieldUnit, savedViewportActive, savedScopeKey, sceneProps.fallbackSettings, visibleSavedScales]);
  const renderedScalarRanges = useMemo(
    () => savedViewportActive ? [] : artifactField.historical ? artifactRenderedSurfaceRanges(artifactField.model) :
      initialColorbarPlans.flatMap((plan) => {
        const range = colorbarRangeStates.get(plan.groupKey)?.range;
        if (!range) return [];
        const target = colorbarParts.find(
          (candidate) => candidate.id === plan.targetIds[0],
        );
        return buildViewport3DRenderedScalarRangeAliases({
          component: plan.colorMode,
          quantityId: plan.quantityId,
          range,
          renderedScope: {
            scopeId: plan.scopeId,
            scopeKind: plan.scopeKind,
          },
          visualizationTarget: target?.objectScopeId
            ? { id: `object:${target.objectScopeId}`, kind: "object" }
            : null,
        });
      }),
    [artifactField.historical, artifactField.model, colorbarParts, colorbarRangeStates, initialColorbarPlans, savedViewportActive],
  );
  useEffect(() => {
    setRetainedViewport3DColorbarPlans(
      slotId,
      savedViewportColorbarReady && !savedViewportActive
        ? resolveRetainedViewport3DColorbarPlansForStore({
            fieldIdentityCompatible: sceneProps.fdmFieldIdentityCompatible,
            planned: plannedColorbars,
            renderSurfaceAvailable,
            retained: retainedColorbarPlans,
            targetPlanAvailable: colorbarTargetPlanAvailable,
            viewportColorbarRequested,
          })
        : EMPTY_VIEWPORT_3D_COLORBAR_PLANS,
    );
    viewport3dStore.setActiveScalarColorbarLegends(
      displayedColorbarLegends.map(({ legend }) => legend),
    );
    viewport3dStore.setRenderedScalarRanges(renderedScalarRanges);
  }, [
    displayedColorbarLegends,
    colorbarTargetPlanAvailable,
    plannedColorbars,
    renderSurfaceAvailable,
    retainedColorbarPlans,
    renderedScalarRanges,
    sceneProps.fdmFieldIdentityCompatible,
    savedViewportActive,
    savedViewportColorbarReady,
    slotId,
    viewportColorbarRequested,
  ]);
  useEffect(() => () => {
    viewport3dStore.setActiveScalarColorbarLegends([]);
    viewport3dStore.setRenderedScalarRanges([]);
  }, []);
  const handleVisualizationFrameCommit = useEffectEvent(({
    frameState: airboxFrameState,
    revision,
  }: {
    frameState: Viewport3DAirboxFrameState;
    revision: number;
  }) => {
    const canvas = canvasRef.current;
    const gl = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
    visualizationDebugPublisher.onFrameCommitted(
      buildViewport3DVisualizationDebugFrameCommit({
        ...airboxFrameState,
        revision,
        slotId,
        contextLost: gl?.isContextLost() ?? null,
        drawingBuffer: gl
          ? [gl.drawingBufferWidth, gl.drawingBufferHeight]
          : null,
      }),
    );
    const ackKind = visualizationAckKindsRef.current.get(revision);
    const frameAck = resolveViewport3DVisualizationFrameAck({
      committedDataIdentity: resolveViewport3DVisualizationAckDataIdentity({
        adoptionRegistry: visualizationDebugAdoptionRegistry,
        sessionIdentity,
        source: visualizationDebugSource,
        visualizationRevision: revision,
      }),
      registeredChangeKind: ackKind?.changeKind ?? null,
    });
    const committedDataIdentity = frameAck.dataIdentity;
    const resourceKey = committedDataIdentity?.resourceKey ??
      ackKind?.resourceKey ?? sceneProps.resourceFrameKey;
    const hasMatchingAdoption = !ackKind ||
      ackKind.changeKind === "style" ||
      (committedDataIdentity !== null &&
        visualizationDebugAdoptionRegistry.hasActiveAdoption({
          fieldBufferId: committedDataIdentity.fieldBufferId,
          resourceKey,
          sessionEpoch: committedDataIdentity.sessionEpoch,
          sessionId: committedDataIdentity.sessionId,
        }));
    if (hasMatchingAdoption) sendVisualizationAck({
      changeKind: frameAck.changeKind,
      effectiveRenderMode: visualizationEffectiveRenderMode,
      enabled: clientReady && !visualizationError,
      dataIdentity: committedDataIdentity,
      renderCommit: committedDataIdentity,
      revision,
      requestScopeEpoch: sessionIdentity?.requestScopeEpoch ?? null,
      resourceKey,
      sessionId: sessionIdentity?.sessionId ?? null,
      sessionEpoch: sessionIdentity?.sessionEpoch ?? null,
      status: "rendered",
      viewportId: slotId,
    });
    notifyMeshTopologyRendered({
      bus: kernel.bus,
      lastRevision: lastRenderedMeshRevision,
      meshRevision: sceneProps.renderedMeshRevision,
      rendererId: slotId,
    });
  });
  useEffect(() => {
    const consumeFrameCommits = () => {
      for (const commit of visualizationFrameCommitQueue.drain()) {
        handleVisualizationFrameCommit(commit);
      }
    };
    const unsubscribe =
      visualizationFrameCommitQueue.subscribe(consumeFrameCommits);
    consumeFrameCommits();
    return unsubscribe;
  }, [visualizationFrameCommitQueue]);
  useEffect(() => {
    const revision = sceneProps.visualizationRevision;
    if (revision == null) return;
    const previous = visualizationAckRevisionRef.current;
    const dataIdentity = resolveViewport3DVisualizationAckDataIdentity({
      adoptionRegistry: visualizationDebugAdoptionRegistry,
      sessionIdentity,
      source: visualizationDebugSource,
      visualizationRevision: revision,
    });
    const existingRegistration = visualizationAckKindsRef.current.get(revision) ?? null;
    const registration = resolveViewport3DVisualizationAckRegistration({
      existing: existingRegistration,
      previousResourceFrameKey: previous?.resourceFrameKey ?? null,
      resourceFrameKey: sceneProps.resourceFrameKey,
      resourceKey: dataIdentity?.resourceKey ?? sceneProps.resourceFrameKey,
    });
    const { changeKind, resourceKey } = registration;
    visualizationAckRevisionRef.current = {
      resourceFrameKey: sceneProps.resourceFrameKey,
      revision,
    };
    if (!existingRegistration) {
      visualizationAckKindsRef.current.set(revision, registration);
    }
    while (visualizationAckKindsRef.current.size > 64) {
      const oldest = visualizationAckKindsRef.current.keys().next().value;
      if (oldest === undefined) break;
      visualizationAckKindsRef.current.delete(oldest);
    }
    sendVisualizationAck({
      changeKind,
      dataIdentity,
      effectiveRenderMode: visualizationEffectiveRenderMode,
      enabled: clientReady,
      error: visualizationError,
      resourceKey,
      revision,
      requestScopeEpoch: sessionIdentity?.requestScopeEpoch ?? null,
      sessionId: sessionIdentity?.sessionId ?? null,
      sessionEpoch: sessionIdentity?.sessionEpoch ?? null,
      status: visualizationError ? "failed" : changeKind === "data" ? "applied" : "rendered",
      viewportId: slotId,
    });
  }, [
    clientReady,
    sceneProps.resourceFrameKey,
    sceneProps.visualizationRevision,
    sendVisualizationAck,
    sessionIdentity,
    sessionIdentity?.sessionEpoch,
    slotId,
    visualizationEffectiveRenderMode,
    visualizationError,
    visualizationDebugAdoptionRegistry,
    visualizationDebugSource,
  ]);
  const resourceIssueOpen = Boolean(
    fieldDataIssue && openedResourceIssueKey === fieldDataIssue.key,
  );
  const setResourceIssueOpen = useCallback(
    (open: boolean) => {
      setOpenedResourceIssueKey(open ? (fieldDataIssue?.key ?? null) : null);
    },
    [fieldDataIssue?.key, setOpenedResourceIssueKey],
  );
  useLayoutEffect(() => {
    if (captureRevision <= 0) return;
    pendingCaptureRevisionRef.current = captureRevision;
  }, [captureRevision]);
  const onCaptureFrameReady = useCallback(() => {
    void completePendingViewport3DCapture(canvasRef, pendingCaptureRevisionRef, captureRevision);
  }, [captureRevision]);
  const clearInspectHover = useCallback(() => {
    setInspectHover(null);
  }, [setInspectHover]);
  const handleCanvasCreated = useCallback(
    ({ gl }: Viewport3DCanvasCreatedState) => {
      canvasRef.current = gl.domElement;
      configureViewport3DRenderer(gl, visualProfile);
    },
    [visualProfile],
  );
  const handleCanvasPointerMissed = useCallback(() => {
    clearInspectHover();
    onClearSelection();
  }, [clearInspectHover, onClearSelection]);
  const updateInspectHover = useCallback(
    (
      sample: Viewport3DInspectSample,
      screenPosition: Viewport3DInspectScreenPosition,
    ) => {
      setInspectHover({ inspectRevision, sample, screenPosition });
    },
    [inspectRevision, setInspectHover],
  );
  const visibleInspectHover =
    sceneProps.inspectEnabled &&
    inspectHover?.inspectRevision === inspectRevision &&
    inspectHover.sample.quantityId === quantityId
      ? inspectHover
      : null;
  const visibleInspectProvenance = resolveViewport3DInspectSelectionProvenance({
    announcement: fdmSelectionAnnouncement,
    hover: visibleInspectHover,
    selectedCellOrdinal: fdmSelectionCellOrdinal,
  });
  // Expose the actually rendered Airbox carrier for the browser gate.  The
  // public target is always `airbox`; the FDM outside-support id is only the
  // field/query carrier used by the legacy single-grid path.
  const airboxRenderView = sceneProps.fdmMultilayerAirboxView;
  const airboxModel =
    airboxRenderView?.model ?? sceneProps.fdmAirboxInstanceModel;
  const airboxVectorSegments =
    airboxRenderView?.vectorSegments ?? sceneProps.fdmAirboxVectorSegments;
  const airboxDisplaySettings =
    airboxRenderView?.settings ?? sceneProps.airboxSettings;
  const airboxModelCount = airboxModel?.count ?? 0;
  const airboxVectorSegmentCount = Math.floor(
    (airboxVectorSegments?.length ?? 0) / 7,
  );
  const airboxVectorSegmentLengthRange = useMemo(
    () => resolveViewport3DVectorSegmentLengthRange(airboxVectorSegments),
    [airboxVectorSegments],
  );
  const airboxWireframeVisible = Boolean(
    airboxDisplaySettings.visible &&
      airboxDisplaySettings.wireframeVisible &&
      airboxModelCount > 0,
  );
  const airboxPointsVisible = Boolean(
    airboxDisplaySettings.visible &&
      airboxDisplaySettings.pointsVisible &&
      airboxModelCount > 0,
  );
  const airboxVectorsVisible = Boolean(
    airboxDisplaySettings.visible &&
      airboxDisplaySettings.vectorsVisible &&
      airboxVectorSegmentCount > 0,
  );

  return (
    <section
      aria-label="3D viewport"
      className="fm-viewport-3d"
      data-view-source={savedViewportActive ? "saved" : "current"}
      data-camera-position={sceneProps.cameraState.position.join(" ")}
      data-camera-projection={sceneProps.cameraProjection}
      data-camera-target={sceneProps.cameraState.target.join(" ")}
      data-camera-up={sceneProps.cameraState.up.join(" ")}
      data-fdm-domain-bounds={
        sceneProps.fdmDomain?.bounds
          ? JSON.stringify(sceneProps.fdmDomain.bounds)
          : ""
      }
      data-fdm-model-count={String(
        sceneProps.fdmNativeLayerViews.length > 0
          ? sceneProps.fdmNativeLayerViews.reduce((count, view) => count + (view.model?.count ?? 0), 0)
          : sceneProps.fdmInstanceModel?.count ?? 0,
      )}
      data-fdm-vector-segment-count={String(
        Math.floor((sceneProps.fdmVectorSegments?.length ?? 0) / 7),
      )}
      data-fdm-airbox-target={airboxRenderView?.target.id ?? "airbox"}
      data-fdm-airbox-view-present={airboxRenderView ? "true" : "false"}
      data-fdm-airbox-domain-cell-count={String(
        airboxRenderView?.domain.totalCells ?? 0,
      )}
      data-fdm-airbox-build-status={sceneProps.fdmMultilayerAirboxBuildStatus}
      data-fdm-airbox-build-key={sceneProps.fdmMultilayerAirboxBuildKey ?? ""}
      data-fdm-airbox-build-error={sceneProps.fdmMultilayerAirboxBuildError ?? ""}
      data-fdm-airbox-model-count={String(airboxModelCount)}
      data-fdm-airbox-vector-segment-count={String(airboxVectorSegmentCount)}
      data-fdm-airbox-vector-length-max={String(
        airboxVectorSegmentLengthRange?.max ?? 0,
      )}
      data-fdm-airbox-vector-length-min={String(
        airboxVectorSegmentLengthRange?.min ?? 0,
      )}
      data-fdm-airbox-vector-length-scale={String(
        airboxDisplaySettings.vectorLengthScale,
      )}
      data-fdm-airbox-points-visible={airboxPointsVisible ? "true" : "false"}
      data-fdm-airbox-wireframe-visible={airboxWireframeVisible ? "true" : "false"}
      data-fdm-airbox-vectors-visible={airboxVectorsVisible ? "true" : "false"}
      data-frozen-spins-overlay-count={String(
        sceneProps.frozenSpinsOverlayModel?.renderedCount ?? 0,
      )}
      data-frozen-spins-overlay-visible={
        sceneProps.frozenSpinsOverlayVisible ? "true" : "false"
      }
      data-frozen-spins-preview-current={
        sceneProps.frozenSpinsOverlayModel?.current ? "true" : "false"
      }
      data-frozen-spins-overlay-source={
        sceneProps.frozenSpinsOverlayModel?.source ?? "none"
      }
      data-inspect-enabled={sceneProps.inspectEnabled ? "true" : "false"}
      data-primitive-object-count={sceneProps.primitiveModel?.objects.length ?? 0}
      data-primitive-object-ids={primitiveObjectIds}
      data-primitive-object-kinds={sceneProps.primitiveModel?.objects
        .map((object) => `${object.objectId}:${object.kind}`).join(" ") ?? ""}
      data-primitive-object-geometry-descriptors={sceneProps.primitiveModel?.objects
        .map((object) => object.geometryKey.slice(0, 120)).join(" ") ?? ""}
      data-hysteresis-replay-snapshot-id={hysteresisReplayTarget?.snapshotId ?? ""}
      data-hysteresis-replay-stage-id={hysteresisReplayTarget?.stageId ?? ""}
      data-hysteresis-replay-field-direction={formatHysteresisReplayGlyphVector(
        hysteresisReplayGlyphModel?.fieldDirection?.vector,
      )}
      data-hysteresis-replay-measurement-axis={formatHysteresisReplayGlyphVector(
        hysteresisReplayGlyphModel?.measurementAxis?.vector,
      )}
      data-topology-freshness={sceneProps.topologyFreshness}
      data-viewport-bounds={
        artifactBounds ? JSON.stringify(artifactBounds) : ""
      }
      data-visual-profile-id={sceneProps.visualProfileId}
      data-antenna-field-quantity={antennaFieldOverlay?.intent.quantity}
      data-antenna-field-sample-count={antennaFieldOverlay?.count}
      onPointerDown={(event) => { if (event.currentTarget.contains(event.target as Node)) kernel.layout.setFocusedSlot(slotId); }}
    >
      <div className="fm-viewport-3d__hud" role="group" aria-label="3D view controls">
        <Viewport3DToolbar
          onCommand={onViewCommand}
          projection={sceneProps.cameraProjection}
          qualityProfileId={canvasContextProfileId}
          settingsOpen={inspectorDestination.context === "view"}
          inspectEnabled={sceneProps.inspectEnabled}
          layersContent={<div className="fm-viewport-3d__layers">
        {sceneProps.regionOverlays.length > 0 ||
        sceneProps.meshRegionOverlays.length > 0 ? (
          <fieldset
            aria-label="Region overlays"
            className="fm-viewport-3d__region-modes"
          >
            <Button
              aria-pressed={regionDiagnosticOverlayState.visible}
              size="sm"
              type="button"
              variant={
                regionDiagnosticOverlayState.visible ? "primary" : "secondary"
              }
              onClick={() =>
                onRegionOverlayVisibilityChange(
                  !regionDiagnosticOverlayState.visible,
                )
              }
            >
              Regions
            </Button>
            {(
              [
                ["auto", "Auto"],
                ["authored", "Authored"],
                ["realized", "Realized"],
                ["both", "Both"],
              ] as const
            ).map(([mode, label]) => (
              <Button
                key={mode}
                aria-pressed={regionDiagnosticOverlayState.source === mode}
                disabled={
                  !regionDiagnosticOverlayState.visible ||
                  (mode === "realized" &&
                    sceneProps.meshRegionOverlays.length === 0)
                }
                size="sm"
                type="button"
                variant={
                  regionDiagnosticOverlayState.source === mode
                    ? "primary"
                    : "secondary"
                }
                onClick={() => onRegionOverlaySourceChange(mode)}
              >
                {label}
              </Button>
            ))}
          </fieldset>
        ) : null}
        {sceneProps.fdmUniverseOutsideSupport ? (
          <fieldset
            aria-label="Airbox overlay"
            className="fm-viewport-3d__airbox-controls fm-viewport-3d__region-modes"
            data-target-id={sceneProps.fdmUniverseOutsideSupport.target.id}
          >
            <Button
              aria-pressed={Boolean(
                sceneProps.airboxSettings.visible,
              )}
              size="sm"
              type="button"
              variant={
                sceneProps.airboxSettings.visible
                  ? "primary"
                  : "secondary"
              }
              onClick={() =>
                onFdmUniverseOverlayVisibilityChange(
                  !sceneProps.airboxSettings.visible,
                )
              }
            >
              Airbox
            </Button>
            {sceneProps.airboxSettings.visible ? (
              <span
                className="fm-viewport-3d__airbox-legend"
                title={`${sceneProps.fdmUniverseOutsideSupport.legend.magneticSupport} · ${sceneProps.fdmUniverseOutsideSupport.legend.outsideSupport}`}
              >
                {sceneProps.fdmUniverseOutsideSupport.legend.magneticSupport}
                {" · "}
                {sceneProps.fdmUniverseOutsideSupport.legend.outsideSupport}
              </span>
            ) : null}
          </fieldset>
        ) : null}
        {sceneProps.frozenSpinsOverlayModel ? (
          <fieldset
            aria-label="Frozen Spins overlay"
            className="fm-viewport-3d__frozen-spins-controls fm-viewport-3d__region-modes"
          >
            <Button
              aria-pressed={sceneProps.frozenSpinsOverlayVisible}
              size="sm"
              type="button"
              variant={
                sceneProps.frozenSpinsOverlayVisible ? "primary" : "secondary"
              }
              onClick={() =>
                onFrozenSpinsOverlayVisibilityChange(
                  !sceneProps.frozenSpinsOverlayVisible,
                )
              }
            >
              Frozen Spins
            </Button>
            <span className="fm-viewport-3d__frozen-spins-legend">
              {sceneProps.frozenSpinsOverlayModel.renderedCount.toLocaleString("en-US")}
              /{sceneProps.frozenSpinsOverlayModel.frozenCount.toLocaleString("en-US")}
              {" frozen · "}
              {sceneProps.frozenSpinsOverlayModel.carrierKind === "fdm-cells"
                ? "FDM cells"
                : "FEM true DOFs"}
              {sceneProps.frozenSpinsOverlayModel.source === "runtime-field"
                ? " · runtime field"
                : " · preview mask"}
              {sceneProps.frozenSpinsOverlayModel.current
                ? " · current"
                : " · stale preview"}
            </span>
          </fieldset>
        ) : null}
        {!savedViewportActive ? (
          <Popover>
            <PopoverTrigger asChild>
              <Button className="fm-viewport-3d__render-details-trigger" size="sm" type="button" variant="secondary">Render details</Button>
            </PopoverTrigger>
            <PopoverContent align="start" aria-label="Render diagnostics" className="fm-viewport-3d__render-details">
              {diagnostics}
            </PopoverContent>
          </Popover>
        ) : null}
          </div>}
        />
        <div className="fm-viewport-3d__status" aria-label="3D view status">
        {preparedMagnetizationLabel ? (
          <div className="fm-viewport-3d__issue-banner">
            <span className="fm-viewport-3d__issue-banner-text" role="status">{preparedMagnetizationLabel}</span>
            <Button size="sm" type="button" variant="secondary" onClick={() => observationSourceWorkspaceStore.clear()}>
              Return to live
            </Button>
          </div>
        ) : null}
        {fieldDataIssue ? (
          <div className="fm-viewport-3d__issue-banner" role="status">
            <span
              className="fm-viewport-3d__issue-banner-text"
              title={`${fieldDataIssue.quantityId} cannot be rendered: ${fieldDataIssue.message}`}
            >
              {`${fieldDataIssue.quantityId} cannot be rendered: ${fieldDataIssue.message}`}
            </span>
            <Button onClick={() => setResourceIssueOpen(true)} size="sm" type="button" variant="secondary">
              Details
            </Button>
            <Button onClick={fieldDataIssue.retry} size="sm" type="button" variant="secondary">
              Retry
            </Button>
          </div>
        ) : null}
        {fieldPresentationFreshness && fieldPresentationFreshness !== "current" && !fieldDataIssue ? (
          <span
            className="fm-viewport-3d__freshness-badge"
            data-freshness={fieldPresentationFreshness}
            role="status"
          >
            {VIEWPORT_FIELD_FRESHNESS_LABEL[fieldPresentationFreshness]}
          </span>
        ) : null}
        {savedViewportActive ? (
          <fieldset
            aria-label="Viewport source"
            className="fm-viewport-3d__region-modes"
          >
            <Button
              aria-label="Return to current view"
              onClick={onReturnToCurrentView}
              size="sm"
              type="button"
              variant="secondary"
            >
              Current view
            </Button>
          </fieldset>
        ) : null}
        {/* Informational pills share one shrinkable lane so they truncate with
            a tooltip instead of wrapping the HUD into extra rows. */}
        <div className="fm-viewport-3d__hud-info">
          <Viewport3DAppearanceHud />
          <Viewport3DFieldLabel quantityId={artifactField.historical ? artifactField.model?.quantityId ?? "" : antennaFieldOverlay?.intent.quantity ?? quantityId} label={ownUniverseInspection ? "Accepted Universe inspection" : antennaFieldOverlay ? antennaFieldDisplayLabel(antennaFieldOverlay.intent) : quantityLabel} historical={!antennaFieldOverlay && artifactField.historical} model={artifactField.model} error={artifactField.error} liveDataAvailable={antennaFieldOverlay ? undefined : liveQuantityDataAvailable} />
          <span title={antennaFieldSourceLabel ?? selectedLabel}>{antennaFieldSourceLabel ?? selectedLabel}</span>
          {hysteresisReplayLabel ? <span title={hysteresisReplayLabel}>{hysteresisReplayLabel}</span> : null}
          <span title={hudSampleSummary}>{hudSampleSummary}</span>
          {artifactField.error ? <span role="status" title={artifactField.error}>{artifactField.error}</span> : null}
          {antennaFieldOverlay?.intent.kind === "inspection" ? (
            <span title={ANTENNA_INSPECTION_HUD_NOTE}>{ANTENNA_INSPECTION_HUD_NOTE}</span>
          ) : null}
          {meshQualityLegend ? <span title={meshQualityLegend}>{meshQualityLegend}</span> : null}
          {meshSizeHighlightSummary ? (
            <span title={meshSizeHighlightSummary}>{meshSizeHighlightSummary}</span>
          ) : null}
          <span title={status || undefined}>{status}</span>
        </div>
        {!antennaFieldOverlay && artifactField.candidates.length > 0 ? (
          <Select value={artifactField.selectedStageId} onValueChange={artifactField.select}>
            <SelectTrigger aria-label="Field inspection source and execution" className="fm-viewport-artifact-owner-select"><SelectValue placeholder="Select source and execution" /></SelectTrigger>
            <SelectContent>{artifactField.candidates.map(candidate => <SelectItem key={candidate.runtimeStageId} value={candidate.runtimeStageId}>{candidate.sourceObjectId} · {candidate.authoredStageId} · {candidate.runtimeStageId} · {candidate.status}</SelectItem>)}</SelectContent>
          </Select>
        ) : null}
        {sceneProps.primitiveModel?.diagnostics?.map((issue) => (
          <span key={issue.objectId} role="alert">
            Geometry preview unavailable · {issue.objectId}: {issue.message}
          </span>
        ))}
        <Viewport3DFieldRefreshCountdown refresh={fieldRefresh} />
        </div>
      </div>
      {clientReady && colors ? (
        <Viewport3DExportMenu onCommand={onViewCommand}>
        <Viewport3DCanvas
          // Keyboard users reach the scene, hear a text summary and open the
          // camera controls with Enter; Tab always moves on (no focus trap).
          aria-label={`3D viewport: ${selectedLabel}. ${domainSummary}. Press Enter for camera controls.`}
          aria-roledescription="3D viewport"
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing && event.target === event.currentTarget) {
              event.preventDefault();
              onViewCommand("viewport-3d.open-camera-dialog");
            }
          }}
          role="region"
          tabIndex={0}
          camera={canvasCamera}
          className="fm-viewport-3d__canvas"
          dpr={canvasDpr}
          events={createCanvasEvents}
          frameloop={canvasFrameloop}
          gl={canvasGlOptions}
          key={canvasContextKey}
          onCreated={handleCanvasCreated}
          onPointerMissed={handleCanvasPointerMissed}
        >
          <Viewport3DRendererProfile visualProfile={visualProfile} />
          <Viewport3DThumbnailBridge
            colouring={resolveViewport3DThumbnailColouring(sceneProps.fdmSettings)}
            slotId={slotId}
          />
          <Viewport3DFrameCommitQueueProvider queue={visualizationFrameCommitQueue}>
          <Viewport3DScene
            {...sceneProps}
            qualityProfileId={canvasContextProfileId}
            savedFieldIdentity={savedFieldIdentity}
            visibleColorScaleStore={savedViewportActive ? visibleSavedScaleStore : undefined}
            antennaFieldOverlay={antennaFieldOverlay}
            artifactFieldOverlay={artifactField.model}
            airboxSettings={ownUniverseInspection ? { ...sceneProps.airboxSettings,
              shaderVisible: false, wireframeVisible: false, vectorsVisible: false, pointsVisible: false, boundsVisible: false,
            } : sceneProps.airboxSettings}
            bounds={artifactBounds}
            selectionBounds={ownUniverseInspection ? artifactBounds : sceneProps.selectionBounds}
            fieldModel={artifactField.historical ? null : sceneProps.fieldModel}
            fdmVectorSegments={artifactField.historical ? null : sceneProps.fdmVectorSegments}
            fdmVectorColors={artifactField.historical ? null : sceneProps.fdmVectorColors}
            adoptionRegistry={visualizationDebugAdoptionRegistry}
            colors={colors}
            savedViewportActive={savedViewportActive}
            sessionIdentity={sessionIdentity}
            hysteresisReplayGlyphModel={hysteresisReplayGlyphModel}
            orbitDebugAngles={orbitDebugSnapshot.angles}
            orbitDebugCommitRevision={orbitDebugSnapshot.commitRevision}
            orbitDebugRevision={orbitDebugSnapshot.revision}
            orbitDebugStore={orbitDebugEnabled ? orbitDebugStore : undefined}
            onInspectClear={clearInspectHover}
            onInspectSample={updateInspectHover}
            onMoveCommit={moveInteraction.commitMove}
            onBeginGesture={moveInteraction.onBeginGesture}
            onMoveGestureActiveChange={moveInteraction.onGestureActiveChange}
            moveToolObjectId={moveInteraction.moveToolObjectId}
            moveDraftResetRevision={moveInteraction.moveDraftResetRevision}
            onCaptureFrameReady={onCaptureFrameReady}
            visualProfileId={visualProfile.id}
          />
          </Viewport3DFrameCommitQueueProvider>
        </Viewport3DCanvas>
        </Viewport3DExportMenu>
      ) : (
        <div className="fm-viewport-3d__placeholder" role="status">
          {colorsUnavailable
            ? "Viewport theme tokens could not be read; the 3D view cannot render. Reload the page or switch the theme to retry."
            : "Preparing viewport"}
        </div>
      )}
      {discretizationKind && (
        <div
          aria-label={`Discretization method: ${discretizationKind}`}
          role="note"
          className="fm-viewport-3d__method-badge"
        >
          {discretizationKind}
        </div>
      )}
      {displayedColorbarLegends.length > 0 ? (
        <div className="fm-viewport-3d__colorbar-stack">
          {displayedColorbarLegends.map(({ key, legend }) => (
            <Viewport3DColorbar key={key} legend={legend} />
          ))}
        </div>
      ) : null}
      {visibleInspectHover ? (
        <Viewport3DInspectTooltip
          hover={visibleInspectHover}
          provenance={visibleInspectProvenance}
        />
      ) : null}
      <Viewport3DMoveStatus error={moveInteraction.moveError} />
      <Viewport3DFdmSelectionAnnouncement
        announcement={fdmSelectionAnnouncement}
      />
      {orbitDebugEnabled && clientReady && colors ? (
        <Viewport3DOrbitDebugPanel
          angles={orbitDebugSnapshot.angles}
          onAnglesChange={orbitDebugStore.applyAngles}
          onAnglesCommit={orbitDebugStore.commitAngles}
          onInteractionStart={sceneProps.onCameraInteractionStart}
        />
      ) : null}
      {inspectorDestination.host ? createPortal(
        <Viewport3DSettingsContent
          activeSection={inspectorDestination.section}
          onSectionChange={setViewport3DInspectorSection}
          onCommand={onViewCommand}
          cameraContent={<Viewport3DCameraDialog
            key={cameraOwnerKey}
            cameraOrthographicScale={sceneProps.cameraOrthographicScale}
            cameraProjection={sceneProps.cameraProjection}
            cameraResource={cameraResource}
            cameraState={sceneProps.cameraState}
            onCameraPatch={onCameraPatch}
            onOpenChange={() => undefined}
            open
            inline
          />}
        />,
        inspectorDestination.host,
      ) : null}
      {inspectorDestination.exportHost ? createPortal(
        <Viewport3DExportPanel
          key={cameraOwnerKey}
          activeMode={inspectorDestination.exportMode}
          getSource={async () => {
            if (artifactField.historical || antennaFieldOverlay) {
              throw new Error("3D export is unavailable for this field inspection view.");
            }
            return getExportSource();
          }}
          onCommand={onViewCommand}
          onModeChange={setViewport3DExportMode}
          sourceRevisionKey={[
            cameraOwnerKey,
            quantityId ?? "",
            analysisOverlayQuantityId ?? "",
            String(liveQuantityDataAvailable),
            String(Boolean(artifactField.historical)),
            String(Boolean(antennaFieldOverlay)),
            String(sceneProps.primitiveModel?.objects.length ?? 0),
            String(Boolean(sceneProps.topology)),
          ].join("|")}
          visible={inspectorDestination.context === "export"}
        />,
        inspectorDestination.exportHost,
      ) : null}
      <Viewport3DExportOutlet key={cameraOwnerKey} getSource={async () => {
        if (artifactField.historical || antennaFieldOverlay) {
          throw new Error("3D export is unavailable for this field inspection view.");
        }
        return getExportSource();
      }} />
      <Viewport3DResourceIssueDialog
        issue={fieldDataIssue}
        open={Boolean(fieldDataIssue && resourceIssueOpen)}
        onOpenChange={setResourceIssueOpen}
      />
    </section>
  );
});

const ANTENNA_INSPECTION_HUD_NOTE =
  "inspection only · external electrode truncation · not qualified for LLG";
const INSPECT_TOOLTIP_OFFSET_PX = 14;

const VIEWPORT_FIELD_FRESHNESS_LABEL: Record<
  Exclude<Viewport3DFieldPresentationFreshness, "current">,
  string
> = {
  loading: "Loading field data",
  materializing: "Computing field — showing previous data until it is ready",
  stale: "Previous field data — refresh pending",
  unsupported: "Field not available for this run",
};

export const Viewport3DFdmSelectionAnnouncement = memo(
  function Viewport3DFdmSelectionAnnouncement({
    announcement,
  }: {
    announcement: string | null;
  }) {
    if (!announcement) return null;
    return (
      <span
        aria-atomic="true"
        aria-live="polite"
        className="fm-visually-hidden"
        role="status"
        title={announcement}
      >
        {announcement}
      </span>
    );
  },
);

/**
 * Registers this canvas with the thumbnail registry. The renderer does not
 * keep its drawing buffer, so a capture renders the scene and copies it in one
 * synchronous step instead of enabling preserveDrawingBuffer.
 */
function Viewport3DThumbnailBridge({
  colouring,
  slotId,
}: {
  colouring: Viewport3DThumbnailColouring;
  slotId: string;
}) {
  const getState = useThree((state) => state.get);
  const colouringRef = useRef(colouring);
  useEffect(() => {
    colouringRef.current = colouring;
  }, [colouring]);
  useEffect(
    () =>
      registerViewport3DThumbnailCapture(slotId, () =>
        captureViewport3DThumbnail({
          canvas: getState().gl.domElement,
          colouring: colouringRef.current,
          render: () => {
            const { camera, gl, scene } = getState();
            gl.render(scene, camera);
          },
        }),
      ),
    [getState, slotId],
  );
  return null;
}

function Viewport3DRendererProfile({
  visualProfile,
}: {
  visualProfile: Viewport3DVisualProfile;
}) {
  const gl = useThree((state) => state.gl);
  useEffect(() => {
    configureViewport3DRenderer(gl, visualProfile);
  }, [gl, visualProfile]);
  return null;
}

export const Viewport3DColorbar = memo(function Viewport3DColorbar({
  legend,
}: {
  legend: Viewport3DColorbarLegend;
}) {
  const fieldMeta = useFieldMetaResource({
    component: legend.colorMode ?? null,
    enabled: Boolean(!legend.range && legend.colorMode && legend.quantityId),
    quantityId: legend.quantityId ?? "m",
    scope_id: legend.scopeKind === "airbox" ? null : legend.scopeId ?? null,
    scope_kind: legend.scopeKind ?? null,
  });
  const metadataRange =
    typeof fieldMeta.data?.stats?.min === "number" &&
    typeof fieldMeta.data.stats.max === "number"
      ? {
          max: fieldMeta.data.stats.max,
          min: fieldMeta.data.stats.min,
        }
      : null;
  const range = legend.range ?? metadataRange;
  const [selectedDisplayUnit, setSelectedDisplayUnit] = useState(
    legend.displayUnit ?? "",
  );
  const displayUnitItems = displayUnitItemsForSourceUnit(legend.sourceUnit);
  const hasUnitOptions =
    Boolean(range) && hasDisplayUnitOptions(legend.sourceUnit);
  const effectiveDisplayUnit = hasUnitOptions
    ? normalizeDisplayUnit(
        legend.sourceUnit,
        selectedDisplayUnit || legend.displayUnit,
      )
    : "";
  const label =
    hasUnitOptions && legend.colorMode && legend.quantityId
      ? `${legend.labelPrefix ?? ""}${formatViewport3DColorbarQuantityLabel({
          colorMode: legend.colorMode,
          quantityId: legend.quantityId,
          unit: effectiveDisplayUnit,
        })}`
      : legend.label;
  const minLabel =
    hasUnitOptions && range
      ? formatValueWithDisplayUnit(
          range.min,
          legend.sourceUnit,
          effectiveDisplayUnit,
        )
      : legend.minLabel;
  const maxLabel =
    hasUnitOptions && range
      ? formatValueWithDisplayUnit(
          range.max,
          legend.sourceUnit,
          effectiveDisplayUnit,
        )
      : legend.maxLabel;
  const targetLabel = legend.labelPrefix?.replace(/:\s*$/, "") ?? "";
  const componentLabel = legend.quantityId && isScalarSpatialQuantityId(legend.quantityId)
    ? null
    : viewport3DColorbarComponentLabel(legend.colorMode);
  // Dimensionless quantities carry an explicit "1" in the catalog; an empty
  // unit means the catalog has no unit for this quantity.
  const unitLabel = effectiveDisplayUnit || legend.sourceUnit || "unit unknown";
  const rangeLabel = resolveViewport3DColorbarRangeLabel({
    hasBufferRange: Boolean(legend.range),
    hasMetadataRange: Boolean(metadataRange),
    rangeState: legend.rangeState,
  });
  return (
    <aside
      aria-label={`Color range: ${label}, ${minLabel} to ${maxLabel}`}
      className="fm-viewport-3d__colorbar"
    >
      <div className="fm-viewport-3d__colorbar-header">
        <div className="fm-viewport-3d__colorbar-identity">
          {targetLabel ? (
            <span className="fm-viewport-3d__colorbar-context">{targetLabel}</span>
          ) : null}
          <span className="fm-viewport-3d__colorbar-quantity">
            {legend.quantityId ? quantityDisplayName(legend.quantityId) : label}
          </span>
          {componentLabel ? (
            <span className="fm-viewport-3d__colorbar-component">
              {componentLabel}
            </span>
          ) : null}
        </div>
        {hasUnitOptions ? (
          <select
            aria-label={`${legend.label} display unit`}
            className="fm-viewport-3d__colorbar-unit"
            value={effectiveDisplayUnit}
            onChange={(event) => setSelectedDisplayUnit(event.target.value)}
          >
            {displayUnitItems.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        ) : (
          <span className="fm-viewport-3d__colorbar-unit" title="Display unit">
            {unitLabel}
          </span>
        )}
      </div>
      <div className="fm-viewport-3d__colorbar-range">
        <span className="fm-viewport-3d__colorbar-range-label">{rangeLabel}</span>
        <div className="fm-viewport-3d__colorbar-row">
          <span className="fm-viewport-3d__colorbar-limit">{minLabel}</span>
          <span
            aria-hidden="true"
            className="fm-viewport-3d__colorbar-ramp"
            style={{ background: legend.paletteGradient }}
          />
          <span className="fm-viewport-3d__colorbar-limit">{maxLabel}</span>
        </div>
      </div>
    </aside>
  );
});

function viewport3DColorbarComponentLabel(
  colorMode: string | undefined,
): string | null {
  switch (colorMode) {
    case "x":
      return "Component X";
    case "y":
      return "Component Y";
    case "z":
      return "Component Z";
    case "magnitude":
      return "Magnitude";
    default:
      return null;
  }
}

export const Viewport3DInspectTooltip = memo(function Viewport3DInspectTooltip({
  hover,
  provenance,
}: {
  hover: Viewport3DInspectHover;
  provenance: string | null;
}) {
  const { sample, screenPosition } = hover;
  const lines =
    sample.status === "ready"
      ? formatViewport3DInspectComponents(sample)
      : [sample.message];
  return (
    <div
      className="fm-viewport-3d__inspect-tooltip"
      role="tooltip"
      title={provenance ?? undefined}
      style={{
        left: screenPosition.x + INSPECT_TOOLTIP_OFFSET_PX,
        top: screenPosition.y + INSPECT_TOOLTIP_OFFSET_PX,
      }}
    >
      <div className="fm-viewport-3d__inspect-tooltip-header">
        <span title={sample.quantityId}>{quantityDisplayName(sample.quantityId)}</span>
        <span>{sample.targetLabel}</span>
      </div>
      <div className="fm-viewport-3d__inspect-tooltip-values">
        {lines.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </div>
      {provenance ? (
        <div className="fm-viewport-3d__inspect-tooltip-values">
          <span>{provenance}</span>
        </div>
      ) : null}
    </div>
  );
});

interface Viewport3DRefreshCountdownState {
  nowMs: number;
  sample: typeof EMPTY_VIEWPORT_3D_REFRESH_SAMPLE;
}

interface Viewport3DRefreshCountdownTick {
  nowMs: number;
  revision: Viewport3DFieldRefreshState["revision"];
  status: Viewport3DFieldRefreshState["status"];
}

const INITIAL_VIEWPORT_3D_REFRESH_COUNTDOWN: Viewport3DRefreshCountdownState = {
  nowMs: 0,
  sample: EMPTY_VIEWPORT_3D_REFRESH_SAMPLE,
};

function reduceViewport3DRefreshCountdown(
  current: Viewport3DRefreshCountdownState,
  tick: Viewport3DRefreshCountdownTick,
): Viewport3DRefreshCountdownState {
  return {
    nowMs: tick.nowMs,
    sample: updateViewport3DRefreshSample(current.sample, tick),
  };
}

const Viewport3DFieldRefreshCountdown = memo(
  function Viewport3DFieldRefreshCountdown({
    refresh,
  }: {
    refresh: Viewport3DFieldRefreshState;
  }) {
    const [countdown, dispatchCountdownTick] = useReducer(
      reduceViewport3DRefreshCountdown,
      INITIAL_VIEWPORT_3D_REFRESH_COUNTDOWN,
    );

    useEffect(() => {
      if (!refresh.enabled) {
        return;
      }

      dispatchCountdownTick({
        nowMs: Date.now(),
        revision: refresh.revision,
        status: refresh.status,
      });
    }, [refresh.enabled, refresh.revision, refresh.status]);

    const display = resolveViewport3DRefreshCountdownDisplay({
      enabled: refresh.enabled,
      nowMs: countdown.nowMs,
      payloadRevision: refresh.payloadRevision,
      requestedRevision: refresh.requestedRevision,
      sample: countdown.sample,
      status: refresh.status,
    });

    useEffect(() => {
      const delayMs = resolveViewport3DRefreshCountdownNextTickDelay({
        enabled: refresh.enabled,
        nowMs: countdown.nowMs,
        sample: countdown.sample,
        status: refresh.status,
      });
      if (delayMs === null) return;

      const timeoutId = setTimeout(() => {
        dispatchCountdownTick({
          nowMs: Date.now(),
          revision: refresh.revision,
          status: refresh.status,
        });
      }, delayMs);
      return () => clearTimeout(timeoutId);
    }, [
      countdown.nowMs,
      countdown.sample,
      refresh.enabled,
      refresh.revision,
      refresh.status,
    ]);

    if (!display) return null;

    const progressDegrees = `${Math.round(display.progress * 360)}deg`;
    const style = {
      "--fm-refresh-progress": progressDegrees,
    } as CSSProperties;

    return (
      <span
        aria-label={`${display.ariaLabel} for ${refresh.quantityId}`}
        role="group"
        className="fm-viewport-3d__refresh-countdown"
        data-pulse-id={countdown.sample.pulseId}
        data-refresh-state={display.state}
        data-resource-key={refresh.resourceKey}
        data-payload-revision={refresh.payloadRevision ?? "none"}
        data-revision={refresh.revision ?? "none"}
        data-requested-revision={refresh.requestedRevision ?? "none"}
        style={style}
      >
        <span
          aria-hidden="true"
          className="fm-viewport-3d__refresh-countdown-ring"
        >
          <span className="fm-viewport-3d__refresh-countdown-core" />
        </span>
        <span className="fm-viewport-3d__refresh-countdown-copy">
          <span className="fm-viewport-3d__refresh-countdown-title">
            {display.title}
          </span>
          <span className="fm-viewport-3d__refresh-countdown-detail">
            {display.detail}
          </span>
        </span>
      </span>
    );
  },
);

function Viewport3DResourceIssueDialog({
  issue,
  onOpenChange,
  open,
}: {
  issue: Viewport3DFieldDataIssue | null;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby="fm-viewport-field-data-issue-description">
        <DialogHeader>
          <DialogTitle>
            {issue ? `${issue.quantityId} data unavailable` : "Field data unavailable"}
          </DialogTitle>
          <DialogDescription id="fm-viewport-field-data-issue-description">
            {issue
              ? `Quantity ${issue.quantityId} cannot be rendered because ${issue.message}`
              : "The active field resource cannot be rendered."}
          </DialogDescription>
        </DialogHeader>
        {issue ? (
          <div className="fm-dialog__body">
            <dl className="fm-dialog__details">
              <div className="fm-dialog__details-row">
                <dt className="fm-dialog__details-label">Resource</dt>
                <dd className="fm-dialog__details-value">{issue.resourceKey}</dd>
              </div>
              <div className="fm-dialog__details-row">
                <dt className="fm-dialog__details-label">Reason</dt>
                <dd className="fm-dialog__details-value">{issue.message}</dd>
              </div>
            </dl>
          </div>
        ) : null}
        <DialogFooter>
          {issue ? (
            <Button type="button" variant="secondary" onClick={issue.retry}>
              Retry
            </Button>
          ) : null}
          <DialogClose asChild>
            <Button type="button" variant="primary">
              Close
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Viewport3DOrbitDebugPanel({
  angles,
  onAnglesChange,
  onAnglesCommit,
  onInteractionStart,
}: {
  angles: Viewport3DOrbitDebugAngles;
  onAnglesChange: (angles: Viewport3DOrbitDebugAngles) => void;
  onAnglesCommit: () => void;
  onInteractionStart?: () => void;
}) {
  const updateAngle = useCallback(
    (axis: keyof Viewport3DOrbitDebugAngles, value: string) => {
      onAnglesChange(
        normalizeViewport3DOrbitDebugAngles({
          ...angles,
          [axis]: Number(value),
        }),
      );
    },
    [angles, onAnglesChange],
  );

  function beginInputInteraction(
    event: ReactPointerEvent<HTMLInputElement>,
  ): void {
    event.stopPropagation();
    onInteractionStart?.();
  }

  function beginKeyboardInteraction(
    event: ReactFocusEvent<HTMLInputElement>,
  ): void {
    event.stopPropagation();
    onInteractionStart?.();
  }

  function endInputInteraction(
    event:
      | ReactFocusEvent<HTMLInputElement>
      | ReactPointerEvent<HTMLInputElement>,
  ): void {
    event.stopPropagation();
    onAnglesCommit();
  }

  return (
    <aside
      aria-label="Temporary orbit controls"
      className="fm-viewport-3d__orbit-debug"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="fm-viewport-3d__orbit-debug-header">
        <strong>Orbit Debug</strong>
        <span>rad</span>
      </div>
      <Viewport3DOrbitDebugSlider
        label="Azimuth"
        max={VIEWPORT_3D_ORBIT_DEBUG_LIMITS.azimuthMax}
        min={VIEWPORT_3D_ORBIT_DEBUG_LIMITS.azimuthMin}
        value={angles.azimuth}
        onChange={(value) => updateAngle("azimuth", value)}
        onInteractionBegin={beginKeyboardInteraction}
        onInteractionEnd={endInputInteraction}
        onInteractionStart={beginInputInteraction}
      />
      <Viewport3DOrbitDebugSlider
        label="Polar"
        max={VIEWPORT_3D_ORBIT_DEBUG_LIMITS.polarMax}
        min={VIEWPORT_3D_ORBIT_DEBUG_LIMITS.polarMin}
        value={angles.polar}
        onChange={(value) => updateAngle("polar", value)}
        onInteractionBegin={beginKeyboardInteraction}
        onInteractionEnd={endInputInteraction}
        onInteractionStart={beginInputInteraction}
      />
    </aside>
  );
}

function Viewport3DOrbitDebugSlider({
  label,
  max,
  min,
  onChange,
  onInteractionBegin,
  onInteractionEnd,
  onInteractionStart,
  value,
}: {
  label: string;
  max: number;
  min: number;
  onChange: (value: string) => void;
  onInteractionBegin: (event: ReactFocusEvent<HTMLInputElement>) => void;
  onInteractionEnd: (
    event:
      | ReactFocusEvent<HTMLInputElement>
      | ReactPointerEvent<HTMLInputElement>,
  ) => void;
  onInteractionStart: (event: ReactPointerEvent<HTMLInputElement>) => void;
  value: number;
}) {
  return (
    <div className="fm-viewport-3d__orbit-debug-field">
      <span>{label}</span>
      <output>{value.toFixed(3)}</output>
      <input
        aria-label={label}
        aria-valuetext={value.toFixed(3)}
        max={max}
        min={min}
        step="0.001"
        type="range"
        value={value}
        onBlur={onInteractionEnd}
        onChange={(event) => onChange(event.target.value)}
        onFocus={onInteractionBegin}
        onPointerCancel={onInteractionEnd}
        onPointerDown={onInteractionStart}
        onPointerUp={onInteractionEnd}
      />
    </div>
  );
}
