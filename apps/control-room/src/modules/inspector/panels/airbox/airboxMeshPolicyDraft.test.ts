import { describe, expect, it } from "vitest";

import {
  AIRBOX_GRADING_MODES,
  buildAirboxMeshPolicyReplaceRequest,
  airboxMeshPolicyDraftDirty,
  defaultUniverseMeshPolicyResource,
  draftFromUniverseMeshPolicyResource,
  draftIdentityKeyForUniverseMeshPolicyResource,
  draftKeyForUniverseMeshPolicyResource,
  formatUniverseMeshPolicyConfig,
} from "./airboxMeshPolicyDraft";

describe("Airbox mesh policy draft", () => {
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
    expect(draftIdentityKeyForUniverseMeshPolicyResource()).toBe("universe");
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

  it("never hydrates the authored draft from backend-effective values", () => {
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
      draftFromUniverseMeshPolicyResource(resource),
    ).toMatchObject({
      airboxGrading: "auto",
      airboxGrowthRate: "",
      airboxHmax: "",
      airboxHmin: "",
      airboxMode: "",
      authoredConfigPresent: false,
      configText: "{}",
      paddingX: "",
      paddingY: "",
      paddingZ: "",
    });
  });

  it("does not materialize backend-effective values when null authored config is applied untouched", () => {
    const draft = draftFromUniverseMeshPolicyResource({
      config: null,
      effective_config: {
        airbox_grading: "geometric",
        airbox_growth_rate: 1.3,
        mode: "auto",
        padding: [0, 0, 0],
      },
      revision: 15,
    });

    expect(buildAirboxMeshPolicyReplaceRequest(draft)).toEqual({ request: null });
  });

  it("preserves omitted grading when unrelated JSON is authored from null config", () => {
    const draft = {
      ...draftFromUniverseMeshPolicyResource({
        config: null,
        effective_config: { airbox_grading: "geometric" },
        revision: 16,
      }),
      configText: '{"optimize":true}',
    };

    expect(buildAirboxMeshPolicyReplaceRequest(draft)).toEqual({
      request: { config: { optimize: true } },
    });
  });

  it("preserves omitted grading when unrelated authored JSON changes", () => {
    const draft = {
      ...draftFromUniverseMeshPolicyResource({
        config: { optimize: true },
        effective_config: { airbox_grading: "geometric" },
        revision: 17,
      }),
      configText: '{"optimize":true,"smoothing_steps":4}',
    };

    expect(buildAirboxMeshPolicyReplaceRequest(draft)).toEqual({
      request: { config: { optimize: true, smoothing_steps: 4 } },
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
      authoredConfigPresent: true,
      airboxGradingAuthored: true,
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

  it("builds the shared geometry PUT payload used by FDM Airbox", () => {
    const draft = draftFromUniverseMeshPolicyResource({
      config: {
        center: [0, 0, 0],
        mode: "manual",
        padding: [1e-7, 2e-7, 3e-7],
        size: [8e-7, 3.25e-7, 9e-8],
      },
      revision: 18,
    });

    expect(buildAirboxMeshPolicyReplaceRequest(draft)).toEqual({
      request: {
        config: {
          center: [0, 0, 0],
          mode: "manual",
          padding: [1e-7, 2e-7, 3e-7],
          size: [8e-7, 3.25e-7, 9e-8],
        },
      },
    });
  });

  it("strips FEM-only policy keys and validation from an FDM request", () => {
    const result = buildAirboxMeshPolicyReplaceRequest(
      {
        ...draftFromUniverseMeshPolicyResource({
          config: {
            airbox_grading: "linear",
            airbox_hmax: 1e-9,
            mode: "manual",
            padding: [1e-7, 2e-7, 3e-7],
          },
          revision: 19,
        }),
        airboxGrading: "linear",
        airboxGradingAuthored: true,
        airboxGrowthRate: "not-a-number",
        airboxHmax: "-1",
        curvatureFactor: "not-a-number",
        narrowRegionResolution: "not-a-number",
      },
      { lane: "fdm" },
    );

    expect(result).toEqual({
      request: {
        config: {
          mode: "manual",
          padding: [1e-7, 2e-7, 3e-7],
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
