"use client";

import { useEffect, useMemo, useRef, useState, memo, useCallback } from "react";
import * as THREE from "three";
import { FemClipPlanes, CameraAutoFit } from "./fem/FemR3FHelpers";
import { useFemViewportModel } from "./fem/useFemViewportModel";
import { useFemViewportCommands } from "./fem/useFemViewportCommands";
import { useFemViewportDerivedModel } from "./fem/useFemViewportDerivedModel";
import { useFemViewportPresenter } from "./fem/useFemViewportPresenter";
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
import {
  captureOrientationDebugSnapshot,
  type OrientationDebugSnapshot,
} from "./camera/cameraOrientation";
import { useSceneCameraChange } from "./camera/useSceneCameraChange";
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

/* ── Opacity constants (extracted from hardcoded values) ── */
const DIMMED_MIN_MAGNETIC = 14;
const DIMMED_MIN_AIR = 8;
const SELECTED_LIFT_MAGNETIC = 96;
const SELECTED_LIFT_AIR = 52;

interface Props {
  meshData: FemMeshData;
  colorField?: FemColorField;
  fieldLabel?: string;
  quantityId?: string;
  quantityOptions?: Array<{
    id: string;
    shortLabel: string;
    label?: string;
    available: boolean;
  }>;
  showWireframe?: boolean;
  topologyKey?: string;
  toolbarMode?: "visible" | "hidden";
  renderMode?: RenderMode;
  opacity?: number;
  clipEnabled?: boolean;
  clipAxis?: ClipAxis;
  clipPos?: number;
  showArrowsRequested?: boolean;
  arrowColorMode?: FemArrowColorMode;
  arrowMonoColor?: string;
  arrowAlpha?: number;
  arrowLengthScale?: number;
  arrowThickness?: number;
  vectorDomainFilter?: FemVectorDomainFilter;
  ferromagnetVisibilityMode?: FemFerromagnetVisibilityMode;
  previewMaxPoints?: number;
  showOrientationLegend?: boolean;
  qualityPerFace?: number[] | null;
  shrinkFactor?: number;
  viewportFitSeed?: string | number;
  onRenderModeChange?: (value: RenderMode) => void;
  onOpacityChange?: (value: number) => void;
  onClipEnabledChange?: (value: boolean) => void;
  onClipAxisChange?: (value: ClipAxis) => void;
  onClipPosChange?: (value: number) => void;
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
  focusObjectRequest?: FocusObjectRequest | null;
  worldExtent?: [number, number, number] | null;
  worldCenter?: [number, number, number] | null;
  onAntennaTranslate?: (id: string, dx: number, dy: number, dz: number) => void;
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
}

/* ── Component ─────────────────────────────────────────────────────── */

function FemMeshView3DInner({
  meshData,
  colorField = "orientation",
  fieldLabel,
  quantityId,
  quantityOptions = [],
  toolbarMode = "visible",
  renderMode: controlledRenderMode,
  opacity: controlledOpacity,
  clipEnabled: controlledClipEnabled,
  clipAxis: controlledClipAxis,
  clipPos: controlledClipPos,
  showArrowsRequested: controlledShowArrowsRequested,
  arrowColorMode: controlledArrowColorMode,
  arrowMonoColor: controlledArrowMonoColor,
  arrowAlpha: controlledArrowAlpha,
  arrowLengthScale: controlledArrowLengthScale,
  arrowThickness: controlledArrowThickness,
  vectorDomainFilter: controlledVectorDomainFilter,
  ferromagnetVisibilityMode: controlledFerromagnetVisibilityMode,
  previewMaxPoints,
  showOrientationLegend = false,
  qualityPerFace,
  topologyKey,
  viewportFitSeed,
  shrinkFactor: controlledShrinkFactor,
  onRenderModeChange,
  onOpacityChange,
  onClipEnabledChange,
  onClipAxisChange,
  onClipPosChange,
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
  focusObjectRequest = null,
  onAntennaTranslate,
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
    controlledShowArrowsRequested,
    controlledArrowColorMode,
    controlledArrowMonoColor,
    controlledArrowAlpha,
    controlledArrowLengthScale,
    controlledArrowThickness,
    controlledVectorDomainFilter,
    controlledFerromagnetVisibilityMode,
    controlledShrinkFactor,
    previewMaxPoints,
    onPreviewMaxPointsChange,
  });
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
  
  const topologySignature = topologyKey ?? `${meshData.nNodes}:${meshData.nElements}:${meshData.boundaryFaces.length}`;
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
    fieldMagnitudeStats,
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
    activeTextureTransform,
    selectedObjectOverlay,
    objectOverlays,
    focusObjectRequest,
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
  useSceneCameraChange(viewCubeSceneRef, syncViewportRotationSnapshot);
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
    arrowField,
    legendField,
    fieldLabel,
    fieldMagnitudeStats,
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
                : "ghost"
            }
            field={field}
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
            focusedEntityId={focusedEntityId}
            selectedAntennaId={selectedAntennaId}
            onAntennaTranslate={onAntennaTranslate}
            axesWorldExtent={axesWorldExtent}
            axesCenter={axesCenter}
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
