/**
 * Overlay items hook for FEM viewport.
 *
 * Builds the array of ViewportOverlayDescriptor items that form
 * the toolbar, warnings, legend, HUD, and auxiliary overlays.
 * Extracted from FemMeshView3D.tsx to reduce file size.
 */

import { useMemo } from "react";
import type { MutableRefObject } from "react";
import type { ViewportOverlayDescriptor } from "../ViewportOverlayManager";
import type { ViewportQualityProfileId } from "../shared/viewportQualityProfiles";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { cn } from "@/lib/utils";
import type { OrientationDebugSnapshot } from "../camera/cameraOrientation";
import { glyphBudgetToMaxPoints } from "./vectorDensityBudget";
import { colorLegendLabel, colorLegendGradient } from "./femColorUtils";
import { FemViewportStatusBar } from "./FemViewportStatusBar";
import { FemViewportToolbar } from "./FemViewportToolbar";
import { FemRefineToolbar } from "./FemSelectionHUD";
import { FieldLegend } from "../field/FieldLegend";
import HslSphere from "../HslSphere";
import ViewCube from "../ViewCube";
import type { FemViewportOverlayPopover } from "./FemViewportTypes";
import type { FemLiveRenderDebugData } from "./FemLiveRenderDebugPanel";
import type {
  ArrowSamplingMode,
  FemColorField,
  FemArrowColorMode,
  RenderMode,
  ClipAxis,
  FemVectorDomainFilter,
  FemFerromagnetVisibilityMode,
  FemMeshData,
} from "./femMeshTypes";
import type { FemMeshPart } from "../../../lib/session/types";

type CameraPresetKey = string;

function colorLegendLengthLabel(args: {
  effectiveShowArrows: boolean;
  arrowColorMode: FemArrowColorMode;
  arrowField: FemColorField;
  fieldLabel?: string;
}): string | undefined {
  if (!args.effectiveShowArrows) {
    return undefined;
  }
  if (args.arrowColorMode === "orientation") {
    return "vector magnitude, arrow color = orientation";
  }
  if (args.arrowColorMode === "monochrome") {
    return "vector magnitude, arrow color = monochrome";
  }
  return `vector magnitude, arrow color = ${colorLegendLabel(args.arrowField, args.fieldLabel)}`;
}

function colorModeLabel(
  mode: FemColorField | FemArrowColorMode,
  fieldLabel?: string,
): string {
  if (mode === "monochrome") {
    return "monochrome";
  }
  return colorLegendLabel(mode, fieldLabel);
}

export interface UseFemOverlayItemsArgs {
  // Feature flags
  enableOverlayItemsModel: boolean;
  captureOverlayHidden: boolean;

  // Toolbar mode
  toolbarMode: "visible" | "hidden";

  // Toolbar-derived state
  toolbarRenderMode: RenderMode;
  toolbarRenderModeMixed: boolean;
  toolbarColorField: FemColorField;
  toolbarColorFieldMixed: boolean;
  toolbarOpacity: number;
  toolbarOpacityMixed: boolean;
  toolbarScopeLabel: string | null;

  // Arrow state
  arrowColorMode: FemArrowColorMode;
  arrowMonoColor: string;
  arrowAlpha: number;
  arrowLengthScale: number;
  arrowThickness: number;
  arrowSamplingMode: ArrowSamplingMode;
  showArrows: boolean;
  effectiveShowArrows: boolean;
  arrowsBlockReason: string | null;
  baseArrowDensity: number;
  effectiveArrowDensity: number;

  // Camera/navigation
  cameraProjection: "perspective" | "orthographic";
  navigationMode: "trackball" | "cad";
  qualityProfile: ViewportQualityProfileId;

  // Clip
  clipEnabled: boolean;
  clipAxis: ClipAxis;
  clipPos: number;
  clipFlip: boolean;

  // Parts & mesh
  hasMeshParts: boolean;
  meshParts: FemMeshPart[];
  visibleLayersCount: number;
  meshData: FemMeshData;
  missingMagneticMask: boolean;
  missingExactScopeSegment: boolean;
  selectedObjectId?: string | null;

  // Domain/visibility
  effectiveVectorDomainFilter: FemVectorDomainFilter;
  ferromagnetVisibilityMode: FemFerromagnetVisibilityMode;
  supportsAirboxOnlyVectors: boolean;
  shrinkFactor: number;

