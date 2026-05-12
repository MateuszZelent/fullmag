import { describe, expect, it } from "vitest";

import {
  buildMagnetizationAssignmentPatch,
  normalizeMagnetizationRef,
  objectMagneticTextureDraftFromModel,
  objectMagneticTextureDraftKey,
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
    expect(objectMagneticTextureDraftFromModel(model)).toEqual({
      magnetizationRef: "mag-1",
    });
    expect(objectMagneticTextureDraftKey(model)).toContain("preset_texture");
  });

  it("builds v2 object patches for magnetic texture assignment", () => {
    expect(normalizeMagnetizationRef("  mag-1 ")).toBe("mag-1");
    expect(normalizeMagnetizationRef("unassigned")).toBeNull();
    expect(
      buildMagnetizationAssignmentPatch({ magnetizationRef: "" }, 5),
    ).toEqual({
      base_revision: 5,
      magnetization_ref: null,
    });
  });
});
