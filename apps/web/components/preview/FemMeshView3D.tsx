"use client";

import { useEffect, useMemo, useRef, useState, memo, useCallback, type ReactNode } from "react";
import * as THREE from "three";
import { FemClipPlanes, CameraAutoFit } from "./fem/FemR3FHelpers";
import { useFemViewportModel } from "./fem/useFemViewportModel";
import { useFemViewportCommands } from "./fem/useFemViewportCommands";
import { useFemViewportDerivedModel } from "./fem/useFemViewportDerivedModel";
import { useFemViewportPresenter } from "./fem/useFemViewportPresenter";
import type { FemLiveRenderDebugData } from "./fem/FemLiveRenderDebugPanel";
import type {
  FemLiveMeshObjectSegment,
  FemMeshPart,
  MeshQualityStats,
  MeshEntityViewState,
  MeshEntityViewStateMap,
} from "../../lib/session/types";
import type {
  AntennaOverlay,
  BuilderObjectOverlay,
  FocusObjectRequest,
  ObjectViewMode,
} from "../runs/control-room/shared";
import type { VisibleSubmeshSnapshot } from "../runs/control-room/submeshSnapshot";
import { partMeshTint, partEdgeTint } from "./fem/femColorUtils";
import { FemViewportScene } from "./fem/FemViewportScene";
import { FemContextMenu, FemHoverTooltip } from "./fem/FemContextMenu";
import ScientificViewportShell from "./shared/ScientificViewportShell";
import type { ViewportQualityProfileId } from "./shared/viewportQualityProfiles";
import {
  ViewportOverlayManager,
} from "./ViewportOverlayManager";
import TextureTransformGizmo, {
  type TextureGizmoMode,
  type TexturePreviewProxy,
} from "./TextureTransformGizmo";
import type { TextureTransform3D } from "@/lib/textureTransform";
import { useFemSceneGeometry } from "./fem/useFemSceneGeometry";
import { resolveAirboxArrowSamplingMode } from "./fem/airboxVectorSampling";
import { useFemFaceInteraction } from "./fem/useFemFaceInteraction";
import type { UnifiedTrimState } from "@/features/viewport-unified/model/unifiedViewportTypes";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { recordFrontendRender } from "@/lib/debug/frontendPerfDebug";
import { recordViewportLifecycleEventForLabel } from "@/lib/debug/viewportTelemetry";
import { DEFAULT_VIEWPORT_VISUAL_PROFILE } from "@/lib/profiles/frontendRuntimeProfiles";
import {
  captureOrientationDebugSnapshot,
  type OrientationDebugSnapshot,
} from "./camera/cameraOrientation";
import { useSceneCameraChange } from "./camera/useSceneCameraChange";
import {
  shouldSkipViewportCameraRestoreForAppliedState,
  shouldSkipViewportCameraRestoreForScope,
  useViewportCameraPersistenceController,
} from "@/features/viewport-unified/camera-lifecycle";
import {
  captureViewportCameraState,
  restoreViewportCameraState,
} from "./camera/persistedViewportCamera";
import type { ViewportCameraState } from "@/features/workspace-graph";
import type {
  AirboxRenderPassState,
  MeshRenderPassState,
} from "@/features/viewport-unified/model/unifiedViewportTypes";
export type {
  FemMeshData,
  MeshSelectionSnapshot,
  FemColorField,
  FemArrowColorMode,
  ArrowSamplingMode,
  RenderMode,
  ClipAxis,
  FemVectorDomainFilter,
  FemFerromagnetVisibilityMode,
} from "./fem/femMeshTypes";
import type {
  FemMeshData,
  MeshSelectionSnapshot,
  FemColorField,
  FemArrowColorMode,
  ArrowSamplingMode,
  RenderMode,
  ClipAxis,
  FemVectorDomainFilter,
  FemFerromagnetVisibilityMode,
} from "./fem/femMeshTypes";

/* ── Opacity constants (sourced from viewport visual profile) ── */
const DIMMED_MIN_MAGNETIC = DEFAULT_VIEWPORT_VISUAL_PROFILE.dimmedMinMagnetic;
const DIMMED_MIN_AIR = DEFAULT_VIEWPORT_VISUAL_PROFILE.dimmedMinAir;
const SELECTED_LIFT_MAGNETIC = DEFAULT_VIEWPORT_VISUAL_PROFILE.selectedLiftMagnetic;
const SELECTED_LIFT_AIR = DEFAULT_VIEWPORT_VISUAL_PROFILE.selectedLiftAir;
const BLANK_VIEWPORT_RECOVERY_GRACE_MS = 900;

export interface Viewport3DHealthReport {
  status: "active" | "inactive" | "warning";
  reason: string;
  detail: string;
}

