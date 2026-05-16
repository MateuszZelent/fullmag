import { describe, expect, it } from "vitest";

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
        maximum_element_size: 5e-9,
        mesh_strategy: "swept_prism",
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
      meshStrategy: "swept_prism",
      present: true,
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

  it("builds a replace request for enabled and disabled object mesh policies", () => {
    expect(
      buildObjectMeshPolicyReplaceRequest(objectMeshPolicyDraft({
        configText: "{}",
        maximumElementSize: "5e-9",
        meshStrategy: "swept_prism",
        present: true,
        sweepFaceMeshing: "triangular",
        throughThicknessDistribution: "fixed",
        throughThicknessElements: "1",
      })),
    ).toEqual({
      request: {
        config: {
          maximum_element_size: 5e-9,
          mesh_strategy: "swept_prism",
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
});
