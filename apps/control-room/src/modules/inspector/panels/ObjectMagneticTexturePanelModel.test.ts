import { describe, expect, it } from "vitest";

import {
  buildObjectMagneticTextureAssetDraft,
  buildMagnetizationAssignmentPatch,
  buildMagnetizationTransactionRequest,
  normalizeUniformMagnetizationDirection,
  normalizeMagnetizationRef,
  objectMagneticTextureDraftFromModel,
  objectMagneticTextureDraftDirty,
  objectMagneticTextureDraftIdentityKey,
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
    const draft = objectMagneticTextureDraftFromModel(model);
    expect(draft).toMatchObject({
      magnetizationRef: "mag-1",
      presetKind: "vortex",
      scaleX: "1",
      scaleY: "1",
      scaleZ: "1",
    });
    expect(objectMagneticTextureDraftKey(model)).toContain("preset_texture");
    expect(objectMagneticTextureDraftIdentityKey(model)).toBe(
      "object:free-layer:object",
    );
    expect(
      objectMagneticTextureDraftDirty(
        { ...draft, rotationXDeg: "0.0", scaleX: "1.0" },
        draft,
      ),
    ).toBe(false);
    expect(
      objectMagneticTextureDraftDirty({ ...draft, assetLabel: "Changed" }, draft),
    ).toBe(true);
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
      circulation: "1",
      core_polarity: "-1",
      core_radius: "5e-9",
      plane: "xz",
      presetKind: "vortex" as const,
      rotationZDeg: "90",
      translationX: "2",
    };

    expect(buildObjectMagneticTextureAssetDraft(model, draft)).toMatchObject({
      id: "mag:free-layer:region:free-layer:vortex",
      name: "Edited vortex",
      preset_kind: "vortex",
      preset_params: {
        circulation: 1,
        core_polarity: -1,
        core_radius: 5e-9,
        plane: "xz",
      },
      texture_transform: {
        rotation_quat: expect.arrayContaining([expect.any(Number)]),
        translation: [2, 0, 0],
      },
    });
  });

  it("preserves nanoscale preset parameters when rebuilding texture assets", () => {
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
            id: "mag:arch_waveguide:neel_skyrmion",
            kind: "preset_texture",
            name: "Néel Skyrmion texture",
            preset_kind: "neel_skyrmion",
            preset_params: {
              chirality: 1,
              core_polarity: -1,
              plane: "xy",
              radius: 10e-9,
              wall_width: 2e-9,
            },
            texture_transform: {
              pivot: [0, 0, 0],
              rotation_quat: [0, 0, 0, 1],
              scale: [1, 1, 1],
              translation: [0, 0, 0],
            },
            ui_label: "Néel Skyrmion texture",
          },
        ],
        objects: [
          {
            id: "arch_waveguide",
            magnetization_ref: "mag:arch_waveguide:neel_skyrmion",
            name: "Arch waveguide",
          },
        ],
        revision: 12,
      },
    );

    const draft = objectMagneticTextureDraftFromModel(model);

    expect(draft.radius).toBe("1e-8");
    expect(draft.wall_width).toBe("2e-9");
    expect(buildObjectMagneticTextureAssetDraft(model, draft)).toMatchObject({
      preset_kind: "neel_skyrmion",
      preset_params: {
        radius: 10e-9,
        wall_width: 2e-9,
      },
    });
  });

  it("preserves domain wall width when rebuilding texture assets", () => {
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
            id: "mag:arch_waveguide:domain_wall",
            kind: "preset_texture",
            name: "Domain Wall texture",
            preset_kind: "domain_wall",
            preset_params: {
              center_offset: 0,
              kind: "neel",
              left: [1, 0, 0],
              normal_axis: "x",
              right: [-1, 0, 0],
              width: 10e-9,
            },
            texture_transform: {
              pivot: [0, 0, 0],
              rotation_quat: [0, 0, 0, 1],
              scale: [1, 1, 1],
              translation: [0, 0, 0],
            },
            ui_label: "Domain Wall texture",
          },
        ],
        objects: [
          {
            id: "arch_waveguide",
            magnetization_ref: "mag:arch_waveguide:domain_wall",
            name: "Arch waveguide",
          },
        ],
        revision: 12,
      },
    );

    const draft = objectMagneticTextureDraftFromModel(model);

    expect(draft.wall_width).toBe("1e-8");
    expect(buildObjectMagneticTextureAssetDraft(model, draft)).toMatchObject({
      preset_kind: "domain_wall",
      preset_params: {
        width: 10e-9,
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

  it("uses canonical preset defaults when preset changes", () => {
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
            id: "mag:arch_waveguide:uniform",
            kind: "preset_texture",
            name: "Uniform texture",
            preset_kind: "uniform",
            preset_params: { direction: [1, 0, 0] },
            ui_label: "Uniform texture",
          },
        ],
        objects: [
          {
            id: "arch_waveguide",
            magnetization_ref: "mag:arch_waveguide:uniform",
            name: "Arch waveguide",
          },
        ],
        revision: 12,
      },
    );
    const draft = objectMagneticTextureDraftFromModel(model);

    expect(
      objectMagneticTexturePresetChangePatch(model, draft, "neel_skyrmion"),
    ).toMatchObject({
      assetLabel: "Néel Skyrmion texture",
      core_polarity: "-1",
      magnetizationRef: "",
      presetKind: "neel_skyrmion",
      radius: "1e-8",
      wall_width: "2e-9",
    });
    expect(
      objectMagneticTexturePresetChangePatch(model, draft, "domain_wall"),
    ).toMatchObject({
      assetLabel: "Domain Wall texture",
      center_offset: "0",
      magnetizationRef: "",
      presetKind: "domain_wall",
      wall_width: "1e-8",
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
      directionX: "1",
      directionY: "0",
      directionZ: "0",
      presetKind: "uniform",
    });
  });

  it("normalizes non-zero uniform directions and rejects the zero vector", () => {
    const model = {
      assignment: "object",
      asset: null,
      assetId: "unassigned",
      assetKind: "unassigned",
      assetLabel: "unassigned",
      baseRevision: 12,
      mapping: "not configured",
      mode: "committed" as const,
      objectId: "body",
      presetKind: "uniform",
      regionId: null,
      targetKind: "object" as const,
      textureTransform: "not configured",
    };
    const draft = {
      ...objectMagneticTextureDraftFromModel(model),
      directionX: "3",
      directionY: "4",
      directionZ: "0",
    };

    expect(normalizeUniformMagnetizationDirection([3, 4, 0])).toEqual([
      0.6, 0.8, 0,
    ]);
    expect(() => normalizeUniformMagnetizationDirection([0, 0, 0])).toThrow(
      "Uniform magnetization direction must be nonzero.",
    );
    expect(buildObjectMagneticTextureAssetDraft(model, draft)).toMatchObject({
      preset_params: { direction: [0.6, 0.8, 0] },
    });
  });

  it("builds one revision-checked transaction for object and region assignments", () => {
    const objectModel = {
      assignment: "object",
      asset: null,
      assetId: "unassigned",
      assetKind: "unassigned",
      assetLabel: "unassigned",
      baseRevision: 12,
      mapping: "not configured",
      mode: "committed" as const,
      objectId: "body",
      presetKind: "uniform",
      regionId: null,
      targetKind: "object" as const,
      textureTransform: "not configured",
    };
    const asset = buildObjectMagneticTextureAssetDraft(
      objectModel,
      objectMagneticTextureDraftFromModel(objectModel),
    );
    expect(buildMagnetizationTransactionRequest(objectModel, asset, asset.id)).toEqual({
      base_revision: 12,
      kind: "patch_magnetization",
      object_id: "body",
      asset,
      magnetization_ref: asset.id,
    });

    const regionModel = { ...objectModel, regionId: "region:body", targetKind: "region" as const };
    expect(buildMagnetizationTransactionRequest(regionModel, asset, null)).toMatchObject({
      base_revision: 12,
      kind: "patch_magnetization",
      object_id: "body",
      region_id: "region:body",
      magnetization_ref: null,
    });
  });
});