interface Props {
  meshData: FemMeshData;
  colorField?: FemColorField;
  airColorField?: FemColorField;
  magneticColorField?: FemColorField;
  fieldLabel?: string;
  quantityId?: string;
  quantityOptions?: Array<{
    id: string;
    shortLabel: string;
    label?: string;
    available: boolean;
  }>;
  showWireframe?: boolean;
  topologyKey: string;
  toolbarMode?: "visible" | "hidden";
  renderMode?: RenderMode;
  renderPasses?: MeshRenderPassState;
  airboxPasses?: AirboxRenderPassState;
  opacity?: number;
  trim?: UnifiedTrimState | null;
  clipEnabled?: boolean;
  clipAxis?: ClipAxis;
  clipPos?: number;
  clipFlip?: boolean;
  showArrowsRequested?: boolean;
  arrowColorMode?: FemArrowColorMode;
  arrowMonoColor?: string;
  arrowAlpha?: number;
  arrowLengthScale?: number;
  arrowThickness?: number;
  vectorDomainFilter?: FemVectorDomainFilter;
  ferromagnetVisibilityMode?: FemFerromagnetVisibilityMode;
  previewMaxPoints?: number;
  femVectorGlyphBudget?: number | null;
  showOrientationLegend?: boolean;
  qualityPerFace?: number[] | null;
  shrinkFactor?: number;
  legendOpen?: boolean;
  viewportFitSeed?: string | number;
  onRenderModeChange?: (value: RenderMode) => void;
  onOpacityChange?: (value: number) => void;
  onClipEnabledChange?: (value: boolean) => void;
  onClipAxisChange?: (value: ClipAxis) => void;
  onClipPosChange?: (value: number) => void;
  onClipFlipChange?: (value: boolean) => void;
  onShowArrowsChange?: (value: boolean) => void;
  onArrowColorModeChange?: (value: FemArrowColorMode) => void;
  onArrowMonoColorChange?: (value: string) => void;
  onArrowAlphaChange?: (value: number) => void;
  onArrowLengthScaleChange?: (value: number) => void;
  onArrowThicknessChange?: (value: number) => void;
  onVectorDomainFilterChange?: (value: FemVectorDomainFilter) => void;
  onFerromagnetVisibilityModeChange?: (value: FemFerromagnetVisibilityMode) => void;
  onPreviewMaxPointsChange?: (maxPoints: number) => void;
  onShrinkFactorChange?: (value: number) => void;
  onLegendOpenChange?: (value: boolean) => void;
  onSelectionChange?: (selection: MeshSelectionSnapshot) => void;
  onRefine?: (faceIndices: number[], factor: number) => void;
  antennaOverlays?: AntennaOverlay[];
  selectedAntennaId?: string | null;
  objectOverlays?: BuilderObjectOverlay[];
  selectedObjectId?: string | null;
  selectedEntityId?: string | null;
  focusedEntityId?: string | null;
  objectViewMode?: ObjectViewMode;
  objectSegments?: FemLiveMeshObjectSegment[];
  meshParts?: FemMeshPart[];
  elementMarkers?: number[] | null;
  perDomainQuality?: Record<number, MeshQualityStats> | null;
  meshEntityViewState?: MeshEntityViewStateMap;
  onMeshPartViewStatePatch?: (
    partIds: string[],
    patch: Partial<MeshEntityViewState>,
  ) => void;
  visibleObjectIds?: string[];
  airSegmentVisible?: boolean;
  airSegmentOpacity?: number;
  viewportAxesScope?: "universe" | "object";
  universeWireframeVisible?: boolean;
  focusObjectRequest?: FocusObjectRequest | null;
  cameraFitRequestSeed?: string | number | null;
  worldExtent?: [number, number, number] | null;
  worldCenter?: [number, number, number] | null;
  onAntennaTranslate?: (id: string, dx: number, dy: number, dz: number) => void;
  onGeometryTranslate?: (id: string, dx: number, dy: number, dz: number) => void;
  onRequestObjectSelect?: (id: string) => void;
  onEntitySelect?: (id: string | null) => void;
  onEntityFocus?: (id: string | null) => void;
  onQuantityChange?: (quantityId: string) => void;
  activeTextureTransform?: TextureTransform3D | null;
  textureGizmoMode?: TextureGizmoMode;
  activeTexturePreviewProxy?: TexturePreviewProxy;
  activeTransformScope?: "object" | "texture" | null;
  onTextureTransformChange?: (next: TextureTransform3D) => void;
  onTextureTransformCommit?: (next: TextureTransform3D) => void;
  partExplorerOpen?: boolean;
  onTogglePartExplorer?: () => void;
  onVisibleSubmeshSnapshotChange?: (snapshot: VisibleSubmeshSnapshot | null) => void;
  selectedSidebarNodeId?: string | null;
  liveRenderDebugData?: FemLiveRenderDebugData | null;
  viewportVisible?: boolean;
  viewportDocumentId?: string | null;
  persistedCameraState?: ViewportCameraState | null;
  onPersistCameraState?: (state: ViewportCameraState) => void;
  onCameraInteractionChange?: (active: boolean) => void;
  onViewportHealthChange?: (report: Viewport3DHealthReport) => void;
  authoringOverlay?: ReactNode;
}

/* ── Component ─────────────────────────────────────────────────────── */

