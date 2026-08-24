import { describe, expect, it } from "vitest";

import { MAGNETIZATION_TEXTURE_PRESETS } from "@/shared/domain/magnetization-texture/texturePresets";

import {
  buildObjectMagneticTextureAssetDraft,
  objectMagneticTextureDraftFromModel,
  objectMagneticTexturePresetChangePatch,
  type ObjectMagneticTexturePanelModel,
} from "./ObjectMagneticTexturePanelModel";

const MODEL: ObjectMagneticTexturePanelModel = {
  assignment: "object",
  asset: null,
  assetId: "unassigned",
  assetKind: "unassigned",
  assetLabel: "unassigned",
  baseRevision: 1,
  mapping: "not configured",
  mode: "committed",
  objectId: "magnet",
  presetKind: "uniform",
  regionId: null,
  targetKind: "object",
  textureTransform: "not configured",
};

describe("Mumax3 magnetic texture UI coverage", () => {
  it("registers every analytic Mumax3 configuration and Fullmag extension", () => {
    expect(MAGNETIZATION_TEXTURE_PRESETS.map((preset) => preset.id)).toEqual([
      "uniform",
      "random_seeded",
      "vortex",
      "antivortex",
      "bloch_skyrmion",
      "neel_skyrmion",
      "antiskyrmion",
      "skyrmionium",
      "bimeron",
      "domain_wall",
      "two_domain",
      "vortex_wall",
      "helical",
      "conical",
      "hopfion",
      "hopfion_compact_support",
    ]);
  });

  it.each([
    "antiskyrmion",
    "skyrmionium",
    "vortex_wall",
    "hopfion",
    "hopfion_compact_support",
  ] as const)("serializes %s from inspector defaults", (presetKind) => {
    const baseDraft = objectMagneticTextureDraftFromModel(MODEL);
    const draft = {
      ...baseDraft,
      ...objectMagneticTexturePresetChangePatch(MODEL, baseDraft, presetKind),
      presetKind,
    };
    const asset = buildObjectMagneticTextureAssetDraft(MODEL, draft);
    expect(asset.preset_kind).toBe(presetKind);
    expect(asset.preset_version).toBe(2);
    expect(asset.preset_params).toBeTruthy();
  });
});
