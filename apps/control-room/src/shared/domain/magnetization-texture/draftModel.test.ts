import { describe, expect, it } from "vitest";

import type {
  RegionListResource,
  SceneResource,
} from "@/kernel/api/apiTypes";

import {
  buildMagnetizationAssetPatch,
  buildMagnetizationAssignmentPatch,
  buildRegionTextureOverridePatch,
  resolveMagnetizationTextureModel,
} from "./draftModel";
import type { MagnetizationTextureTarget } from "./types";

const scene = {
  magnetization_assets: [
    {
      id: "mag-object",
      kind: "preset_texture",
      mapping: {
        clamp_mode: "none",
        projection: "object_local",
        space: "object",
      },
      name: "Object texture",
      preset_kind: "uniform",
      preset_params: { direction: [1, 0, 0] },
      texture_transform: {
        pivot: [0, 0, 0],
        rotation_quat: [0, 0, 0, 1],
        scale: [1, 1, 1],
        translation: [0, 0, 0],
      },
    },
    {
      id: "mag-region",
      kind: "preset_texture",
      mapping: {
        clamp_mode: "none",
        projection: "object_local",
        space: "object",
      },
      name: "Region texture",
      preset_kind: "vortex",
      preset_params: { chirality: 1, polarity: -1 },
      texture_transform: {
        pivot: [0, 0, 0],
        rotation_quat: [0, 0, 0, 1],
        scale: [1, 1, 1],
        translation: [2, 0, 0],
      },
    },
  ],
  objects: [
    {
      id: "body",
      magnetization_ref: "mag-object",
      name: "Body",
    },
  ],
  revision: 9,
} as unknown as SceneResource;

const regionList = {
  geometry_realization_revision: 9,
  regions: [
    {
      bounds_max: [1, 1, 1],
      bounds_min: [0, 0, 0],
      enabled: true,
      interaction_refs: [],
      magnetization_ref: "mag-region",
      material_ref: "mat-body",
      mesh_part_ids: [],
      name: "Body region",
      region_id: "region:body",
      source: "object",
      source_body_ids: ["body:body"],
      source_object_ids: ["body"],
    },
  ],
  scene_revision: 9,
} as unknown as RegionListResource;

describe("magnetization texture draft model", () => {
  it("resolves object assignment from scene object magnetization ref", () => {
    const model = resolveMagnetizationTextureModel({
      regionList,
      scene,
      target: { kind: "object", objectId: "body" },
    });

    expect(model.assignment).toBe("object");
    expect(model.asset?.id).toBe("mag-object");
    expect(model.effectiveMagnetizationRef).toBe("mag-object");
  });

  it("resolves region override from region resource magnetization ref", () => {
    const target: MagnetizationTextureTarget = {
      kind: "region",
      objectId: "body",
      regionId: "region:body",
    };

    const model = resolveMagnetizationTextureModel({
      regionList,
      scene,
      target,
    });

    expect(model.assignment).toBe("region-override");
    expect(model.asset?.id).toBe("mag-region");
    expect(model.effectiveMagnetizationRef).toBe("mag-region");
  });

  it("falls back to object texture when region has no override", () => {
    const inheritedRegionList = {
      ...regionList,
      regions: [
        {
          ...regionList.regions[0],
          magnetization_ref: null,
        },
      ],
    } as unknown as RegionListResource;

    const model = resolveMagnetizationTextureModel({
      regionList: inheritedRegionList,
      scene,
      target: { kind: "region", objectId: "body", regionId: "region:body" },
    });

    expect(model.assignment).toBe("object-inherited");
    expect(model.asset?.id).toBe("mag-object");
    expect(model.effectiveMagnetizationRef).toBe("mag-object");
  });

  it("builds object, region, and asset patch payloads", () => {
    expect(
      buildMagnetizationAssignmentPatch(
        { kind: "object", objectId: "body" },
        "mag-object",
        9,
      ),
    ).toEqual({
      path: "object",
      payload: { base_revision: 9, magnetization_ref: "mag-object" },
    });

    expect(buildRegionTextureOverridePatch(null)).toEqual({
      texture_override: null,
    });

    expect(
      buildRegionTextureOverridePatch({
        id: "mag-region",
        kind: "preset_texture",
        mapping: {
          clamp_mode: "none",
          projection: "object_local",
          space: "object",
        },
        name: "Region texture",
        preset_kind: "vortex",
        preset_params: { chirality: 1, polarity: -1 },
        texture_transform: {
          pivot: [0, 0, 0],
          rotation_quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
          translation: [2, 0, 0],
        },
      }),
    ).toEqual({
      texture_override: {
        initial_magnetization: {
          kind: "preset_texture",
          mapping: {
            clamp_mode: "none",
            projection: "object_local",
            space: "object",
          },
          preset_kind: "vortex",
          preset_params: { chirality: 1, polarity: -1 },
          texture_transform: {
            pivot: [0, 0, 0],
            rotation_quat: [0, 0, 0, 1],
            scale: [1, 1, 1],
            translation: [2, 0, 0],
          },
        },
      },
    });

    expect(
      buildMagnetizationAssetPatch(
        {
          id: "mag-object",
          kind: "preset_texture",
          mapping: {
            clamp_mode: "none",
            projection: "object_local",
            space: "object",
          },
          name: "Object texture",
          preset_kind: "uniform",
          preset_params: { direction: [0, 1, 0] },
          texture_transform: {
            pivot: [0, 0, 0],
            rotation_quat: [0, 0, 0, 1],
            scale: [1, 1, 1],
            translation: [1, 0, 0],
          },
        },
        9,
      ),
    ).toEqual({
      asset: {
        id: "mag-object",
        kind: "preset_texture",
        mapping: {
          clamp_mode: "none",
          projection: "object_local",
          space: "object",
        },
        name: "Object texture",
        preset_kind: "uniform",
        preset_params: { direction: [0, 1, 0] },
        texture_transform: {
          pivot: [0, 0, 0],
          rotation_quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
          translation: [1, 0, 0],
        },
      },
      base_revision: 9,
    });
  });
});
