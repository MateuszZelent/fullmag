import { describe, expect, it } from "vitest";

import { MAGNETIZATION_TEXTURE_PRESETS } from "@/shared/domain/magnetization-texture/texturePresets";

import {
  buildObjectMagneticTextureAssetDraft,
  magneticTextureProjectionOptions,
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

  it("resets both hopfion presets to object-local projection", () => {
    const baseDraft = {
      ...objectMagneticTextureDraftFromModel(MODEL),
      mappingProjection: "planar_xy",
    };
    for (const presetKind of ["hopfion", "hopfion_compact_support"] as const) {
      expect(objectMagneticTexturePresetChangePatch(MODEL, baseDraft, presetKind)).toMatchObject({
        mappingProjection: "object_local",
      });
    }
  });

  it.each(["hopfion", "hopfion_compact_support"] as const)(
    "restricts %s to object-local projection before save",
    (presetKind) => {
      expect(magneticTextureProjectionOptions(presetKind)).toEqual(["object_local"]);
      const baseDraft = objectMagneticTextureDraftFromModel(MODEL);
      const draft = {
        ...baseDraft,
        ...objectMagneticTexturePresetChangePatch(MODEL, baseDraft, presetKind),
        mappingProjection: "planar_xy",
        presetKind,
      };
      expect(() => buildObjectMagneticTextureAssetDraft(MODEL, draft)).toThrow(
        `${presetKind} requires object-local projection.`,
      );
    },
  );

  it("uses the canonical one-nanometre vortex-wall core default", () => {
    const baseDraft = objectMagneticTextureDraftFromModel(MODEL);
    expect(
      objectMagneticTexturePresetChangePatch(MODEL, baseDraft, "vortex_wall"),
    ).toMatchObject({ core_radius: "1e-9" });
  });

  it("rejects invalid vortex domains and compact-hopfion radii", () => {
    const baseDraft = objectMagneticTextureDraftFromModel(MODEL);
    const vortexDraft = {
      ...baseDraft,
      ...objectMagneticTexturePresetChangePatch(MODEL, baseDraft, "vortex_wall"),
      left_mx: "0",
      presetKind: "vortex_wall" as const,
    };
    expect(() => buildObjectMagneticTextureAssetDraft(MODEL, vortexDraft)).toThrow(
      "Left mx must be nonzero.",
    );

    const hopfionDraft = {
      ...baseDraft,
      ...objectMagneticTexturePresetChangePatch(MODEL, baseDraft, "hopfion_compact_support"),
      major_radius: "1",
      minor_radius: "2",
      presetKind: "hopfion_compact_support" as const,
    };
    expect(() => buildObjectMagneticTextureAssetDraft(MODEL, hopfionDraft)).toThrow(
      "Minor radius must be less than or equal to major radius.",
    );
  });
});
