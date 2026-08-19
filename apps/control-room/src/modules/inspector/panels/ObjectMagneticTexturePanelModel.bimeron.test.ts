import { describe, expect, it } from "vitest";

import {
  buildObjectMagneticTextureAssetDraft,
  objectMagneticTextureDraftFromModel,
  objectMagneticTexturePresetChangePatch,
  type ObjectMagneticTexturePanelModel,
} from "./ObjectMagneticTexturePanelModel";

describe("ObjectMagneticTexturePanelModel bimeron serialization", () => {
  it("serializes all metric and handedness parameters into preset_params", () => {
    const model: ObjectMagneticTexturePanelModel = {
      assignment: "object",
      asset: null,
      assetId: "unassigned",
      assetKind: "unassigned",
      assetLabel: "unassigned",
      baseRevision: 5,
      mapping: "not configured",
      mode: "committed",
      objectId: "body",
      presetKind: "uniform",
      regionId: null,
      targetKind: "object",
      textureTransform: "not configured",
    };
    const draft = objectMagneticTextureDraftFromModel(model);
    const presetPatch = objectMagneticTexturePresetChangePatch(model, draft, "bimeron");
    const bimeronDraft = {
      ...draft,
      ...presetPatch,
      presetKind: "bimeron" as const,
    };

    expect(buildObjectMagneticTextureAssetDraft(model, bimeronDraft).preset_params).toEqual({
      background_sign: 1,
      helicity_rad: 0,
      plane: "xy",
      radius: 10e-9,
      vorticity: 1,
      wall_width: 2e-9,
    });
    for (const [field, value] of [
      ["radius", "0"],
      ["wall_width", "0"],
      ["vorticity", "0"],
      ["background_sign", "2"],
      ["plane", "invalid"],
    ] as const) {
      expect(() =>
        buildObjectMagneticTextureAssetDraft(model, {
          ...bimeronDraft,
          [field]: value,
        }),
      ).toThrow();
    }
  });
});

