import { describe, expect, it } from "vitest";
import type { SceneResource } from "../api/apiTypes";
import { sceneDocumentPayload } from "./sceneDocumentPayload";

describe("thermal scene transport", () => {
  it("keeps all u64 seed digits through history/save JSON projection", () => {
    const thermal = { temperature: 300.1234567890123, seed: "18446744073709551615" };
    const scene = { study: { thermal_noise: thermal } } as SceneResource;
    const payload = sceneDocumentPayload(scene);
    expect(payload.study).toEqual({ thermal_noise: thermal });
    expect(JSON.parse(JSON.stringify(payload)).study.thermal_noise.seed).toBe(thermal.seed);
    expect(payload.study).not.toBe(scene.study);
  });
  it("retains an explicit clear without inventing a missing override", () => {
    expect(sceneDocumentPayload({ study: {} } as SceneResource).study).toEqual({});
    expect(sceneDocumentPayload({ study: { thermal_noise: null } } as SceneResource).study)
      .toEqual({ thermal_noise: null });
  });

  it("preserves opaque Results definitions and deep clones analysis settings", () => {
    const analysis = {
      postprocessing_definitions: [{
        definition_id: "mode-view-1",
        module_id: "analysis.dispersion",
        settings: { projection: { axis: [1, 0, 0], style: { name: "opaque" } } },
      }],
    };
    const scene = { analysis } as SceneResource;
    const payload = sceneDocumentPayload(scene);
    const projected = payload.analysis as typeof analysis;

    expect(projected).toEqual(analysis);
    expect(projected).not.toBe(analysis);
    expect(projected.postprocessing_definitions).not.toBe(analysis.postprocessing_definitions);
    expect(projected.postprocessing_definitions[0].settings).not.toBe(analysis.postprocessing_definitions[0].settings);

    projected.postprocessing_definitions[0].settings.projection.axis[0] = 9;
    expect(analysis.postprocessing_definitions[0].settings.projection.axis).toEqual([1, 0, 0]);
  });

  it("retains an explicit empty analysis clear while omitting a legacy missing field", () => {
    expect(sceneDocumentPayload({ analysis: {} } as SceneResource).analysis).toEqual({});
    expect(sceneDocumentPayload({} as SceneResource).analysis).toBeUndefined();
  });
});