  // UI state
  labeledMode: boolean;
  legendOpen: boolean;
  partExplorerOpen?: boolean;
  openPopover:
    | "quantity"
    | "color"
    | "clip"
    | "display"
    | "vectors"
    | "camera"
    | "rotation"
    | "debug"
    | "info"
    | "panels"
    | null;
  selectedFaces: number[];
  effectiveShowOrientationLegend: boolean;
  interactionActive: boolean;
  liveRenderDebugData?: FemLiveRenderDebugData | null;

  // Legend data
  arrowField: FemColorField;
  legendField: FemColorField;
  colorLegendField: FemColorField | null;
  fieldLabel?: string;
  colorLegendStats: { min: number; max: number; mean: number } | null;

  // Quantity
  quantityId?: string;
  prominentQuantityOptions: Array<{
    id: string;
    shortLabel: string;
    label?: string;
    available: boolean;
  }>;

  // Callbacks
  applyToolbarRenderMode: (next: RenderMode) => void;
  applyToolbarColorField: (next: FemColorField) => void;
  applyToolbarOpacity: (next: number) => void;
  onArrowColorModeChange?: (v: FemArrowColorMode) => void;
  onArrowMonoColorChange?: (v: string) => void;
  onArrowAlphaChange?: (v: number) => void;
  onArrowLengthScaleChange?: (v: number) => void;
  onArrowThicknessChange?: (v: number) => void;
  onClipEnabledChange?: (v: boolean) => void;
  onClipAxisChange?: (v: ClipAxis) => void;
  onClipPosChange?: (v: number) => void;
  onShowArrowsChange?: (v: boolean) => void;
  onVectorDomainFilterChange?: (v: FemVectorDomainFilter) => void;
  onFerromagnetVisibilityModeChange?: (v: FemFerromagnetVisibilityMode) => void;
  onShrinkFactorChange?: (v: number) => void;
  onQuantityChange?: (id: string) => void;
  onTogglePartExplorer?: () => void;
  onRefine?: (faceIndices: number[], factor: number) => void;
  updateSharedPreviewMaxPoints: (maxPoints: number) => void;

  // Internal setters
  setInternalArrowColorMode: (v: FemArrowColorMode) => void;
  setInternalArrowMonoColor: (v: string) => void;
  setInternalArrowAlpha: (v: number) => void;
  setInternalArrowLengthScale: (v: number) => void;
  setInternalArrowThickness: (v: number) => void;
  setInternalArrowSamplingMode: (v: ArrowSamplingMode) => void;
  setInternalClipEnabled: (v: boolean) => void;
  setInternalClipAxis: (v: ClipAxis) => void;
  setInternalClipPos: (v: number) => void;
  setInternalClipFlip: (v: boolean) => void;
  setInternalShowArrows: (v: boolean) => void;
  setInternalVectorDomainFilter: (v: FemVectorDomainFilter) => void;
  setInternalFerromagnetVisibilityMode: (v: FemFerromagnetVisibilityMode) => void;
  setInternalShrinkFactor: (v: number) => void;
  setInternalPartExplorerOpen: (fn: (prev: boolean) => boolean) => void;

  setLabeledMode: (v: boolean) => void;
  toggleLegend: () => void;
  togglePartExplorerInternal: () => void;
  setOpenPopover: (id: FemViewportOverlayPopover) => void;
  setCameraProjection: (v: "perspective" | "orthographic") => void;
  setNavigationMode: (v: "trackball" | "cad") => void;
  setQualityProfile: (v: ViewportQualityProfileId) => void;
  setCameraPreset: (view: "reset" | "front" | "top" | "right") => void;
  setSelectedFaces: (faces: number[] | ((prev: number[]) => number[])) => void;
  takeScreenshot: () => void;
  handleViewCubeRotate: (quaternion: import("three").Quaternion) => void;
  viewCubeSceneRef: MutableRefObject<any>;
  rotationSnapshots: {
    viewport: OrientationDebugSnapshot | null;
    viewCube: OrientationDebugSnapshot | null;
    hsl: OrientationDebugSnapshot | null;
  };
  updateRotationSnapshot: (
    key: "viewport" | "viewCube" | "hsl",
    snapshot: OrientationDebugSnapshot,
  ) => void;
  applyRotationEuler: (nextEulerDeg: [number, number, number]) => void;
}

