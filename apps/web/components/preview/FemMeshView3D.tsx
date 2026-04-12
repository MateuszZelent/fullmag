"use client";

import { useEffect, useRef, useState, useMemo, useCallback, memo } from "react";
import { computeFaceAspectRatios } from "./r3f/colorUtils";
import {
  SUPPORTED_ARROW_COLOR_FIELDS,
} from "./fem/femGeometryUtils";
import { buildPartRenderDataCache } from "@/features/viewport-fem/model/femTopologyCache";
import { FemClipPlanes, CameraAutoFit } from "./fem/FemR3FHelpers";
import { useFemVectorDomain } from "./fem/useFemVectorDomain";
import type {
  FemLiveMeshObjectSegment,
  FemMeshPart,
  MeshQualityStats,
  MeshEntityViewState,
  MeshEntityViewStateMap,
} from "../../lib/session/types";
import { defaultMeshEntityViewState } from "../../lib/session/types";
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
import {
  PREVIEW_MAX_POINTS_DEFAULT,
} from "./fem/vectorDensityBudget";
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
import { useFemToolbarModel } from "./fem/useFemToolbarModel";
import { useFemSceneGeometry } from "./fem/useFemSceneGeometry";
import { useFemOverlayItems } from "./fem/useFemOverlayItems";
import { RENDER_MODE_DISPLAY_PRESETS } from "./fem/renderModePresets";
import { useFemSubmeshSnapshot } from "./fem/useFemSubmeshSnapshot";
import { useFemFaceInteraction } from "./fem/useFemFaceInteraction";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { recordFrontendRender } from "@/lib/debug/frontendPerfDebug";
import { buildVisibleLayers } from "@/features/viewport-fem/model/femRenderModel";
export type {
  FemMeshData,
  MeshSelectionSnapshot,
  FemColorField,
  FemArrowColorMode,
  RenderMode,
  ClipAxis,
  FemVectorDomainFilter,
  FemFerromagnetVisibilityMode,
  RenderLayer,
} from "./fem/femMeshTypes";
import type {
  FemMeshData,
  MeshSelectionSnapshot,
  FemColorField,
  FemArrowColorMode,
  RenderMode,
  ClipAxis,
  FemVectorDomainFilter,
  FemFerromagnetVisibilityMode,
  RenderLayer,
} from "./fem/femMeshTypes";

const STABLE_ORIGIN: [number, number, number] = [0, 0, 0];

const AIR_OBJECT_SEGMENT_ID = "__air__";

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
}

