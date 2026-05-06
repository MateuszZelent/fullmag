import { useCallback, useMemo } from "react";
import {
  useSlice2DToolbarStore,
  type Slice2DToolbarState,
} from "@/src/features/slice2d";
import {
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
  const patchSlice2DToolbar = useSlice2DToolbarStore((state) => state.patchToolbar);
  const airboxStore = useSlice2DAirboxStore();

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
    clipAxis: model.meshClipAxis,
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
        ? (model.meshClipPos ?? 50)
        : positionPercentFromSliceIndex({
          grid: viewport.previewGrid,
          plane: effectiveSlicePlane,
          sliceIndex: viewport.sliceIndex,
        }),
      thicknessPercent: null,
      colormap: "viridis",
      autoContrast: Boolean(viewport.requestedPreviewAutoScale ?? true),
      showPrimitives: model.femViewportLayers.showPrimitives,
      showMesh: model.femViewportLayers.showMesh,
      showMagneticTexture: model.femViewportLayers.showMagneticTexture,
      showAirbox: false,
      airboxRenderMode: "wireframe",
      showAirboxVectors: false,
      showQuantity: model.femViewportLayers.showQuantity,
      showVectors: Boolean(model.meshShowArrows),
      renderMode: model.meshShowArrows ? "vectors" : "heatmap",
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
    if (typeof slice2DToolbarPatch.positionPercent === "number") {
      localProjectionPatch.positionPercent = slice2DToolbarPatch.positionPercent;
    }
    return canonicalSliceToolbar
      ? { ...canonicalSliceToolbar, ...localProjectionPatch }
      : { ...fallbackToolbar, ...slice2DToolbarPatch };
  }, [
    canonicalSliceToolbar,
    effectiveSlicePlane,
    femDiscretization,
    model.femViewportLayers,
    model.meshClipPos,
    model.meshShowArrows,
    slice2DToolbarPatch,
    viewport.component,
    viewport.previewGrid,
    viewport.requestedPreviewAllLayers,
    viewport.requestedPreviewAutoScale,
    viewport.requestedPreviewComponent,
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
  const ribbonFemLayers = model.resolvedRenderPlan?.layers.femLayers ?? model.femViewportLayers;
  const ribbonAirboxVisible = model.resolvedRenderPlan?.layers.airbox.visible ?? model.airMeshVisible;

  const handleRibbonSlice2DToolbar = useCallback((patch: Partial<Slice2DToolbarState>) => {
    patchSlice2DToolbar(patch);
    if (patch.quantityId) {
      viewport.requestPreviewQuantity(patch.quantityId);
    }
    if (patch.component) {
      handleRibbonPreviewComponent(patch.component);
    }
    if (patch.axis) {
      const nextSliceAxis = resolveSliceAxisSelection({
        axis: patch.axis,
        syncClipAxis: Boolean(femDiscretization),
      });
      viewport.setPlane(nextSliceAxis.plane);
      if (nextSliceAxis.clipAxis) {
        void viewport.patchDisplay(visualizationPatchForClip({ axis: nextSliceAxis.clipAxis }));
      }
    }
    if (patch.mode) {
      void viewport.patchDisplay({ slice_mode: patch.mode === "all_layers" ? "all" : patch.mode });
    }
    if (typeof patch.layerIndex === "number") {
      viewport.setSliceIndex(patch.layerIndex);
      void viewport.patchDisplay({ slice_layer: patch.layerIndex });
      if (femDiscretization) {
        void viewport.patchDisplay(
          visualizationPatchForClip({
            positionPercent: positionPercentFromSliceIndex({
              grid: viewport.previewGrid,
              plane: effectiveSlicePlane,
              sliceIndex: patch.layerIndex,
            }),
          }),
        );
      }
    }
    if (typeof patch.positionPercent === "number") {
      const nextSliceIndex = sliceIndexFromPositionPercent({
        grid: viewport.previewGrid,
        plane: effectiveSlicePlane,
        positionPercent: patch.positionPercent,
      });
      void viewport.patchDisplay(visualizationPatchForClip({ positionPercent: patch.positionPercent }));
      viewport.setSliceIndex(nextSliceIndex);
      void viewport.patchDisplay({ slice_layer: nextSliceIndex });
    }
    if (patch.colormap) {
      handleRibbonPreviewColormap(patch.colormap);
    }
    if (typeof patch.autoContrast === "boolean") {
      handleRibbonPreviewAutoScale(patch.autoContrast);
    }
    if (typeof patch.showVectors === "boolean") {
      void viewport.patchDisplay({
        layers: {
          vectors: {
            visible: patch.showVectors,
          },
        },
      });
      if (!patch.showVectors && model.femViewportLayers.showMagneticTexture && !model.femViewportLayers.showQuantity) {
        viewport.requestPreviewQuantity("m");
      }
    }
    if (typeof patch.showPrimitives === "boolean") {
      void viewport.patchDisplay(visualizationPatchForFemLayers({
        ...ribbonFemLayers,
        showPrimitives: patch.showPrimitives,
      }));
    }
    if (typeof patch.showMesh === "boolean") {
      void viewport.patchDisplay(visualizationPatchForFemLayers({
        ...ribbonFemLayers,
        showMesh: patch.showMesh,
      }));
    }
    if (typeof patch.showMagneticTexture === "boolean") {
      void viewport.patchDisplay(visualizationPatchForFemLayers({
        ...ribbonFemLayers,
        showMagneticTexture: patch.showMagneticTexture,
        showQuantity: patch.showMagneticTexture ? false : ribbonFemLayers.showQuantity,
      }));
      if (patch.showMagneticTexture) {
        viewport.requestPreviewQuantity("m");
      }
    }
    if (typeof patch.showQuantity === "boolean") {
      void viewport.patchDisplay(visualizationPatchForFemLayers({
        ...ribbonFemLayers,
        showQuantity: patch.showQuantity,
        showMagneticTexture: patch.showQuantity ? false : ribbonFemLayers.showMagneticTexture,
      }));
    }
  }, [
    effectiveSlicePlane,
    femDiscretization,
    handleRibbonPreviewAutoScale,
    handleRibbonPreviewColormap,
    handleRibbonPreviewComponent,
    model.femViewportLayers,
    patchSlice2DToolbar,
    ribbonFemLayers,
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
