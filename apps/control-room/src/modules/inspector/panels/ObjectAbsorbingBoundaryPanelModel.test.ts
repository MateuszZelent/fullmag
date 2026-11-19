import { describe, expect, it } from "vitest";
import type { AbsorbingBoundaryGeometry, SpatialAbsorbingLayer } from "@/kernel/api/apiTypes";
import {
  absorbingBoundaryDraftFromObject, absorbingBoundaryDraftKey, buildAbsorbingBoundaryPatch, createLayerDraft,
  type LayerDraft,
} from "./ObjectAbsorbingBoundaryPanelModel";

const legacy = {
  total_width_m: 4e-7, ramp_width_m: 3e-7, max_damping: 0.5,
  faces: ["x+", "y-"], profile: "smootherstep", frame: "universe",
} as const;

function spatialLayer(id: string, geometry: AbsorbingBoundaryGeometry): SpatialAbsorbingLayer {
  return {
    layer_id: id, name: id, enabled: true, geometry, frame: "object", profile: "linear",
    total_width_m: 4e-7, ramp_width_m: 3e-7, max_damping: 0.5,
  };
}

describe("ObjectAbsorbingBoundaryPanelModel", () => {
  it("preserves a legacy face configuration through a round trip", () => {
    const draft = absorbingBoundaryDraftFromObject({ absorbing_boundary: legacy });
    expect(draft.layers).toHaveLength(1);
    expect(draft.layers[0]).toMatchObject({ frame: "universe", totalWidth: "4e-7", faces: ["x+", "y-"] });
    expect(buildAbsorbingBoundaryPatch(draft, 4)).toEqual({ patch: { base_revision: 4, absorbing_boundary: legacy } });
  });

  it("sends the ramp expression only for a custom profile", () => {
    const draft = absorbingBoundaryDraftFromObject({ absorbing_boundary: { ...legacy, profile: "custom", expression: "u**3" } });
    const layer = draft.layers[0];
    expect(buildAbsorbingBoundaryPatch(draft, 4)).toMatchObject({ patch: { absorbing_boundary: { expression: "u**3" } } });
    expect(buildAbsorbingBoundaryPatch({ ...draft, layers: [{ ...layer, expression: " " }] }, 4)).toHaveProperty("error");
    for (const profile of ["tanh", "logarithmic"]) {
      const changed = { ...draft, layers: [{ ...layer, profile }] };
      expect(buildAbsorbingBoundaryPatch(changed, 4)).not.toHaveProperty("patch.absorbing_boundary.expression");
      expect(absorbingBoundaryDraftKey(changed)).toBe(absorbingBoundaryDraftKey({ ...draft, layers: [{ ...layer, profile, expression: "" }] }));
    }
  });

  it("keeps distinct planes, an inclined cylinder, a disabled sphere, contour, and curve independently editable", () => {
    const layers = [
      spatialLayer("Left", { kind: "plane", origin: [-1e-6, 0, 0], normal: [-1, 0, 0] }),
      { ...spatialLayer("Right", { kind: "plane", origin: [3e-6, 0, 0], normal: [1, 0, 0] }), total_width_m: 9e-7, max_damping: 0.9 },
      { ...spatialLayer("Ring", { kind: "cylinder", center: [1e-6, -2e-6, 3e-6], axis: [1, 2, 3], radius_m: 2e-6, direction: "outward" }), region_id: "core" },
      { ...spatialLayer("Shell", { kind: "sphere", center: [0, 0, 0], radius_m: 1e-7, direction: "inward" }), enabled: false },
      { ...spatialLayer("Rim", { kind: "region_boundary", region_id: "rim" }), region_id: "core" },
      { ...spatialLayer("Curve", { kind: "expression", expression: "1e-6 - sqrt((x-y)**2+z**2)" }), profile: "custom" as const, expression: "u**3" },
      spatialLayer("Faces", { kind: "faces", faces: ["z-", "x+"] }),
    ];
    const draft = absorbingBoundaryDraftFromObject({ absorbing_boundary: { layers } });
    expect(buildAbsorbingBoundaryPatch(draft, 19, ["core", "rim"])).toEqual({
      patch: { base_revision: 19, absorbing_boundary: { layers } },
    });
    expect(buildAbsorbingBoundaryPatch(draft, 19, ["rim"])).toMatchObject({ field: "region", layerId: "Ring" });
    expect(buildAbsorbingBoundaryPatch(draft, 19, ["core"])).toMatchObject({ field: "boundaryRegion", layerId: "Rim" });
  });

  it("locates invalid widths, amplitudes and coordinates on the affected layer", () => {
    const layer = createLayerDraft("first", "First");
    const checked = (patch: Partial<LayerDraft>) => buildAbsorbingBoundaryPatch({
      enabled: true, legacy: false, layers: [layer, { ...layer, id: "second", ...patch }],
    }, 4);
    for (const maxDamping of ["", "   ", "-1"]) expect(checked({ maxDamping })).toMatchObject({ field: "maxDamping", layerId: "second" });
    expect(checked({ maxDamping: "0" })).toHaveProperty("patch");
    expect(checked({ rampWidth: "1" })).toMatchObject({ field: "rampWidth" });
    expect(checked({ kind: "cylinder", radius: "1e-8" })).toMatchObject({ field: "radius" });
    expect(checked({ kind: "cylinder", orientation: ["0", "0", "0"] })).toMatchObject({ field: "orientation" });
    expect(checked({ kind: "plane", point: ["0", "", "0"] })).toMatchObject({ field: "point" });
    expect(checked({ kind: "region_boundary" })).toMatchObject({ field: "boundaryRegion" });
    expect(checked({ kind: "expression", distanceExpression: "  " })).toMatchObject({ field: "distanceExpression" });
  });
});
