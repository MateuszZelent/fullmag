import { describe, expect, it } from "vitest";

import {
  AIRBOX_GRADING_MODES,
  buildAirboxMeshPolicyReplaceRequest,
  airboxMeshPolicyDraftDirty,
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

  it("detects airbox policy draft changes without JSON or numeric formatting false positives", () => {
    const base = {
      ...draftFromUniverseMeshPolicyResource(defaultUniverseMeshPolicyResource()),
      airboxHmax: "1e-8",
      configText: "{\n  \"airbox_hmax\": 1e-8\n}",
    };

    expect(
      airboxMeshPolicyDraftDirty(base, {
        ...base,
        airboxHmax: "0.00000001",
        configText: "{\"airbox_hmax\":10e-9}",
      }),
    ).toBe(false);

    expect(
      airboxMeshPolicyDraftDirty(base, {
        ...base,
        airboxGrowthRate: "1.7",
      }),
    ).toBe(true);
  });

  it("shows effective defaults without copying them into raw universe policy JSON", () => {
    const resource = {
      config: null,
      effective_config: {
        airbox_grading: "geometric",
        airbox_growth_rate: 1.3,
        mode: "auto",
        padding: [0, 0, 0],
      },
      revision: 14,
    };

    expect(
      draftFromUniverseMeshPolicyResource(resource, {
        effectiveTarget: {
          maximum_element_size: 2e-7,
          minimum_element_size: 5e-8,
        },
      }),
    ).toMatchObject({
      airboxGrading: "geometric",
      airboxGrowthRate: "1.3",
      airboxHmax: "2e-7",
      airboxHmin: "5e-8",
      airboxMode: "auto",
      configText: "{}",
      paddingX: "0",
      paddingY: "0",
      paddingZ: "0",
    });
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
