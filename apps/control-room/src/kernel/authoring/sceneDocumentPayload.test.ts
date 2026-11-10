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
});
