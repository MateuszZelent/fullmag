import { describe, expect, it } from "vitest";

import {
  buildObjectRegionPatch,
  objectRegionDraftFromModel,
  objectRegionDraftKey,
  resolveObjectRegionPanelModel,
} from "./ObjectRegionsPanelModel";

describe("ObjectRegionsPanelModel", () => {
  it("resolves object-derived regions from scene and region resources", () => {
    const model = resolveObjectRegionPanelModel(
      {
        kind: "object.regions",
        label: "Regions",
        moduleSource: "explorer",
        nodeId: "model:object:free-layer:regions",
        objectId: "free-layer",
        ref: {
          kind: "object.regions",
          nodeId: "model:object:free-layer:regions",
          objectId: "free-layer",
          type: "scene-object",
          visualizationTargetId: "object:free-layer",
        },
      },
      {
        objects: [
          {
            id: "free-layer",
            magnetization_ref: "mag-1",
            material_ref: "mat-1",
            name: "Free layer",
            region_name: "free",
            visible: true,
          },
        ],
        revision: 7,
      },
      {
        geometry_realization_revision: 9,
        regions: [
          {
            bounds_max: [1, 1, 1],
            bounds_min: [0, 0, 0],
            enabled: false,
            interaction_refs: ["exchange"],
            magnetization_ref: "mag-1",
            material_ref: "mat-1",
            mesh_part_ids: [],
            name: "free",
            region_id: "region:free-layer",
            source: "object",
            source_body_ids: ["body:free-layer"],
            source_object_ids: ["free-layer"],
          },
        ],
        scene_revision: 7,
      },
    );

    expect(model).toMatchObject({
      enabled: false,
      magnetizationRef: "mag-1",
      materialRef: "mat-1",
      mode: "committed",
      objectId: "free-layer",
      regionId: "region:free-layer",
      regionName: "free",
      revision: 7,
      source: "object",
    });
    expect(objectRegionDraftFromModel(model)).toEqual({
      enabled: false,
      name: "free",
    });
    expect(objectRegionDraftKey(model)).toContain("region:free-layer");
  });

  it("builds v2 region patch payloads", () => {
    expect(buildObjectRegionPatch({ enabled: true, name: " free " })).toEqual({
      enabled: true,
      name: "free",
    });
  });
});
