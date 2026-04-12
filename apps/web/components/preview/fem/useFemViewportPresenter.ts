import { useCallback, useEffect, useMemo, type MutableRefObject } from "react";
import { computeFaceAspectRatios } from "../r3f/colorUtils";
import { useFemOverlayItems } from "./useFemOverlayItems";
import type { ViewportQualityProfileId } from "../shared/viewportQualityProfiles";
import type { ViewportOverlayDescriptor } from "../ViewportOverlayManager";
import type { ArrowSamplingMode, FemColorField, FemMeshData, RenderMode, ClipAxis, FemArrowColorMode, FemVectorDomainFilter, FemFerromagnetVisibilityMode } from "./femMeshTypes";
import type { FemMeshPart } from "../../../lib/session/types";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";

interface UseFemViewportPresenterArgs {
  wrapperFlags: typeof FRONTEND_DIAGNOSTIC_FLAGS.femWrapper;
  qualityProfileRef: MutableRefObject<ViewportQualityProfileId>;
  qualityProfile: ViewportQualityProfileId;
  interactionActive: boolean;
  setHoveredFace: (value: any) => void;
  activeTransformScope: "object" | "texture" | null;
  textureGizmoDragging: boolean;
  setTextureGizmoDragging: (value: boolean) => void;
  meshData: FemMeshData;
  qualityPerFace?: number[] | null;
  hoveredFace: { idx: number } | null;
  captureOverlayHidden: boolean;
  toolbarMode: "visible" | "hidden";
  toolbarRenderMode: RenderMode;
  toolbarRenderModeMixed: boolean;
  toolbarColorField: FemColorField;
  toolbarColorFieldMixed: boolean;
  toolbarOpacity: number;
  toolbarOpacityMixed: boolean;
  toolbarScopeLabel: string | null;
  arrowColorMode: FemArrowColorMode;
  arrowMonoColor: string;
  arrowAlpha: number;
  arrowLengthScale: number;
  arrowThickness: number;
  arrowSamplingMode: ArrowSamplingMode;
  showArrowsRequested: boolean;
  effectiveShowArrows: boolean;
  arrowsBlockReason: string | null;
  baseArrowDensity: number;
  effectiveArrowDensity: number;
  cameraProjection: "perspective" | "orthographic";
  navigationMode: "trackball" | "cad";
  clipEnabled: boolean;
  clipAxis: ClipAxis;
  clipPos: number;
  clipFlip: boolean;
  hasMeshParts: boolean;
  meshParts: FemMeshPart[];
  visibleLayersCount: number;
  missingMagneticMask: boolean;
  missingExactScopeSegment: boolean;
  selectedObjectId?: string | null;
  effectiveVectorDomainFilter: FemVectorDomainFilter;
  ferromagnetVisibilityMode: FemFerromagnetVisibilityMode;
  supportsAirboxOnlyVectors: boolean;
  shrinkFactor: number;
  labeledMode: boolean;
  legendOpen: boolean;
  partExplorerOpen?: boolean;
  openPopover: "quantity" | "color" | "clip" | "display" | "vectors" | "camera" | "panels" | null;
  selectedFaces: number[];
  showOrientationLegend?: boolean;
  arrowField: FemColorField;
  legendField: FemColorField;
  fieldLabel?: string;
  fieldMagnitudeStats: { min: number; max: number; mean: number } | null;
  quantityId?: string;
  prominentQuantityOptions: Array<{
    id: string;
    shortLabel: string;
    label?: string;
    available: boolean;
  }>;
  applyToolbarRenderMode: (next: RenderMode) => void;
  applyToolbarColorField: (next: FemColorField) => void;
  applyToolbarOpacity: (next: number) => void;
  onArrowColorModeChange?: (v: FemArrowColorMode) => void;
  onArrowMonoColorChange?: (v: string) => void;
  onArrowAlphaChange?: (v: number) => void;
  onArrowLengthScaleChange?: (v: number) => void;
  onArrowThicknessChange?: (v: number) => void;
  onQuantityChange?: (id: string) => void;
  onTogglePartExplorer?: () => void;
  onRefine?: (faceIndices: number[], factor: number) => void;
  updateSharedPreviewMaxPoints: (maxPoints: number) => void;
  setInternalArrowColorMode: (v: FemArrowColorMode) => void;
  setInternalArrowMonoColor: (v: string) => void;
  setInternalArrowAlpha: (v: number) => void;
  setInternalArrowLengthScale: (v: number) => void;
  setInternalArrowThickness: (v: number) => void;
  setInternalArrowSamplingMode: (v: ArrowSamplingMode) => void;
  setInternalPartExplorerOpen: (fn: (prev: boolean) => boolean) => void;
  setLabeledMode: (v: boolean) => void;
  setOpenPopover: (id: "quantity" | "color" | "clip" | "display" | "vectors" | "camera" | "panels" | null) => void;
  setCameraProjection: (v: "perspective" | "orthographic") => void;
  setNavigationMode: (v: "trackball" | "cad") => void;
  setQualityProfile: (v: ViewportQualityProfileId) => void;
  setCameraPreset: (view: "reset" | "front" | "top" | "right") => void;
  setSelectedFaces: (faces: number[] | ((prev: number[]) => number[])) => void;
  setCtxMenu: (value: any) => void;
  takeScreenshot: () => void;
  handleViewCubeRotate: (quaternion: import("three").Quaternion) => void;
  viewCubeSceneRef: MutableRefObject<any>;
  setClipEnabled: (value: boolean) => void;
  toggleClip: () => void;
  setClipAxis: (value: ClipAxis) => void;
  setClipPos: (value: number) => void;
  setClipFlip: (value: boolean) => void;
  setArrowsVisible: (value: boolean) => void;
  setVectorDomainFilter: (value: FemVectorDomainFilter) => void;
  setFerromagnetVisibilityMode: (value: FemFerromagnetVisibilityMode) => void;
  setShrinkFactor: (value: number) => void;
  toggleLegend: () => void;
  togglePartExplorer: () => void;
}