type CameraProjection = "perspective" | "orthographic";
type NavigationMode = "trackball" | "cad";

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
}: Props) {
  if (FRONTEND_DIAGNOSTIC_FLAGS.renderDebug.enableRenderLogging) {
    recordFrontendRender("FemMeshView3DInner", {
      nNodes: meshData.nNodes,
      nElements: meshData.nElements,
      showSceneGeometry: FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showSceneGeometry,
      showPerPartGeometry: FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showPerPartGeometry,
    });
  }
  const [internalRenderMode, setInternalRenderMode] = useState<RenderMode>("surface");
  const [field, setField] = useState<FemColorField>(colorField);
  const [internalArrowColorMode, setInternalArrowColorMode] = useState<FemArrowColorMode>(
    SUPPORTED_ARROW_COLOR_FIELDS.has(colorField as FemArrowColorMode)
      ? (colorField as FemArrowColorMode)
      : "orientation",
  );
  const [internalArrowMonoColor, setInternalArrowMonoColor] = useState("#00c2ff");
  const [internalArrowAlpha, setInternalArrowAlpha] = useState(1);
  const [internalArrowLengthScale, setInternalArrowLengthScale] = useState(1);
  const [internalArrowThickness, setInternalArrowThickness] = useState(1);
  const [internalVectorDomainFilter, setInternalVectorDomainFilter] =
    useState<FemVectorDomainFilter>("auto");
  const [internalFerromagnetVisibilityMode, setInternalFerromagnetVisibilityMode] =
    useState<FemFerromagnetVisibilityMode>("hide");
  const [internalOpacity, setInternalOpacity] = useState(100);
  const [internalClipEnabled, setInternalClipEnabled] = useState(false);
  const [internalClipAxis, setInternalClipAxis] = useState<ClipAxis>("x");
  const [internalClipPos, setInternalClipPos] = useState(50);
  const [internalClipFlip, setInternalClipFlip] = useState(false);
  const [internalShowArrows, setInternalShowArrows] = useState(false);
  const [internalPreviewMaxPoints, setInternalPreviewMaxPoints] = useState(PREVIEW_MAX_POINTS_DEFAULT);
  const [internalShrinkFactor, setInternalShrinkFactor] = useState(1);
  const [cameraProjection, setCameraProjection] = useState<CameraProjection>("perspective");
  const [navigationMode, setNavigationMode] = useState<NavigationMode>("trackball");
  const [internalPartExplorerOpen, setInternalPartExplorerOpen] = useState(true);
  const [legendOpen, setLegendOpen] = useState(false);
  const [labeledMode, setLabeledMode] = useState(false);
  const [openPopover, setOpenPopover] = useState<"quantity" | "color" | "clip" | "display" | "vectors" | "camera" | "panels" | null>(null);
  const [qualityProfile, setQualityProfile] = useState<ViewportQualityProfileId>("interactive");
  const [interactionActive, setInteractionActive] = useState(false);
  const [textureGizmoDragging, setTextureGizmoDragging] = useState(false);
  const [sampledArrowCount, setSampledArrowCount] = useState<number | undefined>(undefined);
  const [captureActive, setCaptureActive] = useState(false);
  const [captureOverlayHidden, setCaptureOverlayHidden] = useState(false);

  const partExplorerOpen = controlledPartExplorerOpen ?? internalPartExplorerOpen;
  

  const [cameraFitGeneration, setCameraFitGeneration] = useState(0);

  const controlsRef = useRef<any>(null);
  const viewCubeSceneRef = useRef<any>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const qualityProfileRef = useRef<ViewportQualityProfileId>("interactive");
  const selectedObjectOverlay = useMemo(
    () =>
      selectedObjectId
        ? objectOverlays.find((overlay) => overlay.id === selectedObjectId) ?? null
        : null,
    [objectOverlays, selectedObjectId],
  );
  const renderMode = controlledRenderMode ?? internalRenderMode;
  const opacity = controlledOpacity ?? internalOpacity;
  const clipEnabled = controlledClipEnabled ?? internalClipEnabled;
  const clipAxis = controlledClipAxis ?? internalClipAxis;
  const clipPos = controlledClipPos ?? internalClipPos;
  const clipFlip = internalClipFlip;
  const showArrowsRequested = controlledShowArrowsRequested ?? internalShowArrows;
  const arrowColorMode = controlledArrowColorMode ?? internalArrowColorMode;
  const arrowMonoColor = controlledArrowMonoColor ?? internalArrowMonoColor;
  const arrowAlpha = controlledArrowAlpha ?? internalArrowAlpha;
  const arrowLengthScale = controlledArrowLengthScale ?? internalArrowLengthScale;
  const arrowThickness = controlledArrowThickness ?? internalArrowThickness;
  const vectorDomainFilter = controlledVectorDomainFilter ?? internalVectorDomainFilter;
  const ferromagnetVisibilityMode =
    controlledFerromagnetVisibilityMode ?? internalFerromagnetVisibilityMode;
  const resolvedPreviewMaxPoints = previewMaxPoints ?? internalPreviewMaxPoints;
  const shrinkFactor = controlledShrinkFactor ?? internalShrinkFactor;
  const updateSharedPreviewMaxPoints = useCallback((nextMaxPoints: number) => {
    if (onPreviewMaxPointsChange) {
      onPreviewMaxPointsChange(nextMaxPoints);
      return;
    }
    setInternalPreviewMaxPoints(nextMaxPoints);
  }, [onPreviewMaxPointsChange]);
  const hasMeshParts = meshParts.length > 0;
  const magneticSegments = useMemo(
    () => objectSegments.filter((segment) => segment.object_id !== AIR_OBJECT_SEGMENT_ID),
    [objectSegments],
  );
  const visibleMagneticIds = useMemo(() => {
    if (visibleObjectIds && visibleObjectIds.length > 0) {
      return new Set(visibleObjectIds);
    }
    return new Set(magneticSegments.map((segment) => segment.object_id));
  }, [magneticSegments, visibleObjectIds]);
  const airSegmentIds = useMemo(
    () =>
      airSegmentVisible
        ? new Set([AIR_OBJECT_SEGMENT_ID])
        : new Set<string>(),
    [airSegmentVisible],
  );
  const supportsAirboxOnlyVectors = meshData.quantityDomain === "full_domain";
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
  const effectiveVectorDomainFilter: FemVectorDomainFilter =
    vectorDomainFilter === "airbox_only" && !supportsAirboxOnlyVectors
      ? "auto"
      : vectorDomainFilter;
  const partRenderDataById = useMemo(() => {
    if (!wrapperFlags.enablePartDerivedModel) {
      return new Map<string, { boundaryFaceIndices: number[] | null; elementIndices: number[] | null; nodeMask: Uint8Array | null; surfaceFaces: [number, number, number][] | null }>();
    }
    return buildPartRenderDataCache(
      meshParts,
      meshData.boundaryFaces.length,
      meshData.nElements,
      meshData.nNodes,
    );
  }, [meshData.boundaryFaces.length, meshData.nElements, meshData.nNodes, meshParts, wrapperFlags.enablePartDerivedModel]);
  // P3 consolidation: Delegate to pure buildVisibleLayers from femRenderModel.ts
  const visibleLayers = useMemo<RenderLayer[]>(() => {
    if (!wrapperFlags.enablePartDerivedModel || !hasMeshParts) {
      return [];
    }
    return buildVisibleLayers({
      meshParts,
      partRenderDataById,
      meshEntityViewState,
      objectViewMode,
      vectorDomainFilter: effectiveVectorDomainFilter,
      ferromagnetVisibilityMode,
      selectedObjectId: selectedObjectId ?? null,
      selectedEntityId,
      focusedEntityId,
      airSegmentVisible,
    });
  }, [
    airSegmentVisible,
    effectiveVectorDomainFilter,
    ferromagnetVisibilityMode,
    focusedEntityId,
    hasMeshParts,
    meshEntityViewState,
    meshParts,
    objectViewMode,
    partRenderDataById,
    selectedEntityId,
    selectedObjectId,
    wrapperFlags.enablePartDerivedModel,
  ]);
  const { partQualityById } = useFemSubmeshSnapshot({
    meshParts,
    elementMarkers,
    perDomainQuality,
    hasMeshParts,
    visibleLayers,
    selectedEntityId,
    focusedEntityId,
    onVisibleSubmeshSnapshotChange,
  });
  const missingMagneticMask =
    meshData.quantityDomain === "magnetic_only" &&
    (!meshData.activeMask || meshData.activeMask.length !== meshData.nNodes);
  const missingExactScopeSegment =
    Boolean(selectedObjectId) &&
    meshData.nElements > 0 &&
    (hasMeshParts
      ? !meshParts.some(
          (part) => part.role === "magnetic_object" && part.object_id === selectedObjectId,
        )
      : !magneticSegments.some((segment) => segment.object_id === selectedObjectId));
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
    visibleArrowNodeCount,
  } = useFemVectorDomain({
    enableVectorDerivedModel: wrapperFlags.enableVectorDerivedModel,
    missingExactScopeSegment,
    selectedObjectId,
    magneticSegments,
    meshData,
    visibleMagneticIds,
    objectSegments,
    airSegmentIds,
    hasMeshParts,
    visibleLayers,
    effectiveVectorDomainFilter,
    ferromagnetVisibilityMode,
    resolvedPreviewMaxPoints,
    captureActive,
    interactionActive,
    qualityProfile,
    renderMode,
    airSegmentVisible,
  });
  const baseViewStateByPartId = useMemo(() => {
    const next = new Map<string, MeshEntityViewState>();
    if (!hasMeshParts) {
      return next;
    }
    for (const part of meshParts) {
      next.set(part.id, meshEntityViewState[part.id] ?? defaultMeshEntityViewState(part));
    }
    return next;
  }, [hasMeshParts, meshEntityViewState, meshParts]);
  
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
    toolbarStylePartIdSet,
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
    arrowToolbarState,
    toolbarScopeLabel,
    fieldMagnitudeStats,
    selectionScope,
  } = useFemToolbarModel({
    hasMeshParts,
    meshParts,
    visibleLayers,
    baseViewStateByPartId,
    renderMode,
    field,
    opacity,
    arrowColorMode,
    showArrows: showArrowsRequested,
    missingMagneticMask,
    visibleArrowNodeCount,
    meshData,
    baseArrowDensity,
    effectiveArrowDensity,
    qualityPerFace,
    sampledArrowCount,
    quantityOptions,
    selectedObjectId: selectedObjectId ?? null,
    selectedEntityId,
  });
  const effectiveOpacity = opacity;

  useEffect(() => { setField(colorField); }, [colorField]);
  useEffect(() => {
    if (controlledArrowColorMode != null) {
      return;
    }
    setInternalArrowColorMode(
      SUPPORTED_ARROW_COLOR_FIELDS.has(colorField as FemArrowColorMode)
        ? (colorField as FemArrowColorMode)
        : "orientation",
    );
  }, [colorField, controlledArrowColorMode]);

  // Auto-show legend when a scalar color mode is active (field_x/y/z/magnitude).
  useEffect(() => {
    const scalarModes: string[] = ["x", "y", "z", "magnitude"];
    if (scalarModes.includes(field) || scalarModes.includes(arrowColorMode)) {
      setLegendOpen(() => true);
    }
  }, [field, arrowColorMode]);

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

  const faceAspectRatios = useMemo(
    () => computeFaceAspectRatios(meshData.nodes, meshData.boundaryFaces),
    [meshData.nodes, meshData.boundaryFaces],
  );

  const hoveredFaceInfo = useMemo(() => {
    if (!wrapperFlags.enableHoverTooltip) {
      return null;
    }
    if (!hoveredFace) return null;
    const idx = hoveredFace.idx;
    const ar = faceAspectRatios[idx] ?? 0;
    return { faceIdx: idx, ar, sicn: qualityPerFace?.[idx] };
  }, [faceAspectRatios, hoveredFace, qualityPerFace, wrapperFlags.enableHoverTooltip]);
  const applyToolbarRenderMode = useCallback((next: RenderMode) => {
    const preset = RENDER_MODE_DISPLAY_PRESETS[next];
    const flags = FRONTEND_DIAGNOSTIC_FLAGS.femViewport;
    const masterReset = flags.resetDisplayStateOnRenderModeChange;

    if (hasMeshParts && toolbarStylePartIds.length > 0 && onMeshPartViewStatePatch) {
      if (masterReset && flags.resetOpacityOnRenderModeChange) {
        onMeshPartViewStatePatch(toolbarStylePartIds, {
          renderMode: next,
          opacity: preset.opacity,
        });
      } else {
        onMeshPartViewStatePatch(toolbarStylePartIds, { renderMode: next });
      }
      // D-05 fix: Only sync global meshRenderMode when toolbar operates at
      // universe scope. Use canonical selection scope instead of length
      // heuristic to avoid false positives in isolate mode.
      if (selectionScope.kind === "universe") {
        onRenderModeChange?.(next);
      }
    } else {
      if (onRenderModeChange) {
        onRenderModeChange(next);
      } else {
        setInternalRenderMode(next);
      }
      if (masterReset && flags.resetOpacityOnRenderModeChange) {
        if (onOpacityChange) {
          onOpacityChange(preset.opacity);
        } else {
          setInternalOpacity(preset.opacity);
        }
      }
    }

    if (!masterReset) {
      return;
    }
    // D-05 fix: Only reset global viewport settings (clip, arrows, domain, shrink, quality)
    // when the toolbar operates at universe scope, not on a scoped selection.
    if (selectionScope.kind !== "universe") {
      return;
    }
    if (flags.resetClipOnRenderModeChange) {
      if (onClipEnabledChange) {
        onClipEnabledChange(preset.clipEnabled);
      } else {
        setInternalClipEnabled(preset.clipEnabled);
      }
      if (onClipAxisChange) {
        onClipAxisChange(preset.clipAxis);
      } else {
        setInternalClipAxis(preset.clipAxis);
      }
      if (onClipPosChange) {
        onClipPosChange(preset.clipPos);
      } else {
        setInternalClipPos(preset.clipPos);
      }
    }
    if (flags.resetVectorDomainOnRenderModeChange) {
      if (onVectorDomainFilterChange) {
        onVectorDomainFilterChange(preset.vectorDomainFilter);
      } else {
        setInternalVectorDomainFilter(preset.vectorDomainFilter);
      }
      if (onFerromagnetVisibilityModeChange) {
        onFerromagnetVisibilityModeChange(preset.ferromagnetVisibilityMode);
      } else {
        setInternalFerromagnetVisibilityMode(preset.ferromagnetVisibilityMode);
      }
    }
    if (flags.resetShrinkOnRenderModeChange) {
      if (onShrinkFactorChange) {
        onShrinkFactorChange(preset.shrinkFactor);
      } else {
        setInternalShrinkFactor(preset.shrinkFactor);
      }
    }
    if (flags.resetQualityOnRenderModeChange) {
      setQualityProfile(preset.qualityProfile);
      updateSharedPreviewMaxPoints(PREVIEW_MAX_POINTS_DEFAULT);
    }
    setOpenPopover(null);
  }, [
    hasMeshParts,
    onClipAxisChange,
    onClipEnabledChange,
    onClipPosChange,
    onFerromagnetVisibilityModeChange,
    onMeshPartViewStatePatch,
    onOpacityChange,
    onRenderModeChange,
    onShrinkFactorChange,
    onVectorDomainFilterChange,
    selectionScope,
    toolbarStylePartIds,
    updateSharedPreviewMaxPoints,
  ]);
  const applyToolbarOpacity = useCallback((next: number) => {
    if (hasMeshParts && toolbarStylePartIds.length > 0 && onMeshPartViewStatePatch) {
      onMeshPartViewStatePatch(toolbarStylePartIds, { opacity: next });
      return;
    }
    if (onOpacityChange) {
      onOpacityChange(next);
    } else {
      setInternalOpacity(next);
    }
  }, [hasMeshParts, onMeshPartViewStatePatch, onOpacityChange, toolbarStylePartIds]);
  const applyToolbarColorField = useCallback((next: FemColorField) => {
    if (hasMeshParts && toolbarColorPartIds.length > 0 && onMeshPartViewStatePatch) {
      onMeshPartViewStatePatch(toolbarColorPartIds, { colorField: next });
      // Only sync global field when toolbar operates at universe scope.
      if (selectionScope.kind === "universe") {
        setField(next);
      }
      return;
    }
    setField(next);
  }, [hasMeshParts, onMeshPartViewStatePatch, selectionScope, toolbarColorPartIds]);
  const effectiveShowOrientationLegend =
    showOrientationLegend ||
    legendField === "orientation" ||
    arrowColorMode === "orientation";
  useEffect(() => {
    qualityProfileRef.current = qualityProfile;
  }, [qualityProfile]);
  useEffect(() => {
    if (interactionActive) {
      setHoveredFace(null);
    }
  }, [interactionActive, setHoveredFace]);
  useEffect(() => {
    if (activeTransformScope === "object" && textureGizmoDragging) {
      setTextureGizmoDragging(false);
    }
  }, [activeTransformScope, textureGizmoDragging]);
  const overlayItems = useFemOverlayItems({
    enableOverlayItemsModel: wrapperFlags.enableOverlayItemsModel,
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
    showArrows: showArrowsRequested,
    effectiveShowArrows,
    arrowsBlockReason,
    baseArrowDensity,
    effectiveArrowDensity,
    cameraProjection,
    navigationMode,
    qualityProfile,
    clipEnabled,
    clipAxis,
    clipPos,
    clipFlip,
    hasMeshParts,
    meshParts,
    visibleLayersCount: visibleLayers.length,
    meshData,
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
    effectiveShowOrientationLegend,
    interactionActive,
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
    onClipEnabledChange,
    onClipAxisChange,
    onClipPosChange,
    onShowArrowsChange,
    onVectorDomainFilterChange,
    onFerromagnetVisibilityModeChange,
    onShrinkFactorChange,
    onQuantityChange,
    onTogglePartExplorer,
    onRefine,
    updateSharedPreviewMaxPoints,
    setInternalArrowColorMode,
    setInternalArrowMonoColor,
    setInternalArrowAlpha,
    setInternalArrowLengthScale,
    setInternalArrowThickness,
    setInternalClipEnabled,
    setInternalClipAxis,
    setInternalClipPos,
    setInternalClipFlip,
    setInternalShowArrows,
    setInternalVectorDomainFilter,
    setInternalFerromagnetVisibilityMode,
    setInternalShrinkFactor,
    setInternalPartExplorerOpen,
    setLabeledMode,
    setLegendOpen,
    setOpenPopover,
    setCameraProjection,
    setNavigationMode,
    setQualityProfile,
    setCameraPreset,
    setSelectedFaces,
    takeScreenshot,
    handleViewCubeRotate,
    viewCubeSceneRef,
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
          mode: "always",
          hidden: false,
          interactionActive,
        }}
        onInteractionChange={setInteractionActive}
        target={STABLE_ORIGIN}
        bridgeRef={viewCubeSceneRef}
        controlsRef={controlsRef}
        onViewCubeRotate={handleViewCubeRotate}
        onResetView={() => setCameraPreset("reset")}
        renderDefaultGizmos={false}
        onPointerMissed={geometryPointerInteractionsEnabled ? () => setSelectedFaces([]) : undefined}
        onCanvasContextMenu={(e) => e.preventDefault()}
        onCanvasCreated={({ gl }) => {
          canvasRef.current = gl.domElement;
        }}
        diagnosticOverrides={{
          enableControls:
            selectionOnlyInteractionMode || textureGizmoDragging ? false : true,
          forceFrameloopMode: "always",
        }}
      >
        {!missingExactScopeSegment ? (
          <>
          {FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showCameraAutoFit && wrapperFlags.enableCameraFitEffect ? (
            <CameraAutoFit maxDim={dynamicMaxDim} generation={cameraFitGeneration} controlsRef={controlsRef} />
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
          onInspectFace={(faceIdx) => {
            setSelectedFaces([faceIdx]);
            setCtxMenu(null);
          }}
          onShowQuality={() => {
            applyToolbarColorField("quality");
            setCtxMenu(null);
          }}
          onToggleClip={() => {
            const next = !clipEnabled;
            if (onClipEnabledChange) {
              onClipEnabledChange(next);
            } else {
              setInternalClipEnabled(next);
            }
            setCtxMenu(null);
          }}
          onClearSelection={() => {
            setSelectedFaces([]);
            setCtxMenu(null);
          }}
        />
      ) : null}
    </div>
  );
}

export default memo(FemMeshView3DInner);
