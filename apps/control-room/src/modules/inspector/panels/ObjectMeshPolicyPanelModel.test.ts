import { describe, expect, it } from "vitest";

import type { MeshObjectConfigResource } from "@/kernel/api/apiTypes";

import {
  buildObjectMeshPolicyReplaceRequest,
  defaultObjectMeshPolicyResource,
  draftFromObjectMeshPolicyResource,
  draftKeyForObjectMeshPolicyResource,
  formatObjectMeshPolicyConfig,
} from "./ObjectMeshPolicyPanelModel";

function objectMeshPolicyDraft(
  patch: Partial<ReturnType<typeof draftFromObjectMeshPolicyResource>>,
) {
  return {
    ...draftFromObjectMeshPolicyResource(defaultObjectMeshPolicyResource("free-layer")),
    ...patch,
  };
}

describe("ObjectMeshPolicyPanelModel", () => {
  it("formats nullable backend config as an editable object draft", () => {
    expect(formatObjectMeshPolicyConfig(null)).toBe("{}");
    expect(
      formatObjectMeshPolicyConfig({
        curvature_factor: 0.3,
        maximum_element_size: 5e-9,
      }),
    ).toContain("\"maximum_element_size\": 5e-9");
  });

  it("creates drafts and stable keys from the backend object policy resource", () => {
    const absent = defaultObjectMeshPolicyResource("free-layer");
    const present = {
      config: {
        algorithm_2d: 6,
        algorithm_3d: 10,
        boundary_layer_count: 3,
        boundary_layer_stretching: 1.2,
        boundary_layer_target_curve_tags: [11, 12],
        boundary_layer_target_surface_tags: [7, 8],
        boundary_layer_thickness: 2e-9,
        compute_quality: true,
        maximum_element_size: 5e-9,
        mesh_strategy: "swept_prism",
        optimize: "Netgen",
        optimize_iterations: 2,
        per_element_quality: false,
        smoothing_steps: 4,
        sweep_face_meshing: "triangular",
        through_thickness_distribution: "fixed",
        through_thickness_elements: 1,
      },
      object_id: "free-layer",
      revision: 7,
    };

    expect(draftFromObjectMeshPolicyResource(absent)).toMatchObject({
      configText: "{}",
      present: false,
    });
    expect(draftFromObjectMeshPolicyResource(present)).toMatchObject({
      algorithm2d: "6",
      algorithm3d: "10",
      boundaryLayerCount: "3",
      boundaryLayerStretching: "1.2",
      boundaryLayerTargetCurveTags: "11, 12",
      boundaryLayerTargetSurfaceTags: "7, 8",
      boundaryLayerThickness: "2e-9",
      computeQuality: "true",
      meshStrategy: "swept_prism",
      optimize: "Netgen",
      optimizeIterations: "2",
      perElementQuality: "false",
      present: true,
      smoothingSteps: "4",
      sweepFaceMeshing: "triangular",
      throughThicknessDistribution: "fixed",
      throughThicknessElements: "1",
    });
    expect(draftKeyForObjectMeshPolicyResource("free-layer", present)).toContain(
      "free-layer:7:",
    );
  });

  it("hydrates structured fields from script-exported numeric strings", () => {
    const resource = {
      config: {
        curvature_factor: "0.35",
        maximum_element_growth_rate: "1.22",
        maximum_element_size: "6e-09",
        minimum_element_size: "1.8e-09",
        narrow_region_resolution: "1",
        order: 1,
        transition_distance: "8e-08",
        transition_growth: 1.18,
      },
      object_id: "arch_waveguide",
      revision: 3,
    };

    expect(draftFromObjectMeshPolicyResource(resource)).toMatchObject({
      curvatureFactor: "0.35",
      maximumElementGrowthRate: "1.22",
      maximumElementSize: "6e-09",
      minimumElementSize: "1.8e-09",
      narrowRegionResolution: "1",
      order: "1",
      transitionDistance: "8e-08",
      transitionGrowth: "1.18",
    });
  });

  it("hydrates a structured manual Box size field from object policy config", () => {
    const resource: MeshObjectConfigResource = {
      config: {
        size_fields: [
          {
            kind: "SurfaceDistanceThreshold",
            params: {
              DistMax: 4e-9,
              DistMin: 0,
              GeometryName: "free-layer",
              SizeMax: 8e-9,
              SizeMin: 2e-9,
            },
          },
          {
            kind: "Box",
            source: "object_policy_manual_box",
            params: {
              VIn: 1e-9,
              VOut: 1e22,
              XMax: 5e-8,
              XMin: -5e-8,
              YMax: 2e-8,
              YMin: -2e-8,
              ZMax: 3e-9,
              ZMin: -3e-9,
            },
          },
        ],
      },
      object_id: "free-layer",
      revision: 4,
    };

    expect(draftFromObjectMeshPolicyResource(resource)).toMatchObject({
      manualBoxSizeFieldEnabled: true,
      manualBoxSizeFieldVIn: "1e-9",
      manualBoxSizeFieldVOut: "1e+22",
      manualBoxSizeFieldXMax: "5e-8",
      manualBoxSizeFieldXMin: "-5e-8",
      manualBoxSizeFieldYMax: "2e-8",
      manualBoxSizeFieldYMin: "-2e-8",
      manualBoxSizeFieldZMax: "3e-9",
      manualBoxSizeFieldZMin: "-3e-9",
    });
  });

  it("builds a replace request for enabled and disabled object mesh policies", () => {
    expect(
      buildObjectMeshPolicyReplaceRequest(objectMeshPolicyDraft({
        configText: "{}",
        algorithm2d: "6",
        algorithm3d: "10",
        boundaryLayerCount: "2",
        boundaryLayerStretching: "1.3",
        boundaryLayerTargetCurveTags: "11, 12",
        boundaryLayerTargetSurfaceTags: "7, 8",
        boundaryLayerThickness: "2e-9",
        computeQuality: "true",
        maximumElementSize: "5e-9",
        meshStrategy: "swept_prism",
        optimize: "Netgen",
        optimizeIterations: "3",
        perElementQuality: "true",
        present: true,
        smoothingSteps: "2",
        sweepFaceMeshing: "triangular",
        throughThicknessDistribution: "fixed",
        throughThicknessElements: "1",
      })),
    ).toEqual({
      request: {
        config: {
          algorithm_2d: 6,
          algorithm_3d: 10,
          boundary_layer_count: 2,
          boundary_layer_stretching: 1.3,
          boundary_layer_target_curve_tags: [11, 12],
          boundary_layer_target_surface_tags: [7, 8],
          boundary_layer_thickness: 2e-9,
          compute_quality: true,
          maximum_element_size: 5e-9,
          mesh_strategy: "swept_prism",
          optimize: "Netgen",
          optimize_iterations: 3,
          per_element_quality: true,
          smoothing_steps: 2,
          sweep_face_meshing: "triangular",
          through_thickness_distribution: "fixed",
          through_thickness_elements: 1,
        },
      },
    });

    expect(
      buildObjectMeshPolicyReplaceRequest(objectMeshPolicyDraft({
        configText: "{ \"maximum_element_size\": 5e-9 }",
        present: false,
      })),
    ).toEqual({
      request: { config: null },
    });
  });

  it("builds a structured manual Box size field without passing metadata as Gmsh params", () => {
    expect(
      buildObjectMeshPolicyReplaceRequest(objectMeshPolicyDraft({
        configText: JSON.stringify({
          size_fields: [
            {
              kind: "SurfaceDistanceThreshold",
              params: {
                DistMax: 4e-9,
                DistMin: 0,
                GeometryName: "free-layer",
                SizeMax: 8e-9,
                SizeMin: 2e-9,
              },
            },
            {
              kind: "Box",
              params: {
                Source: "object_policy_manual_box",
                VIn: 4e-9,
                VOut: 1e22,
                XMax: 1,
                XMin: 0,
                YMax: 1,
                YMin: 0,
                ZMax: 1,
                ZMin: 0,
              },
            },
          ],
        }),
        manualBoxSizeFieldEnabled: true,
        manualBoxSizeFieldSource: "object_policy_manual_box",
        manualBoxSizeFieldVIn: "2e-9",
        manualBoxSizeFieldVOut: "1e22",
        manualBoxSizeFieldXMax: "2e-8",
        manualBoxSizeFieldXMin: "-2e-8",
        manualBoxSizeFieldYMax: "3e-8",
        manualBoxSizeFieldYMin: "-3e-8",
        manualBoxSizeFieldZMax: "4e-9",
        manualBoxSizeFieldZMin: "-4e-9",
        present: true,
      })),
    ).toEqual({
      request: {
        config: {
          size_fields: [
            {
              kind: "SurfaceDistanceThreshold",
              params: {
                DistMax: 4e-9,
                DistMin: 0,
                GeometryName: "free-layer",
                SizeMax: 8e-9,
                SizeMin: 2e-9,
              },
            },
            {
              kind: "Box",
              source: "object_policy_manual_box",
              params: {
                VIn: 2e-9,
                VOut: 1e22,
                XMax: 2e-8,
                XMin: -2e-8,
                YMax: 3e-8,
                YMin: -3e-8,
                ZMax: 4e-9,
                ZMin: -4e-9,
              },
            },
          ],
        },
      },
    });
  });

  it("rejects malformed and non-object mesh policy config drafts", () => {
    expect(
      buildObjectMeshPolicyReplaceRequest(objectMeshPolicyDraft({
        configText: "[1, 2, 3]",
        present: true,
      })),
    ).toEqual({
      error: "Object mesh policy config must be a JSON object.",
    });

    expect(
      buildObjectMeshPolicyReplaceRequest(objectMeshPolicyDraft({
        configText: "{",
        present: true,
      })),
    ).toEqual({
      error: "Object mesh policy config must be a JSON object.",
    });
  });

  it("rejects malformed boundary-layer target tag lists", () => {
    expect(
      buildObjectMeshPolicyReplaceRequest(objectMeshPolicyDraft({
        boundaryLayerTargetSurfaceTags: "1, bad",
        configText: "{}",
        present: true,
      })),
    ).toEqual({
      error: "Boundary-layer surface tags must be a comma-separated list of positive integers.",
    });
  });

  it("rejects invalid manual Box size-field bounds", () => {
    expect(
      buildObjectMeshPolicyReplaceRequest(objectMeshPolicyDraft({
        configText: "{}",
        manualBoxSizeFieldEnabled: true,
        manualBoxSizeFieldVIn: "2e-9",
        manualBoxSizeFieldVOut: "1e22",
        manualBoxSizeFieldXMax: "0",
        manualBoxSizeFieldXMin: "1e-9",
        manualBoxSizeFieldYMax: "1e-8",
        manualBoxSizeFieldYMin: "0",
        manualBoxSizeFieldZMax: "1e-9",
        manualBoxSizeFieldZMin: "0",
        present: true,
      })),
    ).toEqual({
      error: "Box X max must be greater than Box X min.",
    });
  });
});
