import { describe, expect, it } from "vitest";

import type { VisualizationStateResource } from "@/kernel/api/apiTypes";

import {
  createPlanarTargetFieldProfile,
  patchPlanarTargetFieldProfile,
  planarAirboxEnablePatch,
  planarTargetFieldProfileId,
  upsertPlanarTargetFieldProfile,
} from "./planarTargetFieldProfile";

type Planar = NonNullable<VisualizationStateResource["planar"]>;

const vectorStyle: Planar["vector_style"] = {
  color_mode: "orientation",
  length_mode: "uniform",
  monochrome_color: "#cdd6f4",
  opacity: 1,
  scale: 1,
  thickness: 1,
};

describe("planar target field profiles", () => {
  it("creates a stable object profile with independent raster and vector defaults", () => {
    const profile = createPlanarTargetFieldProfile("body-a", vectorStyle);

    expect(planarTargetFieldProfileId("body-a")).toBe("object:body-a");
    expect(profile).toEqual({
      id: "object:body-a",
      quantity_id: "m",
      component: "magnitude",
      view_scope: { kind: "object", scope_id: "body-a" },
      colormap: "hsl_direction",
      range: { mode: "auto", min: null, max: null },
      raster_opacity: 1,
      raster_visible: true,
      vectors_visible: false,
      vector_style: vectorStyle,
    });
  });

  it("changes only one object's palette, vector visibility, and vector style", () => {
    const objectA = createPlanarTargetFieldProfile("body-a", vectorStyle);
    const objectB = createPlanarTargetFieldProfile("body-b", { ...vectorStyle, scale: 2 });
    const original = [objectA, objectB];
    const next = patchPlanarTargetFieldProfile(original, objectA.id, {
      colormap: "inferno",
      vectors_visible: true,
      vector_style: { ...objectA.vector_style, scale: 1.5 },
    });

    expect(next).toEqual([
      {
        ...objectA,
        colormap: "inferno",
        vectors_visible: true,
        vector_style: { ...objectA.vector_style, scale: 1.5 },
      },
      objectB,
    ]);
    expect(original).toEqual([objectA, objectB]);
  });

  it("adds one object profile without replacing other object profiles", () => {
    const objectA = createPlanarTargetFieldProfile("body-a", vectorStyle);
    const objectB = createPlanarTargetFieldProfile("body-b", vectorStyle);

    expect(upsertPlanarTargetFieldProfile([objectA], objectB)).toEqual([objectA, objectB]);
  });

  it("enables the Airbox through the base planar profile and chooses H_demag when m is unavailable", () => {
    const planar = {
      quantity_id: "m",
      component: "magnitude",
      layers: {
        boundaries: true,
        bounds: false,
        contours: false,
        mesh: true,
        points: false,
        probes: true,
        raster: false,
        vectors: true,
      },
      source: { kind: "monitor", monitor_id: "plane-1" },
      view_scope: { kind: "monitor_target" },
      visible: false,
    } as Planar;
    const patch = planarAirboxEnablePatch(planar, [{
      id: "H_demag",
      label: "Demagnetizing field",
      unit: "A/m",
      vector: true,
      components: [{ value: "magnitude", label: "magnitude" }],
    }]);

    expect(patch).toMatchObject({
      quantity_id: "H_demag",
      component: "magnitude",
      source: { kind: "default" },
      view_scope: { kind: "airbox" },
      visible: true,
      layers: { raster: true, vectors: true },
    });
    expect(patch).not.toHaveProperty("field_overlays");
  });
});