export function useFemViewportPresenter(args: UseFemViewportPresenterArgs): {
  overlayItems: ViewportOverlayDescriptor[];
  hoveredFaceInfo: { faceIdx: number; ar: number; sicn: number | undefined } | null;
  onPointerMissed: (() => void) | undefined;
  handleContextInspectFace: (faceIdx: number) => void;
  handleContextShowQuality: () => void;
  handleContextToggleClip: () => void;
  handleContextClearSelection: () => void;
} {
  useEffect(() => {
    args.qualityProfileRef.current = args.qualityProfile;
  }, [args.qualityProfile, args.qualityProfileRef]);

  useEffect(() => {
    if (args.interactionActive) {
      args.setHoveredFace(null);
    }
  }, [args.interactionActive, args.setHoveredFace]);

  useEffect(() => {
    if (args.activeTransformScope === "object" && args.textureGizmoDragging) {
      args.setTextureGizmoDragging(false);
    }
  }, [args.activeTransformScope, args.textureGizmoDragging, args.setTextureGizmoDragging]);

  const faceAspectRatios = useMemo(
    () => computeFaceAspectRatios(args.meshData.nodes, args.meshData.boundaryFaces),
    [args.meshData.nodes, args.meshData.boundaryFaces],
  );

  const hoveredFaceInfo = useMemo(() => {
    if (!args.wrapperFlags.enableHoverTooltip) {
      return null;
    }
    if (!args.hoveredFace) return null;
    const idx = args.hoveredFace.idx;
    const ar = faceAspectRatios[idx] ?? 0;
    return { faceIdx: idx, ar, sicn: args.qualityPerFace?.[idx] };
  }, [args.hoveredFace, args.qualityPerFace, args.wrapperFlags.enableHoverTooltip, faceAspectRatios]);

  const effectiveShowOrientationLegend =
    Boolean(args.showOrientationLegend) ||
    args.legendField === "orientation" ||
    args.arrowColorMode === "orientation";

  const overlayItems = useFemOverlayItems({
    enableOverlayItemsModel: args.wrapperFlags.enableOverlayItemsModel,
    captureOverlayHidden: args.captureOverlayHidden,
    toolbarMode: args.toolbarMode,
    toolbarRenderMode: args.toolbarRenderMode,
    toolbarRenderModeMixed: args.toolbarRenderModeMixed,
    toolbarColorField: args.toolbarColorField,
    toolbarColorFieldMixed: args.toolbarColorFieldMixed,
    toolbarOpacity: args.toolbarOpacity,
    toolbarOpacityMixed: args.toolbarOpacityMixed,
    toolbarScopeLabel: args.toolbarScopeLabel,
    arrowColorMode: args.arrowColorMode,
    arrowMonoColor: args.arrowMonoColor,
    arrowAlpha: args.arrowAlpha,
    arrowLengthScale: args.arrowLengthScale,
    arrowThickness: args.arrowThickness,
    arrowSamplingMode: args.arrowSamplingMode,
    showArrows: args.showArrowsRequested,
    effectiveShowArrows: args.effectiveShowArrows,
    arrowsBlockReason: args.arrowsBlockReason,
    baseArrowDensity: args.baseArrowDensity,
    effectiveArrowDensity: args.effectiveArrowDensity,
    cameraProjection: args.cameraProjection,
    navigationMode: args.navigationMode,
    qualityProfile: args.qualityProfile,
    clipEnabled: args.clipEnabled,
    clipAxis: args.clipAxis,
    clipPos: args.clipPos,
    clipFlip: args.clipFlip,
    hasMeshParts: args.hasMeshParts,
    meshParts: args.meshParts,
    visibleLayersCount: args.visibleLayersCount,
    meshData: args.meshData,
    missingMagneticMask: args.missingMagneticMask,
    missingExactScopeSegment: args.missingExactScopeSegment,
    selectedObjectId: args.selectedObjectId,
    effectiveVectorDomainFilter: args.effectiveVectorDomainFilter,
    ferromagnetVisibilityMode: args.ferromagnetVisibilityMode,
    supportsAirboxOnlyVectors: args.supportsAirboxOnlyVectors,
    shrinkFactor: args.shrinkFactor,
    labeledMode: args.labeledMode,
    legendOpen: args.legendOpen,
    partExplorerOpen: args.partExplorerOpen,
    openPopover: args.openPopover,
    selectedFaces: args.selectedFaces,
    effectiveShowOrientationLegend,
    interactionActive: args.interactionActive,
    arrowField: args.arrowField,
    legendField: args.legendField,
    fieldLabel: args.fieldLabel,
    fieldMagnitudeStats: args.fieldMagnitudeStats,
    quantityId: args.quantityId,
    prominentQuantityOptions: args.prominentQuantityOptions,
    applyToolbarRenderMode: args.applyToolbarRenderMode,
    applyToolbarColorField: args.applyToolbarColorField,
    applyToolbarOpacity: args.applyToolbarOpacity,
    onArrowColorModeChange: args.onArrowColorModeChange,
    onArrowMonoColorChange: args.onArrowMonoColorChange,
    onArrowAlphaChange: args.onArrowAlphaChange,
    onArrowLengthScaleChange: args.onArrowLengthScaleChange,
    onArrowThicknessChange: args.onArrowThicknessChange,
    onClipEnabledChange: args.setClipEnabled,
    onClipAxisChange: args.setClipAxis,
    onClipPosChange: args.setClipPos,
    onShowArrowsChange: args.setArrowsVisible,
    onVectorDomainFilterChange: args.setVectorDomainFilter,
    onFerromagnetVisibilityModeChange: args.setFerromagnetVisibilityMode,
    onShrinkFactorChange: args.setShrinkFactor,
    onQuantityChange: args.onQuantityChange,
    onTogglePartExplorer: args.onTogglePartExplorer,
    onRefine: args.onRefine,
    updateSharedPreviewMaxPoints: args.updateSharedPreviewMaxPoints,
    setInternalArrowColorMode: args.setInternalArrowColorMode,
    setInternalArrowMonoColor: args.setInternalArrowMonoColor,
    setInternalArrowAlpha: args.setInternalArrowAlpha,
    setInternalArrowLengthScale: args.setInternalArrowLengthScale,
    setInternalArrowThickness: args.setInternalArrowThickness,
    setInternalArrowSamplingMode: args.setInternalArrowSamplingMode,
    setInternalClipEnabled: args.setClipEnabled,
    setInternalClipAxis: args.setClipAxis,
    setInternalClipPos: args.setClipPos,
    setInternalClipFlip: args.setClipFlip,
    setInternalShowArrows: args.setArrowsVisible,
    setInternalVectorDomainFilter: args.setVectorDomainFilter,
    setInternalFerromagnetVisibilityMode: args.setFerromagnetVisibilityMode,
    setInternalShrinkFactor: args.setShrinkFactor,
    setInternalPartExplorerOpen: args.setInternalPartExplorerOpen,
    setLabeledMode: args.setLabeledMode,
    toggleLegend: args.toggleLegend,
    togglePartExplorerInternal: args.togglePartExplorer,
    setOpenPopover: args.setOpenPopover,
    setCameraProjection: args.setCameraProjection,
    setNavigationMode: args.setNavigationMode,
    setQualityProfile: args.setQualityProfile,
    setCameraPreset: args.setCameraPreset,
    setSelectedFaces: args.setSelectedFaces,
    takeScreenshot: args.takeScreenshot,
    handleViewCubeRotate: args.handleViewCubeRotate,
    viewCubeSceneRef: args.viewCubeSceneRef,
  });

  const onPointerMissed = useCallback(() => {
    args.setSelectedFaces([]);
  }, [args.setSelectedFaces]);

  const handleContextInspectFace = useCallback((faceIdx: number) => {
    args.setSelectedFaces([faceIdx]);
    args.setCtxMenu(null);
  }, [args.setCtxMenu, args.setSelectedFaces]);

  const handleContextShowQuality = useCallback(() => {
    args.applyToolbarColorField("quality");
    args.setCtxMenu(null);
  }, [args.applyToolbarColorField, args.setCtxMenu]);

  const handleContextToggleClip = useCallback(() => {
    args.toggleClip();
    args.setCtxMenu(null);
  }, [args.setCtxMenu, args.toggleClip]);

  const handleContextClearSelection = useCallback(() => {
    args.setSelectedFaces([]);
    args.setCtxMenu(null);
  }, [args.setCtxMenu, args.setSelectedFaces]);

  return {
    overlayItems,
    hoveredFaceInfo,
    onPointerMissed,
    handleContextInspectFace,
    handleContextShowQuality,
    handleContextToggleClip,
    handleContextClearSelection,
  };
}