function FemMeshView3DInner({
  meshData,
  colorField = "orientation",
  airColorField,
  magneticColorField,
  fieldLabel,
  quantityId,
  quantityOptions = [],
  toolbarMode = "visible",
  renderMode: controlledRenderMode,
  renderPasses,
  airboxPasses,
  opacity: controlledOpacity,
  trim: controlledTrim = null,
  clipEnabled: controlledClipEnabled,
  clipAxis: controlledClipAxis,
  clipPos: controlledClipPos,
  clipFlip: controlledClipFlip,
  showArrowsRequested: controlledShowArrowsRequested,
  arrowColorMode: controlledArrowColorMode,
  arrowMonoColor: controlledArrowMonoColor,
  arrowAlpha: controlledArrowAlpha,
  arrowLengthScale: controlledArrowLengthScale,
  arrowThickness: controlledArrowThickness,
  vectorDomainFilter: controlledVectorDomainFilter,
  ferromagnetVisibilityMode: controlledFerromagnetVisibilityMode,
  previewMaxPoints,
  femVectorGlyphBudget,
  showOrientationLegend = false,
  qualityPerFace,
  topologyKey,
  viewportFitSeed,
  shrinkFactor: controlledShrinkFactor,
  legendOpen: controlledLegendOpen,
  onRenderModeChange,
  onOpacityChange,
  onClipEnabledChange,
  onClipAxisChange,
  onClipPosChange,
  onClipFlipChange,
  onShowArrowsChange,
  onArrowColorModeChange,
  onArrowMonoColorChange,
  onArrowAlphaChange,
  onArrowLengthScaleChange,
  onArrowThicknessChange,
  onVectorDomainFilterChange,
  onFerromagnetVisibilityModeChange,
  onPreviewMaxPointsChange,
  onShrinkFactorChange,
  onLegendOpenChange,
  onSelectionChange,
  onRefine,
  antennaOverlays = [],
  selectedAntennaId,
  objectOverlays = [],
  selectedObjectId,
  selectedEntityId = null,
  focusedEntityId = null,
  objectViewMode = "context",
  objectSegments = [],
  meshParts = [],
  elementMarkers = null,
  perDomainQuality = null,
  meshEntityViewState = {},
  onMeshPartViewStatePatch,
  visibleObjectIds,
  airSegmentVisible = false,
  airSegmentOpacity = 28,
  viewportAxesScope = "universe",
  universeWireframeVisible = true,
  focusObjectRequest = null,
  cameraFitRequestSeed = null,
  worldExtent = null,
  worldCenter = null,
  onAntennaTranslate,
  onGeometryTranslate,
  onRequestObjectSelect,
  onQuantityChange,
  activeTextureTransform = null,
  textureGizmoMode = "translate",
  activeTexturePreviewProxy = "box",
  activeTransformScope = null,
  onTextureTransformChange,
  onTextureTransformCommit,
  partExplorerOpen: controlledPartExplorerOpen,
  onTogglePartExplorer,
  onVisibleSubmeshSnapshotChange,
  selectedSidebarNodeId = null,
  liveRenderDebugData = null,
  viewportVisible = true,
  viewportDocumentId = null,
  persistedCameraState = null,
  onPersistCameraState,
  onCameraInteractionChange,
  onViewportHealthChange,
  authoringOverlay = null,
}: Props) {
  if (FRONTEND_DIAGNOSTIC_FLAGS.renderDebug.enableRenderLogging) {
    recordFrontendRender("FemMeshView3DInner", {
      nNodes: meshData.nNodes,
      nElements: meshData.nElements,
      showSceneGeometry: FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showSceneGeometry,
      showPerPartGeometry: FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showPerPartGeometry,
    });
  }
  const [field, setField] = useState<FemColorField>(colorField);
  const [internalPartExplorerOpen, setInternalPartExplorerOpen] = useState(true);
  const partExplorerOpen = controlledPartExplorerOpen ?? internalPartExplorerOpen;

  const [cameraFitGeneration, setCameraFitGeneration] = useState(0);
  const [rotationSnapshots, setRotationSnapshots] = useState<{
    viewport: OrientationDebugSnapshot | null;
    viewCube: OrientationDebugSnapshot | null;
    hsl: OrientationDebugSnapshot | null;
  }>({
    viewport: null,
    viewCube: null,
    hsl: null,
  });

  const controlsRef = useRef<any>(null);
  const viewCubeSceneRef = useRef<any>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const qualityProfileRef = useRef<ViewportQualityProfileId>("interactive");
  const cameraInteractionActiveRef = useRef(false);
  const cameraPersistenceScope = viewportDocumentId ?? topologyKey;
  const cameraRestoreReadyRef = useRef(false);
  const restoredCameraScopeRef = useRef<string | null>(null);
  const lastFocusedObjectIdRef = useRef<string | null>(persistedCameraState?.lastFocusedObjectId ?? null);
  // P-18: Track canvas remount generation so the camera restore effect re-runs after context loss
  // recovery (canvasContextGeneration bump inside ScientificViewportShell remounts the Canvas but
  // doesn't change cameraPersistenceScope or persistedCameraState, so without this counter the
  // restore effect guard would silently return and the camera would snap to [3,2.4,3]).
  const [cameraContextKey, setCameraContextKey] = useState(0);
  const [canvasVisualActive, setCanvasVisualActive] = useState<boolean | null>(null);
  const [viewportShellRecoveryGeneration, setViewportShellRecoveryGeneration] = useState(0);
  const lastRestoredContextKeyRef = useRef(-1);
  // P-19: External ref for CameraAutoFit so its "last applied" state survives scene remounts
  // (missingExactScopeSegment toggle or context loss). Without this the ref resets to gen=0 on
  // every remount and immediately re-fires fitCameraToBounds for the current generation.
  const cameraAutoFitAppliedRef = useRef<{ generation: number; camera: THREE.Camera | null }>(
    { generation: 0, camera: null },
  );
  const blankViewportRecoveryRef = useRef<{ key: string | null; attempts: number }>({
    key: null,
    attempts: 0,
  });
  const blankViewportInactiveSinceRef = useRef<number | null>(null);
  const leakIsolationFlags = FRONTEND_DIAGNOSTIC_FLAGS.leakIsolation;

  const {
    renderMode,
    opacity,
    clipEnabled,
    clipAxis,
    clipPos,
    clipFlip,
    showArrowsRequested,
    arrowColorMode,
    arrowMonoColor,
    arrowAlpha,
    arrowLengthScale,
    arrowThickness,
    arrowSamplingMode,
    vectorDomainFilter,
    ferromagnetVisibilityMode,
    resolvedPreviewMaxPoints,
    shrinkFactor,
    cameraProjection,
    navigationMode,
    legendOpen,
    labeledMode,
    openPopover,
    qualityProfile,
    interactionActive,
    captureActive,
    captureOverlayHidden,
    textureGizmoDragging,
    sampledArrowCount,
    setInternalRenderMode,
    setInternalOpacity,
    setInternalArrowColorMode,
    setInternalArrowMonoColor,
    setInternalArrowAlpha,
    setInternalArrowLengthScale,
    setInternalArrowThickness,
    setInternalArrowSamplingMode,
    setInternalClipEnabled,
    setInternalClipAxis,
    setInternalClipPos,
    setInternalClipFlip,
    setInternalShowArrows,
    setInternalVectorDomainFilter,
    setInternalFerromagnetVisibilityMode,
    setInternalShrinkFactor,
    setCameraProjection,
    setNavigationMode,
    setLegendOpen,
    setLabeledMode,
    setOpenPopover,
    setQualityProfile,
    setInteractionActive,
    setTextureGizmoDragging,
    setSampledArrowCount,
    setCaptureActive,
    setCaptureOverlayHidden,
    updateSharedPreviewMaxPoints,
  } = useFemViewportModel({
    colorField,
    controlledRenderMode,
    controlledOpacity,
    controlledClipEnabled,
    controlledClipAxis,
    controlledClipPos,
    controlledClipFlip,
    controlledShowArrowsRequested,
    controlledArrowColorMode,
    controlledArrowMonoColor,
    controlledArrowAlpha,
    controlledArrowLengthScale,
    controlledArrowThickness,
    controlledVectorDomainFilter,
    controlledFerromagnetVisibilityMode,
    controlledShrinkFactor,
    controlledLegendOpen,
    previewMaxPoints,
    onPreviewMaxPointsChange,
    onLegendOpenChange,
  });
  const rotationDebugActive = openPopover === "rotation";
  useEffect(() => {
    if (
      persistedCameraState?.projection &&
      persistedCameraState.projection !== cameraProjection
    ) {
      setCameraProjection(persistedCameraState.projection);
    }
    if (
      persistedCameraState?.navigation &&
      persistedCameraState.navigation !== navigationMode
    ) {
      setNavigationMode(persistedCameraState.navigation);
    }
  }, [
    cameraProjection,
    navigationMode,
    persistedCameraState?.navigation,
    persistedCameraState?.projection,
    setCameraProjection,
    setNavigationMode,
  ]);
  useEffect(() => {
    if (!focusObjectRequest?.objectId) {
      return;
    }
    lastFocusedObjectIdRef.current = focusObjectRequest.objectId;
  }, [focusObjectRequest?.objectId, focusObjectRequest?.revision]);
  const wrapperFlags = FRONTEND_DIAGNOSTIC_FLAGS.femWrapper;
  const selectionOnlyInteractionMode =
    FRONTEND_DIAGNOSTIC_FLAGS.femViewport.enableSelectionOnlyInteractionMode;
  const geometryPointerInteractionsEnabled =
    wrapperFlags.enableInteractiveState &&
    selectionOnlyInteractionMode &&
    FRONTEND_DIAGNOSTIC_FLAGS.femViewport.enableGeometryPointerInteractions;
  const geometryHoverInteractionsEnabled =
    geometryPointerInteractionsEnabled &&
    FRONTEND_DIAGNOSTIC_FLAGS.femViewport.enableGeometryHoverInteractions;
  const geometryContextMenuEnabled =
    geometryPointerInteractionsEnabled && wrapperFlags.enableContextMenu;
  const {
    hasMeshParts,
    selectedObjectOverlay,
    supportsAirboxOnlyVectors,
    effectiveVectorDomainFilter,
    visibleLayers,
    missingMagneticMask,
    missingExactScopeSegment,
    vectorDomain,
    toolbarModel,
  } = useFemViewportDerivedModel({
    meshData,
    objectOverlays,
    selectedObjectId: selectedObjectId ?? null,
    visibleObjectIds,
    objectSegments,
    airSegmentVisible,
    meshParts,
    meshEntityViewState,
    objectViewMode,
    vectorDomainFilter,
    ferromagnetVisibilityMode,
    selectedEntityId,
    focusedEntityId,
    elementMarkers,
    perDomainQuality,
    onVisibleSubmeshSnapshotChange,
    resolvedPreviewMaxPoints,
    captureActive,
    interactionActive,
    qualityProfile,
    renderMode,
    field,
    opacity,
    arrowColorMode,
    showArrowsRequested,
    femVectorGlyphBudget,
    qualityPerFace,
    sampledArrowCount,
    quantityOptions,
    selectedSidebarNodeId,
  });
  const {
    magneticBoundaryFaceIndices,
    magneticElementIndices,
    airBoundaryFaceIndices,
    airElementIndices,
    arrowActiveNodeMask,
    arrowBoundaryFaceIndices,
    baseArrowDensity,
    effectiveArrowDensity,
    resolvedVectorDomain,
    runtimeQualityProfile,
    runtimeRenderMode,
    runtimeArrowDensity,
    shouldRenderMagneticGeometryResolved,
    shouldRenderAirGeometry,
  } = vectorDomain;
  const telemetryLabel = quantityId
    ? `fem-${quantityId}-${runtimeRenderMode}`
    : `fem-${runtimeRenderMode}`;
  const effectiveArrowSamplingMode = useMemo<ArrowSamplingMode>(
    () =>
      resolveAirboxArrowSamplingMode({
        resolvedVectorDomain,
        arrowSamplingMode,
      visibleLayers,
    }),
    [arrowSamplingMode, resolvedVectorDomain, visibleLayers],
  );
  const hasMagneticGeometryPass =
    !renderPasses ||
    renderPasses.surface ||
    renderPasses.wireframe ||
    renderPasses.volumeMesh ||
    renderPasses.points;
  const hasAirboxGeometryPass =
    !airboxPasses || airboxPasses.surface || airboxPasses.wireframe || airboxPasses.points;
  const renderableGeometryLayerCount = useMemo(() => {
    if (!hasMeshParts) {
      return (
        Number(shouldRenderAirGeometry && hasAirboxGeometryPass) +
        Number(shouldRenderMagneticGeometryResolved && hasMagneticGeometryPass)
      );
    }
    return visibleLayers.filter((layer) => {
      const airboxScoped = layer.part.role === "air" || layer.part.role === "outer_boundary";
      if (airboxScoped && !hasAirboxGeometryPass) {
        return false;
      }
      if (!airboxScoped && !hasMagneticGeometryPass) {
        return false;
      }
      if (layer.viewState.geometryVisible === false) {
        return false;
      }
      const hasFaces =
        !Array.isArray(layer.boundaryFaceIndices) || layer.boundaryFaceIndices.length > 0;
      const hasElements =
        !Array.isArray(layer.elementIndices) || layer.elementIndices.length > 0;
      return hasFaces || hasElements;
    }).length;
  }, [
    hasAirboxGeometryPass,
    hasMeshParts,
    hasMagneticGeometryPass,
    shouldRenderAirGeometry,
    shouldRenderMagneticGeometryResolved,
    visibleLayers,
  ]);
  const topologySignature = topologyKey.trim();
  if (!topologySignature) {
    throw new Error("[FemMeshView3D] Missing required topologyKey.");
  }
  const {
    hoveredFace,
    ctxMenu,
    selectedFaces,
    handleFaceHover,
    handleFaceUnhover,
    handleFaceClick,
    handleFaceContextMenu,
    setSelectedFaces,
    setHoveredFace,
    setCtxMenu,
  } = useFemFaceInteraction({
    topologySignature,
    geometryPointerInteractionsEnabled,
    onSelectionChange,
  });
  const {
    toolbarStylePartIds,
    toolbarColorPartIds,
    toolbarRenderMode,
    toolbarRenderModeMixed,
    toolbarOpacity,
    toolbarOpacityMixed,
    toolbarColorFieldMixed,
    toolbarColorField,
    prominentQuantityOptions,
    arrowField,
    legendField,
    effectiveShowArrows,
    arrowsBlockReason,
    toolbarScopeLabel,
    colorLegendField,
    colorLegendStats,
    selectionScope,
  } = toolbarModel;
  const effectiveOpacity = opacity;
  const expectedViewportContent =
    FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showSceneGeometry &&
    !missingExactScopeSegment &&
    (renderableGeometryLayerCount > 0 || effectiveShowArrows);
  const publishViewportHealth = useCallback((report: Viewport3DHealthReport) => {
    onViewportHealthChange?.(report);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("fullmag:viewport3d-health", { detail: report }));
    }
  }, [onViewportHealthChange]);

  useEffect(() => {
    if (missingExactScopeSegment) {
      publishViewportHealth({
        status: "inactive",
        reason: "Selected 3D scope has no matching FEM mesh segment.",
        detail: "Clear isolate/selection or select an object that exists in the current FEM mesh.",
      });
      return;
    }
    if (!expectedViewportContent) {
      publishViewportHealth({
        status: "inactive",
        reason: "No renderable 3D geometry or vectors are active.",
        detail: "Enable Primitive, Mesh View, Quantity, Vectors, or Airbox in the View ribbon.",
      });
      return;
    }
    if (canvasVisualActive === false) {
      publishViewportHealth({
        status: "warning",
        reason: "3D canvas appears blank although renderable FEM content is enabled.",
        detail: "The WebGL viewport may need a reset, remount, or camera refit.",
      });
      return;
    }
    publishViewportHealth({
      status: "active",
      reason: "3D visualization is rendering visible content.",
      detail: `${renderableGeometryLayerCount.toLocaleString()} renderable FEM layer${renderableGeometryLayerCount === 1 ? "" : "s"}${effectiveShowArrows ? " plus vectors" : ""}.`,
    });
  }, [
    canvasVisualActive,
    effectiveShowArrows,
    expectedViewportContent,
    missingExactScopeSegment,
    publishViewportHealth,
    renderableGeometryLayerCount,
  ]);

  const {
    applyToolbarRenderMode,
    applyToolbarOpacity,
    applyToolbarColorField,
    syncFieldFromProps,
    setClipEnabled,
    toggleClip,
    setClipAxis,
    setClipPos,
    setClipFlip,
    setArrowsVisible,
    setVectorDomainFilter,
    setFerromagnetVisibilityMode,
    setShrinkFactor,
    toggleLegend,
    togglePartExplorer,
  } = useFemViewportCommands({
    hasMeshParts,
    toolbarStylePartIds,
    toolbarColorPartIds,
    selectionScope,
    onMeshPartViewStatePatch,
    onRenderModeChange,
    onOpacityChange,
    onClipEnabledChange,
    onClipAxisChange,
    onClipPosChange,
    onClipFlipChange,
    onShowArrowsChange,
    onVectorDomainFilterChange,
    onFerromagnetVisibilityModeChange,
    onShrinkFactorChange,
    setInternalRenderMode,
    setInternalOpacity,
    setInternalClipEnabled,
    setInternalClipAxis,
    setInternalClipPos,
    setInternalClipFlip,
    setInternalShowArrows,
    setInternalVectorDomainFilter,
    setInternalFerromagnetVisibilityMode,
    setInternalShrinkFactor,
    field,
    setField,
    clipEnabled,
    partExplorerOpen,
    setOpenPopover,
    setLegendOpen,
    setInternalPartExplorerOpen,
  });

  useEffect(() => {
    syncFieldFromProps(colorField);
  }, [colorField, syncFieldFromProps]);

  const {
    dynamicGeomCenter,
    dynamicGeomSize,
    dynamicMaxDim,
    axesWorldExtent,
    axesCenter,
    universeWireframeExtent,
    universeWireframeCenter,
    sceneMaxDim,
    resolvedWorldTextureTransform,
    sceneTextureTransform,
    handleTextureTransformLiveChange,
    handleTextureTransformCommit,
    setCameraPreset,
    focusObject,
    handleViewCubeRotate,
    takeScreenshot,
  } = useFemSceneGeometry({
    meshData,
    hasMeshParts,
    visibleLayers,
    airBoundaryFaceIndices,
    magneticBoundaryFaceIndices,
    shouldRenderAirGeometry,
    shouldRenderMagneticGeometryResolved,
    enableBoundsDerivedModel: wrapperFlags.enableBoundsDerivedModel,
    enableTextureTransformModel: wrapperFlags.enableTextureTransformModel,
    enableCameraFitEffect:
      wrapperFlags.enableCameraFitEffect &&
      leakIsolationFlags.enableFemMeshView3DAutoFit &&
      leakIsolationFlags.enableFemMeshView3DAutoFitGenerationEffect,
    enableScreenshotCapture: wrapperFlags.enableScreenshotCapture,
    suppressInitialCameraFit: Boolean(persistedCameraState),
    activeTextureTransform,
    selectedObjectOverlay,
    objectOverlays,
    focusObjectRequest,
    worldExtent,
    worldCenter,
    viewportAxesScope,
    viewportFitSeed: expectedViewportContent
      ? [
          viewportFitSeed ?? "no-fit-seed",
          "ready",
          renderableGeometryLayerCount,
          effectiveShowArrows ? "vectors" : "no-vectors",
        ].join(":")
      : null,
    cameraFitRequestSeed: expectedViewportContent ? cameraFitRequestSeed : null,
    viewCubeSceneRef,
    canvasRef,
    qualityProfileRef,
    onTextureTransformChange,
    onTextureTransformCommit,
    setCameraFitGeneration,
    setCaptureOverlayHidden,
    setCaptureActive,
    setQualityProfile,
  });
  const expectedCanvasVisualContent =
    expectedViewportContent &&
    leakIsolationFlags.enableFemMeshView3DSceneRender &&
    (
      leakIsolationFlags.enableFemMeshView3DGeometryRender ||
      leakIsolationFlags.enableFemMeshView3DArrowRender ||
      leakIsolationFlags.enableFemMeshView3DOverlayRender
    );
  const blankViewportRecoveryEnabled =
    leakIsolationFlags.enableFemMeshView3DAutoFit &&
    leakIsolationFlags.enableFemMeshView3DBlankViewportRecovery;
  useEffect(() => {
    if (
      !blankViewportRecoveryEnabled ||
      !expectedCanvasVisualContent ||
      missingExactScopeSegment ||
      canvasVisualActive !== false
    ) {
      if (canvasVisualActive === true) {
        blankViewportRecoveryRef.current = { key: null, attempts: 0 };
      }
      blankViewportInactiveSinceRef.current = null;
      return;
    }
    // User-persisted camera state must win over heuristic blank-canvas recovery.
    // During live relax updates, visual-activity probing can transiently report
    // false negatives; forcing CameraAutoFit here causes the observed snapback.
    if (persistedCameraState) {
      blankViewportRecoveryRef.current = { key: null, attempts: 0 };
      blankViewportInactiveSinceRef.current = null;
      return;
    }
    if (!Number.isFinite(dynamicMaxDim) || dynamicMaxDim <= 0) {
      blankViewportInactiveSinceRef.current = null;
      return;
    }
    const nowMs = Date.now();
    if (blankViewportInactiveSinceRef.current == null) {
      blankViewportInactiveSinceRef.current = nowMs;
      return;
    }
    const inactiveDurationMs = nowMs - blankViewportInactiveSinceRef.current;
    if (inactiveDurationMs < BLANK_VIEWPORT_RECOVERY_GRACE_MS) {
      return;
    }

    const recoveryKey = [
      topologyKey,
      viewportFitSeed ?? "no-fit-seed",
      renderableGeometryLayerCount,
      effectiveShowArrows ? "vectors" : "no-vectors",
    ].join(":");
    if (blankViewportRecoveryRef.current.key !== recoveryKey) {
      blankViewportRecoveryRef.current = { key: recoveryKey, attempts: 0 };
      blankViewportInactiveSinceRef.current = nowMs;
      return;
    }
    if (blankViewportRecoveryRef.current.attempts >= 2) {
      return;
    }

    const nextAttempt = blankViewportRecoveryRef.current.attempts + 1;
    blankViewportRecoveryRef.current.attempts = nextAttempt;
    cameraAutoFitAppliedRef.current = { generation: -1, camera: null };
    if (nextAttempt > 1) {
      setCanvasVisualActive(null);
      setViewportShellRecoveryGeneration((generation) => generation + 1);
    }
    setCameraFitGeneration((generation) => generation + 1);
  }, [
    blankViewportRecoveryEnabled,
    canvasVisualActive,
    dynamicMaxDim,
    effectiveShowArrows,
    expectedCanvasVisualContent,
    missingExactScopeSegment,
    renderableGeometryLayerCount,
    topologyKey,
    viewportFitSeed,
    persistedCameraState,
  ]);
  const updateRotationSnapshot = useCallback((
    key: "viewport" | "viewCube" | "hsl",
    snapshot: OrientationDebugSnapshot,
  ) => {
    if (!rotationDebugActive) {
      return;
    }
    setRotationSnapshots((previous) => {
      const current = previous[key];
      if (current?.signature === snapshot.signature && current.cssTransform === snapshot.cssTransform) {
        return previous;
      }
      return { ...previous, [key]: snapshot };
    });
  }, [rotationDebugActive]);
  const syncViewportRotationSnapshot = useCallback(() => {
    const bridge = viewCubeSceneRef.current;
    if (!bridge?.camera) {
      return;
    }
    updateRotationSnapshot("viewport", captureOrientationDebugSnapshot(bridge.camera));
  }, [updateRotationSnapshot]);
  useEffect(() => {
    if (rotationDebugActive) {
      syncViewportRotationSnapshot();
    }
  }, [rotationDebugActive, syncViewportRotationSnapshot]);
  const persistCameraState = useCallback(() => {
    if (cameraInteractionActiveRef.current) {
      return;
    }
    if (!cameraRestoreReadyRef.current) {
      return;
    }
    const state = captureViewportCameraState(viewCubeSceneRef.current, {
      projection: cameraProjection,
      navigation: navigationMode,
      lastFocusedObjectId: lastFocusedObjectIdRef.current,
    });
    if (!state || !onPersistCameraState) {
      return;
    }
    recordViewportLifecycleEventForLabel(telemetryLabel, "camera_persist");
    onPersistCameraState(state);
  }, [cameraProjection, navigationMode, onPersistCameraState, telemetryLabel]);
  const cameraPersistenceController = useViewportCameraPersistenceController(persistCameraState);
  const handleViewportInteractionChange = useCallback((next: boolean) => {
    cameraInteractionActiveRef.current = next;
    cameraPersistenceController.setInteractionActive(next);
    setInteractionActive(next);
    onCameraInteractionChange?.(next);
  }, [cameraPersistenceController, onCameraInteractionChange, setInteractionActive]);
  const handleSceneCameraChange = useCallback(() => {
    syncViewportRotationSnapshot();
    cameraPersistenceController.schedule();
  }, [cameraPersistenceController, syncViewportRotationSnapshot]);
  const recordCameraFit = useCallback(() => {
    recordViewportLifecycleEventForLabel(telemetryLabel, "camera_fit");
  }, [telemetryLabel]);
  // P-21: Track the last persisted camera state we actually applied. Used to detect reference
  // identity changes that carry identical values (e.g., when graphActiveViewportDocument gets a
  // new object because a non-camera field changed), so we don\u2019t hard-set the camera unnecessarily.
  const lastAppliedCameraStateRef = useRef<ViewportCameraState | null>(null);

  useSceneCameraChange(viewCubeSceneRef, handleSceneCameraChange, {
    onInteractionStart: cameraPersistenceController.handleInteractionStart,
    onInteractionEnd: cameraPersistenceController.handleInteractionEnd,
  });
  useEffect(() => {
    if (
      shouldSkipViewportCameraRestoreForScope({
        restoreReady: cameraRestoreReadyRef.current,
        restoredScope: restoredCameraScopeRef.current,
        currentScope: cameraPersistenceScope,
        // P-18: guard must also match the canvas generation so that after context loss recovery
        // (canvasContextGeneration increment \u2192 Canvas remount \u2192 cameraContextKey increment) the
        // restore effect runs again instead of returning early.
        lastRestoredContextKey: lastRestoredContextKeyRef.current,
        currentContextKey: cameraContextKey,
      })
    ) {
      syncViewportRotationSnapshot();
      return;
    }
    // P-21: Skip restore when persistedCameraState changed reference but values are identical
    // to what we already applied. This prevents a camera snapback when the parent re-creates the
    // camera object because an unrelated viewport document field changed.
    if (
      shouldSkipViewportCameraRestoreForAppliedState({
        restoreReady: cameraRestoreReadyRef.current,
        persistedCameraState,
        lastAppliedCameraState: lastAppliedCameraStateRef.current,
      })
    ) {
      return;
    }
    cameraRestoreReadyRef.current = false;
    let raf = 0;
    let disposed = false;

    const restore = () => {
      if (disposed) {
        return;
      }
      const bridge = viewCubeSceneRef.current;
      if (!bridge?.camera || !bridge?.controls) {
        raf = window.requestAnimationFrame(restore);
        return;
      }
      if (restoreViewportCameraState(bridge, persistedCameraState)) {
        recordViewportLifecycleEventForLabel(telemetryLabel, "camera_restore");
        lastFocusedObjectIdRef.current = persistedCameraState?.lastFocusedObjectId ?? null;
      }
      restoredCameraScopeRef.current = cameraPersistenceScope;
      lastRestoredContextKeyRef.current = cameraContextKey; // P-18
      lastAppliedCameraStateRef.current = persistedCameraState;  // P-21
      cameraRestoreReadyRef.current = true;
      syncViewportRotationSnapshot();
    };

    restore();

    return () => {
      disposed = true;
      if (raf) {
        window.cancelAnimationFrame(raf);
      }
    };
  }, [cameraContextKey, cameraPersistenceScope, persistedCameraState, syncViewportRotationSnapshot, telemetryLabel]);
  const applyRotationEuler = useCallback((nextEulerDeg: [number, number, number]) => {
    const quaternion = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(
        THREE.MathUtils.degToRad(nextEulerDeg[0]),
        THREE.MathUtils.degToRad(nextEulerDeg[1]),
        THREE.MathUtils.degToRad(nextEulerDeg[2]),
        "XYZ",
      ),
    );
    handleViewCubeRotate(quaternion);
  }, [handleViewCubeRotate]);
  // P-20: Capture initial geometry center as a stable value and never update it reactively.
  // Drei's OrbitControls/TrackballControls synchronise the `target` prop to controls.target via
  // useEffect, so passing a reactive dynamicGeomCenter here causes the orbit center to snap back
  // to the geometry centroid every time the mesh loads or part visibility changes — overriding
  // the user's panning. Subsequent camera adjustments go through CameraAutoFit and
  // restoreViewportCameraState which update controls.target directly via the controls ref.
  //
  // P-20b: Allow a single update when the initial value was [0,0,0] (empty mesh at mount time)
  // and real geometry data arrives. After the first real geometry center is captured, lock the
  // value to prevent the snapback described above.
  const [shellTarget, setShellTarget] = useState<[number, number, number]>(
    () => [dynamicGeomCenter.x, dynamicGeomCenter.y, dynamicGeomCenter.z],
  );
  const shellTargetLockedRef = useRef(dynamicMaxDim > 0);
  useEffect(() => {
    if (shellTargetLockedRef.current) {
      return;
    }
    if (dynamicMaxDim > 0) {
      setShellTarget([dynamicGeomCenter.x, dynamicGeomCenter.y, dynamicGeomCenter.z]);
      shellTargetLockedRef.current = true;
    }
  }, [dynamicGeomCenter.x, dynamicGeomCenter.y, dynamicGeomCenter.z, dynamicMaxDim]);
  const {
    overlayItems,
    hoveredFaceInfo,
    onPointerMissed,
    handleContextInspectFace,
    handleContextShowQuality,
    handleContextToggleClip,
    handleContextClearSelection,
  } = useFemViewportPresenter({
    wrapperFlags,
    qualityProfileRef,
    qualityProfile,
    interactionActive,
    setHoveredFace,
    activeTransformScope,
    textureGizmoDragging,
    setTextureGizmoDragging,
    meshData,
    qualityPerFace,
    hoveredFace,
    captureOverlayHidden,
    toolbarMode,
    toolbarRenderMode,
    toolbarRenderModeMixed,
    toolbarColorField,
    toolbarColorFieldMixed,
    toolbarOpacity,
    toolbarOpacityMixed,
    toolbarScopeLabel,
    arrowColorMode,
    arrowMonoColor,
    arrowAlpha,
    arrowLengthScale,
    arrowThickness,
    arrowSamplingMode,
    showArrowsRequested,
    effectiveShowArrows,
    arrowsBlockReason,
    baseArrowDensity,
    effectiveArrowDensity,
    cameraProjection,
    navigationMode,
    clipEnabled,
    clipAxis,
    clipPos,
    clipFlip,
    hasMeshParts,
    meshParts,
    visibleLayersCount: visibleLayers.length,
    missingMagneticMask,
    missingExactScopeSegment,
    selectedObjectId,
    effectiveVectorDomainFilter,
    ferromagnetVisibilityMode,
    supportsAirboxOnlyVectors,
    shrinkFactor,
    labeledMode,
    legendOpen,
    partExplorerOpen,
    openPopover,
    selectedFaces,
    showOrientationLegend,
    liveRenderDebugData,
    arrowField,
    legendField,
    colorLegendField,
    fieldLabel,
    colorLegendStats,
    quantityId,
    prominentQuantityOptions,
    applyToolbarRenderMode,
    applyToolbarColorField,
    applyToolbarOpacity,
    onArrowColorModeChange,
    onArrowMonoColorChange,
    onArrowAlphaChange,
    onArrowLengthScaleChange,
    onArrowThicknessChange,
    onQuantityChange,
    onTogglePartExplorer,
    onRefine,
    updateSharedPreviewMaxPoints,
    setInternalArrowColorMode,
    setInternalArrowMonoColor,
    setInternalArrowAlpha,
    setInternalArrowLengthScale,
    setInternalArrowThickness,
    setInternalArrowSamplingMode,
    setInternalPartExplorerOpen,
    setLabeledMode,
    setOpenPopover,
    setCameraProjection,
    setNavigationMode,
    setQualityProfile,
    setCameraPreset,
    setSelectedFaces,
    setCtxMenu,
    takeScreenshot,
    handleViewCubeRotate,
    viewCubeSceneRef,
    rotationSnapshots,
    updateRotationSnapshot,
    applyRotationEuler,
    setClipEnabled,
    toggleClip,
    setClipAxis,
    setClipPos,
    setClipFlip,
    setArrowsVisible,
    setVectorDomainFilter,
    setFerromagnetVisibilityMode,
    setShrinkFactor,
    toggleLegend,
    togglePartExplorer,
  });
  return (
    <div className="relative flex flex-1 w-[100%] h-[100%] min-w-0 min-h-0 bg-background overflow-hidden rounded-md fem-canvas-container">
      <ScientificViewportShell
        key={`fem-viewport-shell-${viewportShellRecoveryGeneration}`}
        toolbar={
          null
        }
        hud={null}
        projection={cameraProjection}
        navigation={navigationMode}
        qualityProfile={runtimeQualityProfile}
        renderPolicy={{
          mode: viewportVisible
            ? interactionActive || captureActive
              ? "always"
              : "demand"
            : "paused",
          hidden: !viewportVisible,
          interactionActive: viewportVisible && interactionActive,
        }}
        onInteractionChange={handleViewportInteractionChange}
        target={shellTarget}
        bridgeRef={viewCubeSceneRef}
        controlsRef={controlsRef}
        onViewCubeRotate={handleViewCubeRotate}
        onResetView={() => setCameraPreset("reset")}
        controlProfile="fem"
        renderDefaultGizmos={false}
        onPointerMissed={geometryPointerInteractionsEnabled ? onPointerMissed : undefined}
        onCanvasContextMenu={(e) => e.preventDefault()}
        onCanvasCreated={({ gl }) => {
          canvasRef.current = gl.domElement;
          // P-18: Increment cameraContextKey so the restore effect re-runs after context loss
          // recovery. ScientificViewportShell increments canvasContextGeneration on context loss,
          // which remounts the Canvas (new key), which triggers onCanvasCreated again.
          setCameraContextKey((k) => k + 1);
        }}
        onVisualActivityChange={setCanvasVisualActive}
        diagnosticOverrides={{
          enableControls:
            selectionOnlyInteractionMode || textureGizmoDragging ? false : true,
        }}
        telemetryLabel={telemetryLabel}
      >
        {!missingExactScopeSegment ? (
          <>
            {leakIsolationFlags.enableFemMeshView3DAutoFit &&
            leakIsolationFlags.enableFemMeshView3DAutoFitComponent &&
            FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showCameraAutoFit &&
            wrapperFlags.enableCameraFitEffect ? (
              <CameraAutoFit
                maxDim={dynamicMaxDim}
                generation={cameraFitGeneration}
                targetCenter={dynamicGeomCenter}
                controlsRef={controlsRef}
                lastAppliedRef={cameraAutoFitAppliedRef}
                enableCameraApply={leakIsolationFlags.enableFemMeshView3DAutoFitCameraApply && !persistedCameraState}
                enableInvalidate={leakIsolationFlags.enableFemMeshView3DAutoFitInvalidate}
                onFitApplied={
                  leakIsolationFlags.enableFemMeshView3DAutoFitRecord
                    ? recordCameraFit
                    : undefined
                }
              />
            ) : null}
            {FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showClipPlanesHelper ? (
              <FemClipPlanes enabled={clipEnabled} axis={clipAxis} posPercentage={clipPos} flip={clipFlip} geomSize={dynamicGeomSize} />
            ) : null}
            {FRONTEND_DIAGNOSTIC_FLAGS.leakIsolation.enableFemMeshView3DSceneRender ? (
              <FemViewportScene
            meshData={meshData}
            hasMeshParts={hasMeshParts}
            visibleLayers={visibleLayers}
            shouldRenderAirGeometry={shouldRenderAirGeometry}
            airBoundaryFaceIndices={airBoundaryFaceIndices}
            airElementIndices={airElementIndices}
            airSegmentOpacity={airSegmentOpacity}
            shouldRenderMagneticGeometry={shouldRenderMagneticGeometryResolved}
            magneticVisibilityMode={
              effectiveVectorDomainFilter === "airbox_only"
                ? ferromagnetVisibilityMode
                : "hide"
            }
            field={field}
            airColorField={airColorField ?? colorField}
            magneticColorField={magneticColorField ?? colorField}
            renderMode={runtimeRenderMode}
            renderPasses={renderPasses}
            airboxPasses={airboxPasses}
            effectiveOpacity={effectiveOpacity}
            magneticBoundaryFaceIndices={magneticBoundaryFaceIndices}
            magneticElementIndices={magneticElementIndices}
            qualityPerFace={qualityPerFace}
            shrinkFactor={shrinkFactor}
            trim={controlledTrim}
            clipEnabled={clipEnabled}
            clipAxis={clipAxis}
            clipPos={clipPos}
            dynamicGeomCenter={dynamicGeomCenter}
            dynamicMaxDim={dynamicMaxDim}
            effectiveShowArrows={
              FRONTEND_DIAGNOSTIC_FLAGS.leakIsolation.enableFemMeshView3DArrowRender &&
              effectiveShowArrows
            }
            arrowField={arrowField}
            arrowDensity={runtimeArrowDensity}
            arrowColorMode={arrowColorMode}
            arrowMonoColor={arrowMonoColor}
            arrowAlpha={arrowAlpha}
            arrowLengthScale={arrowLengthScale}
            arrowThickness={arrowThickness}
            arrowSamplingMode={effectiveArrowSamplingMode}
            arrowActiveNodeMask={arrowActiveNodeMask}
            arrowBoundaryFaceIndices={arrowBoundaryFaceIndices}
            selectedFaces={selectedFaces}
            antennaOverlays={antennaOverlays}
            objectOverlays={objectOverlays}
            focusedEntityId={focusedEntityId}
            selectedAntennaId={selectedAntennaId}
            selectedObjectId={selectedObjectId}
            onAntennaTranslate={onAntennaTranslate}
            activeTransformScope={activeTransformScope}
            onGeometryTranslate={onGeometryTranslate}
            onObjectSelect={onRequestObjectSelect}
            axesWorldExtent={axesWorldExtent}
            axesCenter={axesCenter}
            universeWireframeExtent={universeWireframeExtent}
            universeWireframeCenter={universeWireframeCenter}
            universeWireframeVisible={universeWireframeVisible}
            onFaceClick={geometryPointerInteractionsEnabled ? handleFaceClick : undefined}
            onFaceHover={geometryHoverInteractionsEnabled && !interactionActive ? handleFaceHover : undefined}
            onFaceUnhover={geometryHoverInteractionsEnabled ? handleFaceUnhover : undefined}
            onFaceContextMenu={geometryContextMenuEnabled ? handleFaceContextMenu : undefined}
            showSceneGeometry={
              FRONTEND_DIAGNOSTIC_FLAGS.leakIsolation.enableFemMeshView3DGeometryRender &&
              FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showSceneGeometry
            }
            showPerPartGeometry={FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showPerPartGeometry}
            showAirGeometry={FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showAirGeometry}
            showMagneticGeometry={FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showMagneticGeometry}
            showSurfacePass={FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showSurfacePass}
            showSurfaceHiddenEdgesPass={FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showSurfaceHiddenEdgesPass}
            showSurfaceVisibleEdgesPass={FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showSurfaceVisibleEdgesPass}
            showVolumeHiddenEdgesPass={FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showVolumeHiddenEdgesPass}
            showVolumeVisibleEdgesPass={FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showVolumeVisibleEdgesPass}
            showPointsPass={FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showPointsPass}
            enableGeometryCompaction={FRONTEND_DIAGNOSTIC_FLAGS.femViewport.enableGeometryCompaction}
            enableGeometryNormals={FRONTEND_DIAGNOSTIC_FLAGS.femViewport.enableGeometryNormals}
            enableGeometryVertexColors={FRONTEND_DIAGNOSTIC_FLAGS.femViewport.enableGeometryVertexColors}
            enableGeometryPointerInteractions={geometryPointerInteractionsEnabled}
            enableGeometryHoverInteractions={geometryHoverInteractionsEnabled}
            showSelectionHighlight={
              FRONTEND_DIAGNOSTIC_FLAGS.leakIsolation.enableFemMeshView3DOverlayRender &&
              FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showSelectionHighlight
            }
            showAntennaOverlays={
              FRONTEND_DIAGNOSTIC_FLAGS.leakIsolation.enableFemMeshView3DOverlayRender &&
              FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showAntennaOverlays
            }
            showSceneAxes={
              FRONTEND_DIAGNOSTIC_FLAGS.leakIsolation.enableFemMeshView3DOverlayRender &&
              FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showSceneAxes
            }
            onArrowSampledCount={setSampledArrowCount}
            telemetryLabel={telemetryLabel}
              />
            ) : null}
            {authoringOverlay}
          </>
        ) : null}

        {wrapperFlags.enableTextureTransformGizmo &&
        FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showTextureTransformGizmo &&
        sceneTextureTransform &&
        activeTransformScope !== "object" ? (
          <TextureTransformGizmo
            transform={sceneTextureTransform}
            mode={textureGizmoMode}
            previewProxy={activeTexturePreviewProxy}
            showPreviewProxy
            syncPivotWithTranslation
            onDragStart={() => setTextureGizmoDragging(true)}
            onDragEnd={() => setTextureGizmoDragging(false)}
            onLiveChange={handleTextureTransformLiveChange}
            onCommit={handleTextureTransformCommit}
            visible
          />
        ) : null}
      </ScientificViewportShell>
      {!captureOverlayHidden && wrapperFlags.enableOverlayManager ? <ViewportOverlayManager items={overlayItems} /> : null}

      {!captureOverlayHidden &&
      geometryHoverInteractionsEnabled &&
      wrapperFlags.enableHoverTooltip &&
      FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showHoverTooltip ? (
        <FemHoverTooltip hoveredFace={hoveredFace} hoveredFaceInfo={hoveredFaceInfo} />
      ) : null}

      {!captureOverlayHidden &&
      geometryContextMenuEnabled &&
      FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showContextMenu ? (
        <FemContextMenu
          ctxMenu={ctxMenu}
          clipEnabled={clipEnabled}
          selectedFacesCount={selectedFaces.length}
          onInspectFace={handleContextInspectFace}
          onShowQuality={handleContextShowQuality}
          onToggleClip={handleContextToggleClip}
          onClearSelection={handleContextClearSelection}
        />
      ) : null}
    </div>
  );
}

export default memo(FemMeshView3DInner);
