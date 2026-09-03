import { afterEach, describe, expect, it } from "vitest";

import type { ResolvedRenderPlan } from "@/components/runs/control-room/visualizationStateSync";
import { DEFAULT_FEM_VIEWPORT_LAYER_STATE } from "@/features/viewport-unified/model/unifiedViewportTypes";
import { useVisualizationStore } from "../useVisualizationStore";

function plan(patch: Partial<ResolvedRenderPlan> = {}): ResolvedRenderPlan {
  return {
    quantity: {
      activeQuantityId: "m",
      fieldComponent: "magnitude",
      colormap: "viridis",
      autoContrast: true,
    },
    layers: {
      renderMode: "surface",
      meshOpacityPercent: 100,
      vectorsVisible: false,
      vectorDomainFilter: "auto",
      femLayers: DEFAULT_FEM_VIEWPORT_LAYER_STATE,
      passes: {
        surface: true,
        wireframe: false,
        volumeMesh: false,
        points: false,
        vectors: false,
        quantityOverlay: true,
      },
      airbox: {
        visible: false,
        surface: false,
        wireframe: false,
        points: false,
        vectors: false,
        opacityPercent: 28,
      },
      airboxVisible: false,
      airboxOpacityPercent: 28,
    },
    sampling: {
      maxPoints: 50_000,
      maxGlyphs: 1_200,
      profile: "balanced",
      progressive: true,
    },
    clip: {
      enabled: false,
      axis: "x",
      positionPercent: 50,
      flipped: false,
    },
    vectorStyle: {
      colorMode: "orientation",
      monoColor: "#00c2ff",
      alpha: 1,
      lengthScale: 1,
      thickness: 1,
      ferromagnetVisibility: "hide",
    },
    slice: {
      quantityId: "m",
      component: "magnitude",
      axis: "z",
      mode: "single",
      layerIndex: 0,
      positionPercent: 50,
      thicknessPercent: null,
      colormap: "viridis",
      autoContrast: true,
      showPrimitives: true,
      showMesh: false,
      showMagneticTexture: true,
      showAirbox: false,
      airboxRenderMode: "wireframe",
      showAirboxVectors: false,
      showQuantity: true,
      showVectors: false,
      renderMode: "heatmap",
      projectionReduction: "mean_occupied",
      projectionIncludeAirAsZero: false,
      projectionSamples: 20,
      projectionResolution: 128,
    },
    diagnostics: {
      warnings: [],
      degraded_reasons: [],
    },
    ...patch,
  };
}

describe("useVisualizationStore", () => {
  afterEach(() => {
    useVisualizationStore.setState({ resolvedRenderPlan: null });
  });

  it("keeps the previous resolved render plan when the next plan is structurally equal", () => {
    const first = plan();
    const second = plan();

    useVisualizationStore.getState().setResolvedRenderPlan(first);
    expect(useVisualizationStore.getState().resolvedRenderPlan).toBe(first);

    useVisualizationStore.getState().setResolvedRenderPlan(second);

    expect(useVisualizationStore.getState().resolvedRenderPlan).toBe(first);
  });

  it("updates the resolved render plan when the content changes", () => {
    const first = plan();
    const second = plan({
      sampling: {
        ...first.sampling,
        maxGlyphs: 2_400,
      },
    });

    useVisualizationStore.getState().setResolvedRenderPlan(first);
    useVisualizationStore.getState().setResolvedRenderPlan(second);

    expect(useVisualizationStore.getState().resolvedRenderPlan).toBe(second);
  });
});
