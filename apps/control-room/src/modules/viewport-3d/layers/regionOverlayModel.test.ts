import { describe, expect, it } from "vitest";

import {
  buildRegionOverlayModels,
  resolveRegionOverlayColor,
  resolveRegionOverlayStyle,
} from "./regionOverlayModel";

describe("regionOverlayModel", () => {
  it("normalizes authored box, cylinder, and sphere region shapes", () => {
    const models = buildRegionOverlayModels([
      {
        enabled: true,
        name: "Core box",
        owner_object_id: "film",
        priority: 0,
        region_id: "film:box",
        shape: {
          center: [1, 2, 3],
          kind: "box",
          size: [4, 5, 6],
        },
      },
      {
        enabled: true,
        name: "Core cylinder",
        owner_object_id: "film",
        priority: 0,
        region_id: "film:cylinder",
        shape: {
          axis: [0, 0, 1],
          center: [0, 0, 0],
          height: 2,
          kind: "cylinder",
          radius: 0.5,
        },
      },
      {
        enabled: true,
        name: "Core sphere",
        owner_object_id: "film",
        priority: 0,
        region_id: "film:sphere",
        shape: {
          center: [-1, -2, -3],
          kind: "sphere",
          radius: 7,
        },
      },
    ]);

    expect(models).toHaveLength(3);
    expect(models[0]).toMatchObject({
      center: [1, 2, 3],
      kind: "box",
      objectId: "film",
      regionId: "film:box",
      size: [4, 5, 6],
    });
    expect(models[1]).toMatchObject({
      axis: [0, 0, 1],
      center: [0, 0, 0],
      height: 2,
      kind: "cylinder",
      radius: 0.5,
      selected: false,
      style: {
        fillOpacity: 0.14,
        wireframeOpacity: 0.72,
        wireframeScale: 1.004,
      },
    });
    expect(models[2]).toMatchObject({
      center: [-1, -2, -3],
      kind: "sphere",
      radius: 7,
    });
  });

  it("assigns Catppuccin colors by descending priority slot", () => {
    const models = buildRegionOverlayModels(
      [
        {
          enabled: true,
          name: "Later",
          owner_object_id: "film",
          priority: 20,
          region_id: "film:later",
          shape: { center: [0, 0, 0], kind: "sphere", radius: 1 },
        },
        {
          enabled: true,
          name: "Earlier",
          owner_object_id: "film",
          priority: 10,
          region_id: "film:earlier",
          shape: { center: [0, 0, 0], kind: "sphere", radius: 1 },
        },
      ],
      { theme: "mocha" },
    );

    expect(models.map((model) => model.regionId)).toEqual([
      "film:later",
      "film:earlier",
    ]);
    expect(models.map((model) => model.color)).toEqual([
      "var(--fm-region-overlay-0)",
      "var(--fm-region-overlay-1)",
    ]);
    expect(resolveRegionOverlayColor(7, "latte")).toBe(
      "var(--fm-region-overlay-7)",
    );
    expect(resolveRegionOverlayColor(8, "mocha")).toBe(
      "var(--fm-region-overlay-0)",
    );
  });

  it("scopes overlays to the selected owner object when one is selected", () => {
    const regions = [
      {
        enabled: true,
        name: "Film core",
        owner_object_id: "film",
        priority: 0,
        region_id: "film:core",
        shape: { center: [0, 0, 0], kind: "sphere", radius: 1 },
      },
      {
        enabled: true,
        name: "Reference core",
        owner_object_id: "reference",
        priority: 0,
        region_id: "reference:core",
        shape: { center: [0, 0, 0], kind: "sphere", radius: 1 },
      },
    ];

    expect(
      buildRegionOverlayModels(regions, { selectedObjectId: "film" }).map(
        (model) => model.regionId,
      ),
    ).toEqual(["film:core"]);
    expect(buildRegionOverlayModels(regions).map((model) => model.regionId)).toEqual([
      "film:core",
      "reference:core",
    ]);
  });

  it("preserves owner transform for object-frame authored regions", () => {
    const [model] = buildRegionOverlayModels([
      {
        enabled: true,
        name: "Translated core",
        owner_object_id: "film",
        owner_transform: {
          rotation_quat: [0, 0, 0.70710678118, 0.70710678118],
          scale: [2, 3, 4],
          translation: [10, -4, 2],
        },
        priority: 0,
        region_id: "film:core",
        shape: {
          center: [1, 2, 3],
          kind: "box",
          size: [4, 5, 6],
        },
      },
    ]);

    expect(model).toMatchObject({
      center: [1, 2, 3],
      kind: "box",
      objectId: "film",
      regionId: "film:core",
      transform: {
        position: [10, -4, 2],
        quaternion: [0, 0, 0.70710678118, 0.70710678118],
        scale: [2, 3, 4],
      },
    });
  });

  it("does not inherit owner transform for world-frame regions", () => {
    const [model] = buildRegionOverlayModels([
      {
        enabled: true,
        frame: "world",
        name: "World core",
        owner_object_id: "film",
        owner_transform: {
          scale: [2, 3, 4],
          translation: [10, -4, 2],
        },
        priority: 0,
        region_id: "film:world",
        shape: {
          center: [1, 2, 3],
          kind: "box",
          size: [4, 5, 6],
        },
      },
    ]);

    expect(model).toMatchObject({
      center: [1, 2, 3],
      transform: {
        position: [0, 0, 0],
        quaternion: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
    });
  });

  it("uses selected and disabled opacity states", () => {
    expect(resolveRegionOverlayStyle({ enabled: true, selected: false })).toEqual({
      fillOpacity: 0.14,
      wireframeOpacity: 0.72,
      wireframeScale: 1.004,
    });
    expect(resolveRegionOverlayStyle({ enabled: true, selected: true })).toEqual({
      fillOpacity: 0.25,
      wireframeOpacity: 1,
      wireframeScale: 1.008,
    });
    expect(resolveRegionOverlayStyle({ enabled: false, selected: true })).toEqual({
      fillOpacity: 0.08,
      wireframeOpacity: 0.38,
      wireframeScale: 1.008,
    });
  });

  it("drops invalid or unsupported authored shapes", () => {
    const models = buildRegionOverlayModels([
      {
        enabled: true,
        name: "Bad box",
        owner_object_id: "film",
        priority: 0,
        region_id: "film:bad-box",
        shape: { center: [0, 0, 0], kind: "box", size: [1, 0, 1] },
      },
      {
        enabled: true,
        name: "Bad shape",
        owner_object_id: "film",
        priority: 1,
        region_id: "film:bad-shape",
        shape: { center: [0, 0, 0], kind: "torus", radius: 1 },
      },
    ]);

    expect(models).toEqual([]);
  });
});
