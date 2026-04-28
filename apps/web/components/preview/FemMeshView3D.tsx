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
import { useFemFaceInteraction } from "./fem/useFemFaceInteraction";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { recordFrontendRender } from "@/lib/debug/frontendPerfDebug";
import { DEFAULT_VIEWPORT_VISUAL_PROFILE } from "@/lib/profiles/frontendRuntimeProfiles";
import {
  captureOrientationDebugSnapshot,
  type OrientationDebugSnapshot,
} from "./camera/cameraOrientation";
import { useSceneCameraChange } from "./camera/useSceneCameraChange";
import {
  captureViewportCameraState,
  restoreViewportCameraState,
} from "./camera/persistedViewportCamera";
import type { ViewportCameraState } from "@/features/workspace-graph";
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
  opacity?: number;
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
  viewportDocumentId?: string | null;
  persistedCameraState?: ViewportCameraState | null;
  onPersistCameraState?: (state: ViewportCameraState) => void;
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
  opacity: controlledOpacity,
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
  viewportDocumentId = null,
  persistedCameraState = null,
  onPersistCameraState,
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
  const cameraPersistenceScope = viewportDocumentId ?? topologyKey;
  const cameraRestoreReadyRef = useRef(false);
  const restoredCameraScopeRef = useRef<string | null>(null);
  const lastFocusedObjectIdRef = useRef<string | null>(persistedCameraState?.lastFocusedObjectId ?? null);

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
    runtimeQualityProfile,
    runtimeRenderMode,
    runtimeArrowDensity,
    shouldRenderMagneticGeometryResolved,
    shouldRenderAirGeometry,
  } = vectorDomain;

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
    enableCameraFitEffect: wrapperFlags.enableCameraFitEffect,
    enableScreenshotCapture: wrapperFlags.enableScreenshotCapture,
    suppressInitialCameraFit: Boolean(persistedCameraState),
    activeTextureTransform,
    selectedObjectOverlay,
    objectOverlays,
    focusObjectRequest,
    worldExtent,
    worldCenter,
    viewportAxesScope,
    viewportFitSeed,
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
  const updateRotationSnapshot = useCallback((
    key: "viewport" | "viewCube" | "hsl",
    snapshot: OrientationDebugSnapshot,
  ) => {
    setRotationSnapshots((previous) => {
      const current = previous[key];
      if (current?.signature === snapshot.signature && current.cssTransform === snapshot.cssTransform) {
        return previous;
      }
      return { ...previous, [key]: snapshot };
    });
  }, []);
  const syncViewportRotationSnapshot = useCallback(() => {
    const bridge = viewCubeSceneRef.current;
    if (!bridge?.camera) {
      return;
    }
    updateRotationSnapshot("viewport", captureOrientationDebugSnapshot(bridge.camera));
  }, [updateRotationSnapshot]);
  const persistCameraState = useCallback(() => {
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
    onPersistCameraState(state);
  }, [cameraProjection, navigationMode, onPersistCameraState]);
  const handleSceneCameraChange = useCallback(() => {
    syncViewportRotationSnapshot();
    persistCameraState();
  }, [persistCameraState, syncViewportRotationSnapshot]);
  useSceneCameraChange(viewCubeSceneRef, handleSceneCameraChange);
  useEffect(() => {
    if (restoredCameraScopeRef.current === cameraPersistenceScope && cameraRestoreReadyRef.current) {
      syncViewportRotationSnapshot();
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
        lastFocusedObjectIdRef.current = persistedCameraState?.lastFocusedObjectId ?? null;
      }
      restoredCameraScopeRef.current = cameraPersistenceScope;
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
  }, [cameraPersistenceScope, persistedCameraState, syncViewportRotationSnapshot]);
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
  const shellTarget = useMemo(
    () => [dynamicGeomCenter.x, dynamicGeomCenter.y, dynamicGeomCenter.z] as [
      number,
      number,
      number,
    ],
    [dynamicGeomCenter.x, dynamicGeomCenter.y, dynamicGeomCenter.z],
  );
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
        toolbar={
          null
        }
        hud={null}
        projection={cameraProjection}
        navigation={navigationMode}
        qualityProfile={runtimeQualityProfile}
        renderPolicy={{
          mode: interactionActive || captureActive ? "always" : "demand",
          hidden: false,
          interactionActive,
        }}
        onInteractionChange={setInteractionActive}
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
        }}
        diagnosticOverrides={{
          enableControls:
            selectionOnlyInteractionMode || textureGizmoDragging ? false : true,
        }}
        telemetryLabel={
          quantityId
            ? `fem-${quantityId}-${runtimeRenderMode}`
            : `fem-${runtimeRenderMode}`
        }
      >
        {!missingExactScopeSegment ? (
          <>
          {FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showCameraAutoFit && wrapperFlags.enableCameraFitEffect ? (
            <CameraAutoFit
              maxDim={dynamicMaxDim}
              generation={cameraFitGeneration}
              targetCenter={dynamicGeomCenter}
              controlsRef={controlsRef}
            />
          ) : null}
          {FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showClipPlanesHelper ? (
            <FemClipPlanes enabled={clipEnabled} axis={clipAxis} posPercentage={clipPos} flip={clipFlip} geomSize={dynamicGeomSize} />
          ) : null}
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
            effectiveOpacity={effectiveOpacity}
            magneticBoundaryFaceIndices={magneticBoundaryFaceIndices}
            magneticElementIndices={magneticElementIndices}
            qualityPerFace={qualityPerFace}
            shrinkFactor={shrinkFactor}
            clipEnabled={clipEnabled}
            clipAxis={clipAxis}
            clipPos={clipPos}
            dynamicGeomCenter={dynamicGeomCenter}
            dynamicMaxDim={dynamicMaxDim}
            effectiveShowArrows={effectiveShowArrows}
            arrowField={arrowField}
            arrowDensity={runtimeArrowDensity}
            arrowColorMode={arrowColorMode}
            arrowMonoColor={arrowMonoColor}
            arrowAlpha={arrowAlpha}
            arrowLengthScale={arrowLengthScale}
            arrowThickness={arrowThickness}
            arrowSamplingMode={arrowSamplingMode}
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
            showSceneGeometry={FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showSceneGeometry}
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
            showSelectionHighlight={FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showSelectionHighlight}
            showAntennaOverlays={FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showAntennaOverlays}
            showSceneAxes={FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showSceneAxes}
            onArrowSampledCount={setSampledArrowCount}
          />
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
