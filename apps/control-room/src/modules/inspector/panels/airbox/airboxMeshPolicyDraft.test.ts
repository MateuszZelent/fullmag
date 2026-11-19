import { describe, expect, it } from "vitest";

import {
  AIRBOX_GRADING_MODES,
  buildAirboxMeshPolicyReplaceRequest,
  updateAirboxMeshPolicyDraft,
  airboxMeshPolicyDraftDirty,
  defaultUniverseMeshPolicyResource,
  draftFromEffectiveUniverseMeshPolicyResource,
  draftFromUniverseMeshPolicyResource,
  draftIdentityKeyForUniverseMeshPolicyResource,
  draftKeyForUniverseMeshPolicyResource,
  formatUniverseMeshPolicyConfig,
  rebaseAirboxMeshPolicyDraft,
  updateAirboxLengthUnit,
} from "./airboxMeshPolicyDraft";

describe("Airbox mesh policy revision rebase", () => {
  const opened = { config: null, effective_config: null, revision: 0 };

  it("adopts a newer mesh revision when only unrelated scene state changed", () => {
    const draft = updateAirboxMeshPolicyDraft(
      draftFromUniverseMeshPolicyResource(opened),
      { airboxMode: "manual" },
    );

    const rebased = rebaseAirboxMeshPolicyDraft(draft, { ...opened, revision: 7 });

    expect(rebased.baseRevision).toBe(7);
    expect(rebased.airboxMode).toBe("manual");
  });

  it("keeps the opened revision when the Universe policy changed concurrently", () => {
    const draft = draftFromUniverseMeshPolicyResource(opened);

    const rebased = rebaseAirboxMeshPolicyDraft(draft, {
      config: { mode: "manual", size: [1e-7, 1e-7, 1e-7] },
      effective_config: null,
      revision: 7,
    });

    expect(rebased.baseRevision).toBe(0);
  });
});

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

    expect(
      draftFromEffectiveUniverseMeshPolicyResource(resource),
    ).toMatchObject({
      airboxGrading: "geometric",
      airboxGrowthRate: "1.3",
      airboxMode: "auto",
      authoredConfigPresent: true,
      paddingX: "0",
      paddingY: "0",
      paddingZ: "0",
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
      request: { config: { optimize: true }, expected_revision: 16 },
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
      request: { config: { optimize: true, smoothing_steps: 4 }, expected_revision: 17 },
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

  it("round-trips air curvature and narrow-region controls under canonical keys", () => {
    for (const config of [
      { airbox_hmax: 4e-8, airbox_curvature_factor: 0.3, airbox_narrow_region_resolution: 0.5 },
      { airbox_hmax: 4e-8, curvature_factor: 0.3, narrow_region_resolution: 0.5 },
    ]) {
      const draft = draftFromUniverseMeshPolicyResource({ config, revision: 3 });
      expect(draft.curvatureFactor).toBe("0.3");
      expect(draft.narrowRegionResolution).toBe("0.5");

      const result = buildAirboxMeshPolicyReplaceRequest(draft);
      expect(result).toEqual({
        request: {
          config: {
            airbox_curvature_factor: 0.3,
            airbox_hmax: 4e-8,
            airbox_narrow_region_resolution: 0.5,
          },
          expected_revision: 3,
        },
      });
    }
  });

  it("keeps an empty automatic domain policy free of zero-filled bounds", () => {
    const draft = {
      ...draftFromUniverseMeshPolicyResource({ config: null, revision: 1 }),
      airboxMode: "auto",
    };

    expect(buildAirboxMeshPolicyReplaceRequest(draft)).toEqual({
      request: { config: { mode: "auto" }, expected_revision: 1 },
    });
  });

  it("requires explicit positive manual size but preserves the canonical omitted-center behavior", () => {
    const empty = draftFromUniverseMeshPolicyResource({ config: null, revision: 2 });
    const manual = {
      ...empty,
      airboxMode: "manual",
      airboxSizeX: "2e-9",
      airboxSizeY: "3e-9",
      airboxSizeZ: "4e-9",
    };

    expect(buildAirboxMeshPolicyReplaceRequest(manual)).toEqual({
      request: {
        config: { mode: "manual", size: [2e-9, 3e-9, 4e-9] },
        expected_revision: 2,
      },
    });
    expect(buildAirboxMeshPolicyReplaceRequest({ ...manual, airboxSizeZ: "" })).toEqual({
      error: "Manual size requires all three explicit components.",
    });
  });

  it("stores unit-edited lengths in SI while retaining the readable display unit", () => {
    const base = draftFromUniverseMeshPolicyResource({
      config: { airbox_hmax: 2e-9 },
      revision: 3,
    });
    const nanometers = updateAirboxLengthUnit(base, "airboxHmax", "nm");

    expect(nanometers.airboxHmax).toBe("2");
    expect(nanometers.quantityUnits?.airboxHmax).toBe("nm");
    expect(airboxMeshPolicyDraftDirty(nanometers, base)).toBe(false);
    expect(buildAirboxMeshPolicyReplaceRequest(nanometers)).toEqual({
      request: { config: { airbox_hmax: 2e-9 }, expected_revision: 3 },
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
        expected_revision: 18,
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
            size: [1e-6, 2e-6, 3e-6],
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
          size: [1e-6, 2e-6, 3e-6],
        },
        expected_revision: 19,
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


describe("mesh policy JSON edits", () => {
  it("submits a JSON edit instead of the stale form value", () => {
    const draft = draftFromUniverseMeshPolicyResource({ config: { airbox_hmax: 1e-8 }, revision: 1 });
    const result = buildAirboxMeshPolicyReplaceRequest({ ...draft, configText: '{"airbox_hmax":2e-8,"extension":{"keep":true}}' });
    expect(result).toMatchObject({ request: { config: { airbox_hmax: 2e-8, extension: { keep: true } } } });
  });

  it("preserves deletion of an authored JSON parameter", () => {
    const draft = draftFromUniverseMeshPolicyResource({ config: { airbox_hmax: 1e-8 }, revision: 1 });
    const result = buildAirboxMeshPolicyReplaceRequest({ ...draft, configText: '{}' });
    expect("request" in result).toBe(true);
    if ("request" in result) expect(result.request?.config).not.toHaveProperty("airbox_hmax");
  });

  it("rejects invalid authored JSON parameter values without erasing them", () => {
    const draft = draftFromUniverseMeshPolicyResource({ config: { airbox_hmax: 1e-8 }, revision: 1 });
    const result = buildAirboxMeshPolicyReplaceRequest({ ...draft, configText: '{"airbox_hmax":"wrong"}' });
    expect(result).toHaveProperty("error");
  });
});


describe("synchronized mesh parameter editing", () => {
  it("keeps JSON and form edits coherent through a complete round trip", () => {
    const initial = draftFromUniverseMeshPolicyResource({ config: { airbox_hmax: 1e-8, extension: { keep: true } }, revision: 1 });
    const json = updateAirboxMeshPolicyDraft(initial, { configText: '{"airbox_hmax":2e-8,"extension":{"keep":true}}' });
    expect(json.airboxHmax).toBe("2e-8");
    const form = updateAirboxMeshPolicyDraft(json, { airboxHmax: "3e-8" });
    expect(JSON.parse(form.configText)).toMatchObject({ airbox_hmax: 3e-8, extension: { keep: true } });
    expect(buildAirboxMeshPolicyReplaceRequest(form)).toMatchObject({ request: { config: { airbox_hmax: 3e-8 } } });
    const removed = updateAirboxMeshPolicyDraft(form, { airboxHmax: "" });
    expect(JSON.parse(removed.configText)).not.toHaveProperty("airbox_hmax");
  });

  it("preserves incomplete JSON and recovers the structured editor when corrected", () => {
    const initial = draftFromUniverseMeshPolicyResource({ config: { airbox_hmax: 1e-8, extension: { keep: true } }, revision: 1 });
    const invalid = updateAirboxMeshPolicyDraft(initial, { configText: '{"airbox_hmax":' });
    expect(invalid.configText).toBe('{"airbox_hmax":');
    expect(buildAirboxMeshPolicyReplaceRequest(invalid)).toHaveProperty("error");
    const fixed = updateAirboxMeshPolicyDraft(invalid, { configText: '{"airbox_hmax":4e-8}' });
    expect(fixed.airboxHmax).toBe("4e-8");
    expect(buildAirboxMeshPolicyReplaceRequest(fixed)).toMatchObject({ request: { config: { airbox_hmax: 4e-8 } } });
  });

  it("keeps JSON SI values in the selected display unit through later structured edits", () => {
    const initial = draftFromUniverseMeshPolicyResource({
      config: { airbox_hmax: 1e-8 },
      revision: 1,
    });
    const nanometers = updateAirboxLengthUnit(initial, "airboxHmax", "nm");

    expect(nanometers.airboxHmax).toBe("10");
    const json = updateAirboxMeshPolicyDraft(nanometers, {
      configText: '{"airbox_hmax":2e-8}',
    });
    expect(json.airboxHmax).toBe("20");
    expect(json.quantityUnits?.airboxHmax).toBe("nm");
    expect(airboxMeshPolicyDraftDirty(json, initial)).toBe(true);
    expect(buildAirboxMeshPolicyReplaceRequest(json)).toMatchObject({
      request: { config: { airbox_hmax: 2e-8 } },
    });

    const structured = updateAirboxMeshPolicyDraft(json, { airboxHmax: "30" });
    expect(structured.airboxHmax).toBe("30");
    expect(structured.quantityUnits?.airboxHmax).toBe("nm");
    const structuredSI = (JSON.parse(structured.configText) as { airbox_hmax: number }).airbox_hmax;
    expect(structuredSI / 3e-8).toBeCloseTo(1, 14);
    const request = buildAirboxMeshPolicyReplaceRequest(structured);
    expect("request" in request).toBe(true);
    if ("request" in request) {
      const submittedSI = request.request?.config?.airbox_hmax as number;
      expect(submittedSI / 3e-8).toBeCloseTo(1, 14);
    }
  });

  it("preserves invalid structured text and prevents submission until corrected", () => {
    const initial = draftFromUniverseMeshPolicyResource({ config: { airbox_hmax: 1e-8, extension: { keep: true } }, revision: 1 });
    const invalid = updateAirboxMeshPolicyDraft(initial, { airboxHmax: "2e-" });
    expect(invalid.airboxHmax).toBe("2e-");
    expect(buildAirboxMeshPolicyReplaceRequest(invalid)).toHaveProperty("error");
    const fixed = updateAirboxMeshPolicyDraft(invalid, { airboxHmax: "2e-8" });
    expect(buildAirboxMeshPolicyReplaceRequest(fixed)).toMatchObject({ request: { config: { airbox_hmax: 2e-8 } } });
  });
});
