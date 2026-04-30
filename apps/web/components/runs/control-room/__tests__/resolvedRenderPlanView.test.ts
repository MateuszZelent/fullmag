import { describe, expect, it } from "vitest";

import type { FemMeshPart, MeshEntityViewStateMap } from "@/lib/session/types";

import {
  resolveAirboxDisplayStateFromRenderPlan,
  resolveEffectiveFemMeshEntityViewStateFromRenderPlan,
} from "../resolvedRenderPlanView";
import type { ResolvedRenderPlan } from "../visualizationStateSync";

function airPart(): FemMeshPart {
  return part("air-1", "air");
}

function part(id: string, role: FemMeshPart["role"]): FemMeshPart {
  return {
    id,
    label: id,
    role,
    object_id: null,
    geometry_id: null,
    material_id: null,
    element_start: 0,
    element_count: 0,
    boundary_face_start: 0,
    boundary_face_count: 0,
    boundary_face_indices: [],
    node_start: 0,
    node_count: 0,
    node_indices: [],
    surface_faces: [],
    bounds_min: null,
    bounds_max: null,
  };
}

function plan(
  airbox: Partial<ResolvedRenderPlan["layers"]["airbox"]> = {},
): ResolvedRenderPlan {
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
      femLayers: {
        showPrimitives: true,
        showMesh: true,
        showMagneticTexture: true,
        showQuantity: true,
      },
      passes: {
        surface: true,
        wireframe: false,
        volumeMesh: false,
        points: false,
        vectors: false,
        quantityOverlay: true,
      },
      airbox: {
        visible: true,
        surface: false,
        wireframe: true,
        points: false,
        vectors: false,
        opacityPercent: 28,
        ...airbox,
      },
      airboxVisible: airbox.visible ?? true,
      airboxOpacityPercent: airbox.opacityPercent ?? 28,
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
    },
    diagnostics: {
      warnings: [],
      degraded_reasons: [],
    },
  };
}

describe("resolveAirboxDisplayStateFromRenderPlan", () => {
  it("uses independent airbox passes from the resolved render plan", () => {
    const result = resolveAirboxDisplayStateFromRenderPlan({
      plan: plan({ surface: true, wireframe: false, points: true }),
      representativePart: airPart(),
      meshEntityViewState: {},
    });

    expect(result).toMatchObject({
      geometryVisible: true,
      surface: true,
      wireframe: false,
      points: true,
      renderMode: "custom",
    });
  });

  it("hides geometry from the plan without losing pass checkbox state", () => {
    const result = resolveAirboxDisplayStateFromRenderPlan({
      plan: plan({ visible: false, surface: true, wireframe: true, points: true }),
      representativePart: airPart(),
      meshEntityViewState: {},
    });

    expect(result).toMatchObject({
      geometryVisible: false,
      surface: true,
      wireframe: true,
      points: true,
      renderMode: "wireframe",
    });
  });

  it("keeps scopes as per-part view state while passes come from the plan", () => {
    const part = airPart();
    const meshEntityViewState: MeshEntityViewStateMap = {
      [part.id]: {
        visible: true,
        geometryVisible: true,
        renderMode: "surface",
        renderPasses: {
          surface: true,
          wireframe: false,
          points: false,
        },
        wireframeScope: "full",
        pointsScope: "full",
        vectorsScope: "full",
        opacity: 28,
        colorField: "none",
      },
    };

    const result = resolveAirboxDisplayStateFromRenderPlan({
      plan: plan({ surface: false, wireframe: true, points: false }),
      representativePart: part,
      meshEntityViewState,
    });

    expect(result).toMatchObject({
      surface: false,
      wireframe: true,
      points: false,
      renderMode: "wireframe",
      wireframeScope: "full",
      pointsScope: "full",
      vectorsScope: "full",
    });
  });
});

describe("resolveEffectiveFemMeshEntityViewStateFromRenderPlan", () => {
  it("applies global render passes from the plan to default magnetic parts", () => {
    const magnetic = part("mag-1", "magnetic_object");

    const result = resolveEffectiveFemMeshEntityViewStateFromRenderPlan({
      plan: plan({
        visible: true,
      }),
      meshParts: [magnetic],
      meshEntityViewState: {},
      fallbackMeshRenderMode: "surface",
      fallbackMeshOpacity: 100,
      fallbackSelectedQuantity: "m",
    });

    expect(result[magnetic.id]).toMatchObject({
      renderMode: "surface",
      renderPasses: {
        surface: true,
        wireframe: false,
        volumeMesh: false,
        points: false,
      },
      geometryVisible: true,
      opacity: 100,
    });
  });

  it("keeps explicit non-air overrides while using plan layers for color state", () => {
    const magnetic = part("mag-1", "magnetic_object");
    const result = resolveEffectiveFemMeshEntityViewStateFromRenderPlan({
      plan: {
        ...plan(),
        layers: {
          ...plan().layers,
          femLayers: {
            showPrimitives: true,
            showMesh: true,
            showMagneticTexture: false,
            showQuantity: false,
          },
        },
      },
      meshParts: [magnetic],
      meshEntityViewState: {
        [magnetic.id]: {
          visible: true,
          geometryVisible: true,
          renderMode: "points",
          renderPasses: {
            surface: false,
            wireframe: false,
            points: true,
          },
          opacity: 64,
          colorField: "magnitude",
        },
      },
      fallbackMeshRenderMode: "surface",
      fallbackMeshOpacity: 100,
      fallbackSelectedQuantity: "m",
    });

    expect(result[magnetic.id]).toMatchObject({
      renderMode: "points",
      renderPasses: {
        surface: false,
        wireframe: false,
        points: true,
      },
      opacity: 64,
      colorField: "none",
    });
  });

  it("applies airbox render passes, visibility and opacity from the plan", () => {
    const air = airPart();
    const result = resolveEffectiveFemMeshEntityViewStateFromRenderPlan({
      plan: plan({
        visible: true,
        surface: true,
        wireframe: false,
        points: true,
        opacityPercent: 37,
      }),
      meshParts: [air],
      meshEntityViewState: {},
      fallbackMeshRenderMode: "surface",
      fallbackMeshOpacity: 100,
      fallbackSelectedQuantity: "m",
    });

    expect(result[air.id]).toMatchObject({
      renderMode: "surface",
      renderPasses: {
        surface: true,
        wireframe: false,
        volumeMesh: false,
        points: true,
      },
      geometryVisible: true,
      opacity: 37,
      colorField: "none",
    });
  });

  it("hides airbox geometry when the plan disables the airbox layer", () => {
    const air = airPart();
    const result = resolveEffectiveFemMeshEntityViewStateFromRenderPlan({
      plan: plan({
        visible: false,
        surface: true,
        wireframe: true,
        points: true,
      }),
      meshParts: [air],
      meshEntityViewState: {},
      fallbackMeshRenderMode: "surface",
      fallbackMeshOpacity: 100,
      fallbackSelectedQuantity: "m",
    });

    expect(result[air.id]).toMatchObject({
      geometryVisible: false,
      renderPasses: {
        surface: true,
        wireframe: true,
        points: true,
      },
    });
  });
});
