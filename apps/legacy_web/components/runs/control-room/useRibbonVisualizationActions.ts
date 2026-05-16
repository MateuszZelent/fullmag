import { useCallback, useMemo } from "react";
import {
  useSlice2DToolbarStore,
  type Slice2DToolbarState,
} from "@/src/features/slice2d";
import {
  percentFromWorldPosition,
  worldPositionFromPercent,
  positionPercentFromSliceIndex,
  resolveEffectiveSlicePlane,
  resolveSliceAxisSelection,
  sliceAxisFromPlane,
  sliceIndexFromPositionPercent,
} from "@/src/features/slice2d/axisMapping";
import type {
  AirboxDisplayPatch,
  ViewportMeshRenderMode,
} from "@/components/shell/ribbon/command-registry";
import { useViewportRenderState } from "@/features/visualization/hooks/useVizSlice";
import { defaultMeshEntityViewState } from "@/lib/session/types";
import {
  normalizeSliceComponent,
  surfaceColorFieldFromRibbonComponent,
  type RibbonPreviewComponent,
} from "./controlRoomShellHelpers";
import type { VisualizationAction } from "./visualizationReducer";
import { useSlice2DAirboxStore } from "./slice2DToolbarStore";
import {
  reduceAirboxDisplayTransaction,
} from "./airboxDisplayReducer";
import {
  resolveAirboxDisplayStateFromRenderPlan,
} from "./resolvedRenderPlanView";
import {
  visualizationPatchForClip,
  visualizationPatchForFemLayers,
  visualizationPatchForRenderMode,
  visualizationPatchForVectorStyle,
} from "./visualizationStateSync";
import type {
  ModelContextValue,
  ViewportContextValue,
} from "./context-hooks";

