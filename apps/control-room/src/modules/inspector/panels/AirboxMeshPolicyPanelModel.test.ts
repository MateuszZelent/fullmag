import { describe, expect, it } from "vitest";

import {
  AIRBOX_GRADING_MODES,
  buildAirboxMeshPolicyReplaceRequest,
  defaultUniverseMeshPolicyResource,
  draftFromUniverseMeshPolicyResource,
  draftKeyForUniverseMeshPolicyResource,
  formatUniverseMeshPolicyConfig,
} from "./AirboxMeshPolicyPanelModel";

describe("AirboxMeshPolicyPanelModel", () => {
  it("formats nullable universe mesh config as an editable object draft", () => {
    expect(formatUniverseMeshPolicyConfig(null)).toBe("{}");
    expect(
      formatUniverseMeshPolicyConfig({
        airbox_grading: "linear",
        airbox_hmax: 8e-9,
      }),
    ).toContain("\"airbox_hmax\": 8e-9");
  });

  it("creates structured Airbox drafts from universe mesh policy resources", () => {
    const resource = {
      config: {
        airbox_grading: "linear",
        airbox_growth_rate: 1.4,
        airbox_hmax: 8e-9,
        airbox_hmin: 2e-9,
      },
      revision: 12,
    };

    expect(AIRBOX_GRADING_MODES).toEqual(["auto", "geometric", "linear"]);
    expect(draftFromUniverseMeshPolicyResource(resource)).toMatchObject({
      airboxGrading: "linear",
      airboxGrowthRate: "1.4",
      airboxHmax: "8e-9",
      airboxHmin: "2e-9",
    });
    expect(draftKeyForUniverseMeshPolicyResource(resource)).toContain("12");
  });

  it("hydrates structured Airbox drafts from numeric strings", () => {
    const resource = {
      config: {
        airbox_grading: "geometric",
        airbox_growth_rate: "2.5",
        airbox_hmax: "2e-7",
        airbox_hmin: "2e-8",
      },
      revision: 13,
    };

    expect(draftFromUniverseMeshPolicyResource(resource)).toMatchObject({
      airboxGrading: "geometric",
      airboxGrowthRate: "2.5",
      airboxHmax: "2e-7",
      airboxHmin: "2e-8",
    });
  });

  it("builds a replace request while preserving unrelated universe mesh config keys", () => {
    const result = buildAirboxMeshPolicyReplaceRequest({
      airboxGrading: "geometric",
      airboxGrowthRate: "1.35",
      airboxHmax: "5e-9",
      airboxHmin: "",
      configText: "{ \"maximum_element_growth_rate\": 1.2 }",
      curvatureFactor: "",
      narrowRegionResolution: "",
      paddingX: "",
      paddingY: "",
      paddingZ: "",
      airboxMode: "",
      airboxSizeX: "",
      airboxSizeY: "",
      airboxSizeZ: "",
      airboxCenterX: "",
      airboxCenterY: "",
      airboxCenterZ: "",
    });

    expect(result).toEqual({
      request: {
        config: {
          airbox_grading: "geometric",
          airbox_growth_rate: 1.35,
          airbox_hmax: 5e-9,
          maximum_element_growth_rate: 1.2,
        },
      },
    });
  });

  it("rejects malformed JSON and non-positive numeric Airbox policy fields", () => {
    expect(
      buildAirboxMeshPolicyReplaceRequest({
        ...draftFromUniverseMeshPolicyResource(defaultUniverseMeshPolicyResource()),
        airboxHmax: "-1",
      }),
    ).toEqual({
      error: "Airbox maximum element size must be greater than 0.",
    });

    expect(
      buildAirboxMeshPolicyReplaceRequest({
        ...draftFromUniverseMeshPolicyResource(defaultUniverseMeshPolicyResource()),
        configText: "[1, 2, 3]",
      }),
    ).toEqual({
      error: "Universe mesh policy config must be a JSON object.",
    });
  });
});
