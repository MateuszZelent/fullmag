import { describe, expect, it } from "vitest";

import {
  buildObjectMagneticTextureAssetDraft,
  buildMagnetizationAssignmentPatch,
  normalizeMagnetizationRef,
  objectMagneticTextureDraftFromModel,
  objectMagneticTextureDraftKey,
  objectMagneticTexturePresetChangePatch,
  resolveObjectMagneticTexturePanelModel,
} from "./ObjectMagneticTexturePanelModel";

describe("ObjectMagneticTexturePanelModel", () => {
  it("resolves object magnetic texture assets from the scene resource", () => {
    const model = resolveObjectMagneticTexturePanelModel(
      {
        kind: "object.magnetic-texture",
        label: "Magnetic Texture",
        moduleSource: "explorer",
        nodeId: "model:object:free-layer:magnetic-texture",
        objectId: "free-layer",
        ref: {
          kind: "object.magnetic-texture",
          nodeId: "model:object:free-layer:magnetic-texture",
          objectId: "free-layer",
          type: "scene-object",
          visualizationTargetId: "object:free-layer",
        },
      },
      {
        magnetization_assets: [
          {
            id: "mag-1",
            kind: "preset_texture",
            mapping: { coordinate_frame: "world" },
            preset_kind: "vortex",
            texture_transform: { scale: [1, 1, 1] },
            ui_label: "Vortex texture",
          },
        ],
        objects: [
          {
            id: "free-layer",
            magnetization_ref: "mag-1",
            name: "Free layer",
          },
        ],
        revision: 8,
      },
    );

    expect(model).toMatchObject({
      assetId: "mag-1",
      assetKind: "preset_texture",
      assetLabel: "Vortex texture",
      baseRevision: 8,
      mode: "committed",
      objectId: "free-layer",
      presetKind: "vortex",
    });
    expect(model.mapping).toContain("coordinate_frame");
    expect(model.textureTransform).toContain("scale");
    expect(objectMagneticTextureDraftFromModel(model)).toMatchObject({
      magnetizationRef: "mag-1",
      presetKind: "vortex",
      scaleX: "1",
      scaleY: "1",
      scaleZ: "1",
    });
    expect(objectMagneticTextureDraftKey(model)).toContain("preset_texture");
  });

  it("resolves region magnetic texture override from region resources", () => {
    const model = resolveObjectMagneticTexturePanelModel(
      {
        kind: "object.region-magnetic-texture",
        label: "Magnetic Texture",
        moduleSource: "explorer",
        nodeId: "model:object:free-layer:regions:primary:magnetic-texture",
        objectId: "free-layer",
        ref: {
          kind: "object.region-magnetic-texture",
          nodeId: "model:object:free-layer:regions:primary:magnetic-texture",
          objectId: "free-layer",
          regionId: "region:free-layer",
          type: "scene-object",
          visualizationTargetId: "object:free-layer",
        },
      },
      {
        magnetization_assets: [
          {
            id: "mag-object",
            kind: "preset_texture",
            preset_kind: "uniform",
            texture_transform: { scale: [1, 1, 1] },
            ui_label: "Object texture",
          },
          {
            id: "mag-region",
            kind: "preset_texture",
            preset_kind: "vortex",
            texture_transform: { translation: [1, 0, 0] },
            ui_label: "Region vortex",
          },
        ],
        objects: [
          {
            id: "free-layer",
            magnetization_ref: "mag-object",
            name: "Free layer",
          },
        ],
        revision: 8,
      },
      {
        geometry_realization_revision: 8,
        regions: [
          {
            bounds_max: [1, 1, 1],
            bounds_min: [0, 0, 0],
            enabled: true,
            interaction_refs: [],
            magnetization_ref: "mag-region",
            material_ref: "mat-1",
            mesh_part_ids: [],
            name: "Free layer region",
            region_id: "region:free-layer",
            source: "object",
            source_body_ids: ["body:free-layer"],
            source_object_ids: ["free-layer"],
          },
        ],
        scene_revision: 8,
      },
    );

    expect(model).toMatchObject({
      assetId: "mag-region",
      assetLabel: "Region vortex",
      assignment: "region-override",
      objectId: "free-layer",
      regionId: "region:free-layer",
      targetKind: "region",
    });
  });

  it("builds v2 object patches for magnetic texture assignment", () => {
    const draft = objectMagneticTextureDraftFromModel({
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
    });

    expect(normalizeMagnetizationRef("  mag-1 ")).toBe("mag-1");
    expect(normalizeMagnetizationRef("unassigned")).toBeNull();
    expect(
      buildMagnetizationAssignmentPatch({ ...draft, magnetizationRef: "" }, 5),
    ).toEqual({
      base_revision: 5,
      magnetization_ref: null,
    });
  });

  it("builds editable preset texture assets with transform and params", () => {
    const model = resolveObjectMagneticTexturePanelModel(
      {
        kind: "object.region-magnetic-texture",
        label: "Magnetic Texture",
        moduleSource: "explorer",
        nodeId: "model:object:free-layer:regions:primary:magnetic-texture",
        objectId: "free-layer",
        ref: {
          kind: "object.region-magnetic-texture",
          nodeId: "model:object:free-layer:regions:primary:magnetic-texture",
          objectId: "free-layer",
          regionId: "region:free-layer",
          type: "scene-object",
          visualizationTargetId: "object:free-layer",
        },
      },
      {
        magnetization_assets: [],
        objects: [{ id: "free-layer", name: "Free layer" }],
        revision: 8,
      },
      {
        geometry_realization_revision: 8,
        regions: [
          {
            bounds_max: [1, 1, 1],
            bounds_min: [0, 0, 0],
            enabled: true,
            interaction_refs: [],
            magnetization_ref: null,
            material_ref: "mat-1",
            mesh_part_ids: [],
            name: "Free layer region",
            region_id: "region:free-layer",
            source: "object",
            source_body_ids: ["body:free-layer"],
            source_object_ids: ["free-layer"],
          },
        ],
        scene_revision: 8,
      },
    );
    const draft = {
      ...objectMagneticTextureDraftFromModel(model),
      assetLabel: "Edited vortex",
      chirality: "-1",
      polarity: "1",
      presetKind: "vortex" as const,
      rotationZDeg: "90",
      translationX: "2",
    };

    expect(buildObjectMagneticTextureAssetDraft(model, draft)).toMatchObject({
      id: "mag:free-layer:region:free-layer:vortex",
      name: "Edited vortex",
      preset_kind: "vortex",
      preset_params: { chirality: -1, polarity: 1 },
      texture_transform: {
        rotation_quat: expect.arrayContaining([expect.any(Number)]),
        translation: [2, 0, 0],
      },
    });
  });

  it("uses canonical asset identity when a committed random preset changes to uniform", () => {
    const model = resolveObjectMagneticTexturePanelModel(
      {
        kind: "object.magnetic-texture",
        label: "Magnetic Texture",
        moduleSource: "explorer",
        nodeId: "model:object:arch_waveguide:magnetic-texture",
        objectId: "arch_waveguide",
        ref: {
          kind: "object.magnetic-texture",
          nodeId: "model:object:arch_waveguide:magnetic-texture",
          objectId: "arch_waveguide",
          type: "scene-object",
          visualizationTargetId: "object:arch_waveguide",
        },
      },
      {
        magnetization_assets: [
          {
            id: "mag:arch_waveguide:random_seeded",
            kind: "preset_texture",
            name: "Random seeded texture",
            preset_kind: "random_seeded",
            preset_params: { seed: 7 },
            ui_label: "Random seeded texture",
          },
        ],
        objects: [
          {
            id: "arch_waveguide",
            magnetization_ref: "mag:arch_waveguide:random_seeded",
            name: "Arch waveguide",
          },
        ],
        revision: 12,
      },
    );
    const draft = {
      ...objectMagneticTextureDraftFromModel(model),
      directionX: "1",
      directionY: "0",
      directionZ: "0",
      presetKind: "uniform" as const,
    };

    expect(buildObjectMagneticTextureAssetDraft(model, draft)).toMatchObject({
      id: "mag:arch_waveguide:uniform",
      name: "Uniform texture",
      preset_kind: "uniform",
      preset_params: { direction: [1, 0, 0] },
      ui_label: "Uniform texture",
    });
  });

  it("preserves an explicit custom magnetization ref when preset changes", () => {
    const model = resolveObjectMagneticTexturePanelModel(
      {
        kind: "object.magnetic-texture",
        label: "Magnetic Texture",
        moduleSource: "explorer",
        nodeId: "model:object:arch_waveguide:magnetic-texture",
        objectId: "arch_waveguide",
        ref: {
          kind: "object.magnetic-texture",
          nodeId: "model:object:arch_waveguide:magnetic-texture",
          objectId: "arch_waveguide",
          type: "scene-object",
          visualizationTargetId: "object:arch_waveguide",
        },
      },
      {
        magnetization_assets: [
          {
            id: "mag:arch_waveguide:random_seeded",
            kind: "preset_texture",
            name: "Random seeded texture",
            preset_kind: "random_seeded",
            preset_params: { seed: 7 },
            ui_label: "Random seeded texture",
          },
        ],
        objects: [
          {
            id: "arch_waveguide",
            magnetization_ref: "mag:arch_waveguide:random_seeded",
            name: "Arch waveguide",
          },
        ],
        revision: 12,
      },
    );
    const draft = {
      ...objectMagneticTextureDraftFromModel(model),
      assetLabel: "Custom uniform",
      magnetizationRef: "mag:custom:arch_waveguide:uniform",
      presetKind: "uniform" as const,
    };

    expect(buildObjectMagneticTextureAssetDraft(model, draft)).toMatchObject({
      id: "mag:custom:arch_waveguide:uniform",
      name: "Custom uniform",
      preset_kind: "uniform",
    });
  });

  it("keeps explicit draft refs out of preset-change patches", () => {
    const model = resolveObjectMagneticTexturePanelModel(
      {
        kind: "object.magnetic-texture",
        label: "Magnetic Texture",
        moduleSource: "explorer",
        nodeId: "model:object:arch_waveguide:magnetic-texture",
        objectId: "arch_waveguide",
        ref: {
          kind: "object.magnetic-texture",
          nodeId: "model:object:arch_waveguide:magnetic-texture",
          objectId: "arch_waveguide",
          type: "scene-object",
          visualizationTargetId: "object:arch_waveguide",
        },
      },
      {
        magnetization_assets: [
          {
            id: "mag:arch_waveguide:random_seeded",
            kind: "preset_texture",
            name: "Random seeded texture",
            preset_kind: "random_seeded",
            preset_params: { seed: 7 },
            ui_label: "Random seeded texture",
          },
        ],
        objects: [
          {
            id: "arch_waveguide",
            magnetization_ref: "mag:arch_waveguide:random_seeded",
            name: "Arch waveguide",
          },
        ],
        revision: 12,
      },
    );
    const draft = {
      ...objectMagneticTextureDraftFromModel(model),
      assetLabel: "Custom uniform",
      magnetizationRef: "mag:custom:arch_waveguide:uniform",
    };

    expect(
      objectMagneticTexturePresetChangePatch(model, draft, "uniform"),
    ).toEqual({
      presetKind: "uniform",
    });
  });
});