export function useRibbonVisualizationActions({
  femDiscretization,
  model,
  viewport,
}: {
  femDiscretization: boolean;
  model: ModelContextValue;
  viewport: ViewportContextValue;
}) {
  const slice2DToolbarPatch = useSlice2DToolbarStore((state) => state.patch);
  const normalAxisBounds = useSlice2DToolbarStore((state) => state.normalAxisBounds);
  const magneticExtent = useSlice2DToolbarStore((state) => state.magneticExtent);
  const positionWorld = useSlice2DToolbarStore((state) => state.positionWorld);
  const patchSlice2DToolbar = useSlice2DToolbarStore((state) => state.patchToolbar);
  const airboxStore = useSlice2DAirboxStore();
  const viz = useViewportRenderState();

  const handleRibbonPreviewComponent = useCallback((component: RibbonPreviewComponent) => {
    const nextComponent = component === "3D" ? "magnitude" : component;
    viewport.setComponent(nextComponent);
    void viewport.patchDisplay({
      view_mode: component === "3D" ? "3d" : "2d",
      field_component: nextComponent,
    });
    const nextColorField = surfaceColorFieldFromRibbonComponent(component);
    model.setMeshEntityViewState((previous) => {
      let changed = false;
      const next = { ...previous };
      for (const part of model.meshParts) {
        if (part.role !== "magnetic_object") {
          continue;
        }
        const current = next[part.id] ?? defaultMeshEntityViewState(part);
        if (current.colorField === nextColorField) {
          if (!next[part.id]) {
            next[part.id] = current;
            changed = true;
          }
          continue;
        }
        next[part.id] = { ...current, colorField: nextColorField };
        changed = true;
      }
      return changed ? next : previous;
    });
  }, [model, viewport]);

  const handleRibbonPreviewEveryN = useCallback((everyN: number) => {
    void viewport.patchDisplay({ vector_density: everyN });
  }, [viewport.patchDisplay]);

  const handleRibbonPreviewMaxPoints = useCallback((maxPoints: number) => {
    void viewport.patchDisplay({ max_points: maxPoints });
  }, [viewport.patchDisplay]);

  const handleRibbonPreviewColormap = useCallback((colormap: string) => {
    void viewport.patchDisplay({ colormap });
  }, [viewport.patchDisplay]);

  const handleRibbonPreviewAutoScale = useCallback((enabled: boolean) => {
    void viewport.patchDisplay({ auto_contrast: enabled });
  }, [viewport.patchDisplay]);

  const effectiveSlicePlane = resolveEffectiveSlicePlane({
    plane: viewport.plane,
    clipAxis: viz.meshClipAxis,
    preferClipAxis: Boolean(femDiscretization),
  });
  const canonicalSliceToolbar = model.resolvedRenderPlan?.slice ?? null;

  const slice2DToolbar = useMemo<Slice2DToolbarState>(() => {
    const fallbackToolbar: Slice2DToolbarState = {
      quantityId: String(viewport.requestedPreviewQuantity ?? viewport.selectedQuantity ?? "m"),
      component: normalizeSliceComponent(viewport.requestedPreviewComponent ?? viewport.component),
      axis: sliceAxisFromPlane(effectiveSlicePlane),
      mode: viewport.requestedPreviewAllLayers ? "all_layers" : "single",
      layerIndex: viewport.sliceIndex,
      positionPercent: femDiscretization
        ? (viz.meshClipPos ?? 50)
        : positionPercentFromSliceIndex({
          grid: viewport.previewGrid,
          plane: effectiveSlicePlane,
          sliceIndex: viewport.sliceIndex,
        }),
      positionWorld:
        femDiscretization
          ? (
            positionWorld ?? (
              normalAxisBounds
                ? worldPositionFromPercent(
                  normalAxisBounds.min,
                  normalAxisBounds.max,
                  viz.meshClipPos ?? 50,
                )
                : null
            )
          )
          : null,
      normalAxisBounds,
      magneticExtent,
      thicknessPercent: null,
      colormap: "viridis",
      autoContrast: Boolean(viewport.requestedPreviewAutoScale ?? true),
      showPrimitives: viz.femViewportLayers.showPrimitives,
      showMesh: viz.femViewportLayers.showMesh,
      showMagneticTexture: viz.femViewportLayers.showMagneticTexture,
      showAirbox: false,
      airboxRenderMode: "wireframe",
      showAirboxVectors: false,
      showQuantity: viz.femViewportLayers.showQuantity,
      showVectors: Boolean(viz.meshShowArrows),
      vectorDensity: viewport.requestedPreviewEveryN ?? 4,
      renderMode: viz.meshShowArrows ? "vectors" : "heatmap",
      projectionReduction: "mean_occupied",
      projectionIncludeAirAsZero: false,
      projectionSamples: 20,
      projectionResolution: 128,
    };
    const localProjectionPatch: Partial<Slice2DToolbarState> = {};
    if (slice2DToolbarPatch.projectionReduction) {
      localProjectionPatch.projectionReduction = slice2DToolbarPatch.projectionReduction;
    }
    if (typeof slice2DToolbarPatch.projectionIncludeAirAsZero === "boolean") {
      localProjectionPatch.projectionIncludeAirAsZero =
        slice2DToolbarPatch.projectionIncludeAirAsZero;
    }
    if (typeof slice2DToolbarPatch.projectionSamples === "number") {
      localProjectionPatch.projectionSamples = slice2DToolbarPatch.projectionSamples;
    }
    if (typeof slice2DToolbarPatch.projectionResolution === "number") {
      localProjectionPatch.projectionResolution = slice2DToolbarPatch.projectionResolution;
    }
    if (typeof slice2DToolbarPatch.vectorDensity === "number") {
      localProjectionPatch.vectorDensity = slice2DToolbarPatch.vectorDensity;
    }
    if (typeof slice2DToolbarPatch.showAirbox === "boolean") {
      localProjectionPatch.showAirbox = slice2DToolbarPatch.showAirbox;
    }
    if (slice2DToolbarPatch.airboxRenderMode) {
      localProjectionPatch.airboxRenderMode = slice2DToolbarPatch.airboxRenderMode;
    }
    if (typeof slice2DToolbarPatch.showAirboxVectors === "boolean") {
      localProjectionPatch.showAirboxVectors = slice2DToolbarPatch.showAirboxVectors;
    }
    if (typeof slice2DToolbarPatch.positionPercent === "number") {
      localProjectionPatch.positionPercent = slice2DToolbarPatch.positionPercent;
    }
    if (typeof slice2DToolbarPatch.positionWorld === "number" || slice2DToolbarPatch.positionWorld === null) {
      localProjectionPatch.positionWorld = slice2DToolbarPatch.positionWorld;
    }
    if (slice2DToolbarPatch.normalAxisBounds !== undefined) {
      localProjectionPatch.normalAxisBounds = slice2DToolbarPatch.normalAxisBounds;
    }
    if (slice2DToolbarPatch.magneticExtent !== undefined) {
      localProjectionPatch.magneticExtent = slice2DToolbarPatch.magneticExtent;
    }
    return canonicalSliceToolbar
      ? {
        ...canonicalSliceToolbar,
        normalAxisBounds,
        magneticExtent,
        positionWorld,
        ...localProjectionPatch,
      }
      : {
        ...fallbackToolbar,
        positionWorld,
        normalAxisBounds,
        magneticExtent,
        ...slice2DToolbarPatch,
      };
  }, [
    canonicalSliceToolbar,
    effectiveSlicePlane,
    femDiscretization,
    magneticExtent,
    normalAxisBounds,
    positionWorld,
    slice2DToolbarPatch,
    viz.femViewportLayers,
    viz.meshClipPos,
    viz.meshShowArrows,
    viewport.component,
    viewport.previewGrid,
    viewport.requestedPreviewAllLayers,
    viewport.requestedPreviewAutoScale,
    viewport.requestedPreviewComponent,
    viewport.requestedPreviewEveryN,
    viewport.requestedPreviewQuantity,
    viewport.selectedQuantity,
    viewport.sliceIndex,
  ]);

  const airboxParts = model.meshParts.filter((part) => part.role === "air" || part.role === "outer_boundary");
  const airboxRepresentativePart = airboxParts[0] ?? model.airPart;
  const airboxDisplayState = resolveAirboxDisplayStateFromRenderPlan({
    plan: model.resolvedRenderPlan,
    representativePart: airboxRepresentativePart,
    meshEntityViewState: model.meshEntityViewState,
  });
  const airMeshRenderMode: ViewportMeshRenderMode | null =
    airboxDisplayState.renderMode === "custom" ? null : airboxDisplayState.renderMode;
  const ribbonFemLayers = model.resolvedRenderPlan?.layers.femLayers ?? viz.femViewportLayers;
  const ribbonAirboxVisible = model.resolvedRenderPlan?.layers.airbox.visible ?? viz.airMeshVisible;

  const handleRibbonSlice2DToolbar = useCallback((patch: Partial<Slice2DToolbarState>) => {
    const sliceDisplayPatches: Array<Parameters<typeof viewport.patchDisplay>[0]> = [];
    const queueSliceDisplayPatch = (displayPatch: Parameters<typeof viewport.patchDisplay>[0]) => {
      sliceDisplayPatches.push(displayPatch);
    };
    const flushSliceDisplayPatches = () => {
      if (sliceDisplayPatches.length === 0) {
        return;
      }
      queueMicrotask(() => {
        for (const displayPatch of sliceDisplayPatches) {
          void viewport.patchDisplay(displayPatch);
        }
      });
    };
    const nextPatch: Partial<Slice2DToolbarState> = { ...patch };
    const axisSelection = nextPatch.axis
      ? resolveSliceAxisSelection({
        axis: nextPatch.axis,
        syncClipAxis: Boolean(femDiscretization),
      })
      : null;
    const targetPlane = axisSelection?.plane ?? effectiveSlicePlane;
    if (typeof nextPatch.positionWorld === "number" && slice2DToolbar.normalAxisBounds) {
      nextPatch.positionPercent = percentFromWorldPosition(
        slice2DToolbar.normalAxisBounds.min,
        slice2DToolbar.normalAxisBounds.max,
        nextPatch.positionWorld,
      );
    } else if (
      typeof nextPatch.positionPercent === "number" &&
      slice2DToolbar.normalAxisBounds &&
      nextPatch.positionWorld === undefined
    ) {
      nextPatch.positionWorld = worldPositionFromPercent(
        slice2DToolbar.normalAxisBounds.min,
        slice2DToolbar.normalAxisBounds.max,
        nextPatch.positionPercent,
      );
    }
    if (nextPatch.axis && femDiscretization) {
      nextPatch.normalAxisBounds = null;
      nextPatch.magneticExtent = null;
      if (nextPatch.positionPercent === undefined) {
        nextPatch.positionPercent = 50;
      }
      if (nextPatch.positionWorld === undefined) {
        nextPatch.positionWorld = null;
      }
    }
    if (nextPatch.quantityId) {
      viewport.requestPreviewQuantity(nextPatch.quantityId);
    }
    if (nextPatch.component) {
      handleRibbonPreviewComponent(nextPatch.component);
    }
    if (nextPatch.axis) {
      viewport.setPlane(targetPlane);
      if (!femDiscretization) {
        const centeredPercent =
          typeof nextPatch.positionPercent === "number" ? nextPatch.positionPercent : 50;
        const centeredSliceIndex = sliceIndexFromPositionPercent({
          grid: viewport.previewGrid,
          plane: targetPlane,
          positionPercent: centeredPercent,
        });
        nextPatch.positionPercent = centeredPercent;
        nextPatch.layerIndex = centeredSliceIndex;
        viewport.setSliceIndex(centeredSliceIndex);
        void viewport.patchDisplay({ slice_layer: centeredSliceIndex });
      }
    }
    patchSlice2DToolbar(nextPatch);
    if (nextPatch.mode) {
      queueSliceDisplayPatch({ slice_mode: nextPatch.mode === "all_layers" ? "all" : nextPatch.mode });
    }
    if (typeof nextPatch.layerIndex === "number") {
      viewport.setSliceIndex(nextPatch.layerIndex);
      queueSliceDisplayPatch({ slice_layer: nextPatch.layerIndex });
    }
    if (typeof nextPatch.positionPercent === "number") {
      const nextSliceIndex = sliceIndexFromPositionPercent({
        grid: viewport.previewGrid,
        plane: targetPlane,
        positionPercent: nextPatch.positionPercent,
      });
      viewport.setSliceIndex(nextSliceIndex);
      queueSliceDisplayPatch({ slice_layer: nextSliceIndex });
    }
    flushSliceDisplayPatches();
    if (nextPatch.colormap) {
      handleRibbonPreviewColormap(nextPatch.colormap);
    }
    if (typeof nextPatch.autoContrast === "boolean") {
      handleRibbonPreviewAutoScale(nextPatch.autoContrast);
    }
    if (typeof nextPatch.showVectors === "boolean") {
      void viewport.patchDisplay({
        layers: {
          vectors: {
            visible: nextPatch.showVectors,
          },
        },
      });
      if (!nextPatch.showVectors && viz.femViewportLayers.showMagneticTexture && !viz.femViewportLayers.showQuantity) {
        viewport.requestPreviewQuantity("m");
      }
    }
    if (typeof nextPatch.showPrimitives === "boolean") {
      void viewport.patchDisplay(visualizationPatchForFemLayers({
        ...ribbonFemLayers,
        showPrimitives: nextPatch.showPrimitives,
      }));
    }
    if (typeof nextPatch.showMesh === "boolean") {
      void viewport.patchDisplay(visualizationPatchForFemLayers({
        ...ribbonFemLayers,
        showMesh: nextPatch.showMesh,
      }));
    }
    if (typeof nextPatch.showMagneticTexture === "boolean") {
      void viewport.patchDisplay(visualizationPatchForFemLayers({
        ...ribbonFemLayers,
        showMagneticTexture: nextPatch.showMagneticTexture,
        showQuantity: nextPatch.showMagneticTexture ? false : ribbonFemLayers.showQuantity,
      }));
      if (nextPatch.showMagneticTexture) {
        viewport.requestPreviewQuantity("m");
      }
    }
    if (typeof nextPatch.showQuantity === "boolean") {
      void viewport.patchDisplay(visualizationPatchForFemLayers({
        ...ribbonFemLayers,
        showQuantity: nextPatch.showQuantity,
        showMagneticTexture: nextPatch.showQuantity ? false : ribbonFemLayers.showMagneticTexture,
      }));
    }
  }, [
    effectiveSlicePlane,
    femDiscretization,
    handleRibbonPreviewAutoScale,
    handleRibbonPreviewColormap,
    handleRibbonPreviewComponent,
    patchSlice2DToolbar,
    ribbonFemLayers,
    slice2DToolbar.normalAxisBounds,
    viz.femViewportLayers,
    viewport,
  ]);

  const handleRibbonFemArrowStyle = useCallback((patch: Partial<{
    colorMode: "orientation" | "x" | "y" | "z" | "magnitude" | "monochrome";
    monoColor: string;
    alpha: number;
    lengthScale: number;
    thickness: number;
    domain: "auto" | "magnetic_only" | "full_domain" | "airbox_only";
    ferromagnetVisibility: "hide" | "ghost";
  }>) => {
    void viewport.patchDisplay({
      ...visualizationPatchForVectorStyle(patch),
      layers: patch.domain
        ? {
            vectors: {
              domain: patch.domain,
            },
          }
        : undefined,
    });
  }, [viewport.patchDisplay]);

  const handleRibbonAirboxDisplay = useCallback((patch: AirboxDisplayPatch) => {
    const transaction = reduceAirboxDisplayTransaction({
      patch,
      airboxParts,
      meshEntityViewState: model.meshEntityViewState,
    });
    if (transaction.displayPatch) {
      void viewport.patchDisplay(transaction.displayPatch);
    }
    if (transaction.meshEntityViewStateChanged) {
      model.setMeshEntityViewState(transaction.meshEntityViewState);
    }
  }, [airboxParts, model, viewport.patchDisplay]);

  const handleDispatchVisualization = useCallback((action: VisualizationAction) => {
    switch (action.type) {
      case "airbox.setVisible2D": {
        airboxStore.setShowAirbox2D(action.visible);
        patchSlice2DToolbar({ showAirbox: action.visible });
        if (airboxStore.sync2D3D) {
          handleRibbonAirboxDisplay({ visible: action.visible });
        }
        return;
      }
      default:
        break;
    }
  }, [airboxStore, handleRibbonAirboxDisplay, patchSlice2DToolbar]);

  const handleRibbonMeshRenderMode = useCallback((nextMode: ViewportMeshRenderMode) => {
    void viewport.patchDisplay(visualizationPatchForRenderMode(nextMode));
  }, [viewport.patchDisplay]);

  return {
    airboxDisplayState,
    airMeshRenderMode,
    handleDispatchVisualization,
    handleRibbonAirboxDisplay,
    handleRibbonFemArrowStyle,
    handleRibbonMeshRenderMode,
    handleRibbonPreviewAutoScale,
    handleRibbonPreviewColormap,
    handleRibbonPreviewComponent,
    handleRibbonPreviewEveryN,
    handleRibbonPreviewMaxPoints,
    handleRibbonSlice2DToolbar,
    ribbonAirboxVisible,
    ribbonFemLayers,
    slice2DToolbar,
  };
}
