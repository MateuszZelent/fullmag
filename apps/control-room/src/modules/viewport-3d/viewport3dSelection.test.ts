import { describe, expect, it } from "vitest";

import {
  viewportSelectionForObject,
  viewportSelectionForRegion,
} from "./viewport3dSelection";

describe("viewport3dSelection", () => {
  it("maps viewport object picks to canonical explorer object selections", () => {
    expect(
      viewportSelectionForObject({
        label: "Free layer",
        objectId: "free-layer",
      }),
    ).toEqual({
      kind: "object.root",
      label: "Free layer",
      nodeId: "model:object:free-layer",
      objectId: "free-layer",
      ref: {
        kind: "object.root",
        nodeId: "model:object:free-layer",
        objectId: "free-layer",
        type: "scene-object",
        visualizationTargetId: "object:free-layer",
      },
    });
  });

  it("maps viewport region picks to canonical explorer region selections", () => {
    expect(
      viewportSelectionForRegion({
        objectId: "free-layer",
        regionId: "region:free-layer",
      }),
    ).toEqual({
      kind: "object.region",
      label: "region:free-layer",
      nodeId: "model:object:free-layer:regions:region:free-layer",
      objectId: "free-layer",
      ref: {
        kind: "object.region",
        nodeId: "model:object:free-layer:regions:region:free-layer",
        objectId: "free-layer",
        regionId: "region:free-layer",
        type: "scene-object",
        visualizationTargetId: "region:free-layer:region%3Afree-layer",
      },
    });
  });
});