export function useFemOverlayItems(args: UseFemOverlayItemsArgs): ViewportOverlayDescriptor[] {
  return useMemo<ViewportOverlayDescriptor[]>(() => {
    if (!args.enableOverlayItemsModel) {
      return [];
    }
    if (args.captureOverlayHidden) {
      return [];
    }
    const items: ViewportOverlayDescriptor[] = [];
    if (FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showToolbar && args.toolbarMode !== "hidden") {
      items.push({
        id: "toolbar",
        anchor: "top-left",
        priority: 1,
        minWidth: 1080,
        collapseTarget: "icon",
        render: ({ variant }) => (
          <FemViewportToolbar
            compact={variant !== "full"}
            renderMode={args.toolbarRenderMode}
            surfaceColorField={args.toolbarColorField}
            arrowColorMode={args.arrowColorMode}
            arrowMonoColor={args.arrowMonoColor}
            arrowAlpha={args.arrowAlpha}
            arrowLengthScale={args.arrowLengthScale}
            arrowThickness={args.arrowThickness}
            arrowSamplingMode={args.arrowSamplingMode}
            projection={args.cameraProjection}
            navigation={args.navigationMode}
            qualityProfile={args.qualityProfile}
            clipEnabled={args.clipEnabled}
            clipAxis={args.clipAxis}
            clipPos={args.clipPos}
            clipFlip={args.clipFlip}
            arrowsVisible={args.showArrows}
            arrowDensity={args.baseArrowDensity}
            effectiveArrowDensity={args.effectiveArrowDensity}
            vectorDomainFilter={args.effectiveVectorDomainFilter}
            supportsAirboxOnlyVectors={args.supportsAirboxOnlyVectors}
            ferromagnetVisibilityMode={args.ferromagnetVisibilityMode}
            opacity={args.toolbarOpacity}
            shrinkFactor={args.shrinkFactor}
            showShrink={args.meshData.elements.length >= 4}
            labeledMode={variant === "full" ? args.labeledMode : false}
            legendOpen={args.legendOpen}
            partExplorerOpen={args.partExplorerOpen ?? false}
            visiblePartsCount={args.hasMeshParts ? args.visibleLayersCount : undefined}
            totalPartsCount={args.hasMeshParts ? args.meshParts.length : undefined}
            hasField={!args.missingMagneticMask}
            fieldLabel={args.fieldLabel}
            nNodes={args.meshData.nNodes}
            nElements={args.meshData.nElements}
            nFaces={Math.floor(args.meshData.boundaryFaces.length / 3)}
            selectedFacesCount={args.selectedFaces.length}
            openPopover={args.openPopover}
            onOpenPopoverChange={(id) => args.setOpenPopover(id as UseFemOverlayItemsArgs["openPopover"])}
            onRenderModeChange={args.applyToolbarRenderMode}
            onSurfaceColorFieldChange={args.applyToolbarColorField}
            onArrowColorModeChange={(next) => {
              if (args.onArrowColorModeChange) {
                args.onArrowColorModeChange(next);
              } else {
                args.setInternalArrowColorMode(next);
              }
            }}
            onArrowMonoColorChange={(next) => {
              if (args.onArrowMonoColorChange) {
                args.onArrowMonoColorChange(next);
              } else {
                args.setInternalArrowMonoColor(next);
              }
            }}
            onArrowAlphaChange={(next) => {
              if (args.onArrowAlphaChange) {
                args.onArrowAlphaChange(next);
              } else {
                args.setInternalArrowAlpha(next);
              }
            }}
            onArrowLengthScaleChange={(next) => {
              if (args.onArrowLengthScaleChange) {
                args.onArrowLengthScaleChange(next);
              } else {
                args.setInternalArrowLengthScale(next);
              }
            }}
            onArrowThicknessChange={(next) => {
              if (args.onArrowThicknessChange) {
                args.onArrowThicknessChange(next);
              } else {
                args.setInternalArrowThickness(next);
              }
            }}
            onArrowSamplingModeChange={(next) => {
              args.setInternalArrowSamplingMode(next);
            }}
            onProjectionChange={args.setCameraProjection}
            onNavigationChange={args.setNavigationMode}
            onQualityProfileChange={args.setQualityProfile}
            onClipEnabledChange={(v) => {
              if (args.onClipEnabledChange) {
                args.onClipEnabledChange(v);
              } else {
                args.setInternalClipEnabled(v);
              }
            }}
            onClipAxisChange={(a) => {
              if (args.onClipAxisChange) {
                args.onClipAxisChange(a);
              } else {
                args.setInternalClipAxis(a);
              }
            }}
            onClipPosChange={(v) => {
              if (args.onClipPosChange) {
                args.onClipPosChange(v);
              } else {
                args.setInternalClipPos(v);
              }
            }}
            onClipFlipChange={(v) => {
              args.setInternalClipFlip(v);
            }}
            onArrowsVisibleChange={(v) => {
              if (args.onShowArrowsChange) {
                args.onShowArrowsChange(v);
              } else {
                args.setInternalShowArrows(v);
              }
            }}
            onArrowDensityChange={(nextBudget) => {
              args.updateSharedPreviewMaxPoints(glyphBudgetToMaxPoints(nextBudget));
            }}
            onVectorDomainFilterChange={(next) => {
              if (args.onVectorDomainFilterChange) {
                args.onVectorDomainFilterChange(next);
              } else {
                args.setInternalVectorDomainFilter(next);
              }
            }}
            onFerromagnetVisibilityModeChange={(next) => {
              if (args.onFerromagnetVisibilityModeChange) {
                args.onFerromagnetVisibilityModeChange(next);
              } else {
                args.setInternalFerromagnetVisibilityMode(next);
              }
            }}
            onOpacityChange={args.applyToolbarOpacity}
            onShrinkFactorChange={(v) => {
              if (args.onShrinkFactorChange) {
                args.onShrinkFactorChange(v);
              } else {
                args.setInternalShrinkFactor(v);
              }
            }}
            onLabeledModeChange={args.setLabeledMode}
            onToggleLegend={args.toggleLegend}
            onTogglePartExplorer={() => {
              if (args.onTogglePartExplorer) {
                args.onTogglePartExplorer();
              } else {
                args.togglePartExplorerInternal();
              }
            }}
            onCameraPreset={args.setCameraPreset}
            onCapture={args.takeScreenshot}
            quantityId={args.quantityId}
            quantityOptions={args.prominentQuantityOptions}
            onQuantityChange={args.onQuantityChange}
            renderModeMixed={args.toolbarRenderModeMixed}
            opacityMixed={args.toolbarOpacityMixed}
            colorFieldMixed={args.toolbarColorFieldMixed}
            arrowsRequested={args.showArrows}
            arrowsBlockReason={args.arrowsBlockReason}
            toolbarScopeLabel={args.toolbarScopeLabel}
            interactionSimplified={args.interactionActive}
            rotationSnapshots={args.rotationSnapshots}
            onApplyRotationEuler={args.applyRotationEuler}
            liveRenderDebugData={args.liveRenderDebugData}
          />
        ),
      });
    }
    if (FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showWarnings && args.missingExactScopeSegment && args.selectedObjectId) {
      items.push({
        id: "segment-warning",
        anchor: "top-left",
        priority: 2,
        minWidth: 960,
        collapseTarget: "drawer",
        render: () => (
          <div className="pointer-events-none rounded-xl border border-error/25 bg-background/85 px-4 py-3 text-sm text-error/90 shadow-lg backdrop-blur-md">
            Object mesh segmentation unavailable for shared-domain FEM: `{args.selectedObjectId}`
          </div>
        ),
      });
    }
    if (FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showWarnings && args.missingMagneticMask) {
      items.push({
        id: "mask-warning",
        anchor: "top-left",
        priority: 3,
        minWidth: 960,
        collapseTarget: "drawer",
        render: () => (
          <div className="pointer-events-none rounded-xl border border-warning/25 bg-background/85 px-4 py-3 text-sm text-warning/90 shadow-lg backdrop-blur-md">
            Magnetic-domain mask unavailable for shared-domain FEM; magnetic-only field display may be unscoped.
          </div>
        ),
      });
    }
    if (FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showViewCube) {
      items.push({
        id: "gizmo-stack",
        anchor: "top-right",
        priority: 3,
        render: () => (
          <div className="flex flex-col items-end gap-2">
            <ViewCube
              sceneRef={args.viewCubeSceneRef}
              onRotate={args.handleViewCubeRotate}
              onReset={() => args.setCameraPreset("reset")}
              axisConvention="identity"
              size={1.52}
              onOrientationSnapshot={(snapshot) => args.updateRotationSnapshot("viewCube", snapshot)}
              embedded
            />
          </div>
        ),
      });
    }
    const showColorLegend =
      FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showFieldLegend &&
      args.legendOpen &&
      args.colorLegendField != null;
    const showOrientationLegend =
      FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showOrientationSphere &&
      args.effectiveShowOrientationLegend;
    if (showColorLegend || showOrientationLegend) {
      items.push({
        id: "legend-stack",
        anchor: "bottom-left",
        priority: 4,
        render: ({ variant }) => (
          <FieldLegend
            compact={variant !== "full"}
            className="pointer-events-none z-10"
            colorLabel={colorLegendLabel(args.legendField, args.fieldLabel)}
            lengthLabel={
              args.effectiveShowArrows
                ? args.arrowColorMode === "orientation"
                  ? "vector magnitude, arrow color = orientation"
                  : args.arrowColorMode === "monochrome"
                    ? "vector magnitude, arrow color = monochrome"
                    : `vector magnitude, arrow color = ${colorLegendLabel(args.arrowField, args.fieldLabel)}`
                : undefined
            }
            min={args.legendField === "none" ? undefined : args.colorLegendStats?.min}
            max={args.legendField === "none" ? undefined : args.colorLegendStats?.max}
            mean={args.legendField === "none" ? undefined : args.colorLegendStats?.mean}
            gradient={colorLegendGradient(args.legendField)}
          />
        ),
      });
    }
    if (FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showOrientationSphere && args.effectiveShowOrientationLegend) {
      items.push({
        id: "orientation-legend",
        anchor: "bottom-left",
        priority: 5,
        render: ({ variant }) => (
          <HslSphere
            sceneRef={args.viewCubeSceneRef}
            axisConvention="identity"
            compact={variant !== "full"}
            embedded
          />
        ),
      });
    }
    {
      const qSym =
        (args.prominentQuantityOptions.find((o) => o.id === args.quantityId) ?? null)
          ?.shortLabel ?? "m";
      if (FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showStatusBar) {
        items.push({
          id: "status-bar",
          anchor: "bottom-center",
          priority: 2,
          render: () => (
            <FemViewportStatusBar
              surfaceLabel={colorModeLabel(args.toolbarColorField, qSym)}
              arrowLabel={colorModeLabel(args.arrowColorMode, qSym)}
              arrowDensity={args.baseArrowDensity}
              effectiveDensity={args.effectiveArrowDensity}
              renderModeMixed={args.toolbarRenderModeMixed}
              opacityMixed={args.toolbarOpacityMixed}
              colorFieldMixed={args.toolbarColorFieldMixed}
              toolbarScopeLabel={args.toolbarScopeLabel}
              arrowsRequested={args.showArrows}
              arrowsVisible={args.effectiveShowArrows}
              arrowsBlockReason={args.arrowsBlockReason}
              interactionSimplified={args.interactionActive}
              hasField={!args.missingMagneticMask}
              fieldLabel={args.fieldLabel}
              visiblePartsCount={args.hasMeshParts ? args.visibleLayersCount : undefined}
              totalPartsCount={args.hasMeshParts ? args.meshParts.length : undefined}
            />
          ),
        });
      }
    }
    if (FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showSelectionHud) {
      items.push({
        id: "selection-hud",
        anchor: "bottom-right",
        priority: 5,
        render: ({ variant }) => (
          <>
            {args.onRefine ? (
              <FemRefineToolbar
                className={variant === "icon" ? "max-w-full flex-wrap justify-center" : undefined}
                selectedFacesCount={args.selectedFaces.length}
                onRefine={(factor) => {
                  args.onRefine!(args.selectedFaces, factor);
                  args.setSelectedFaces([]);
                }}
                onCoarsen={(factor) => {
                  args.onRefine!(args.selectedFaces, factor);
                  args.setSelectedFaces([]);
                }}
                onClear={() => args.setSelectedFaces([])}
              />
            ) : null}
          </>
        ),
      });
    }
    return items;
  }, [args]);
}
