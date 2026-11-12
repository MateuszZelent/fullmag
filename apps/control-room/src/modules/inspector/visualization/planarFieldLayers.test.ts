import { describe, expect, it } from "vitest";

import {
  addFieldLayer,
  createFieldLayer,
  effectivePass,
  layerIdForTarget,
  moveFieldLayer,
  multisliceLayer,
  patchFieldLayer,
  PLANAR_FIELD_LAYERS_MAX,
  removeFieldLayer,
  type PlanarLayerState,
} from "./planarFieldLayers";

const film = { id: "object:film", kind: "object" as const, label: "film" };
const airbox = { id: "airbox", kind: "airbox" as const, label: "Airbox" };

const masks: PlanarLayerState = {
  boundaries: false,
  bounds: false,
  contours: false,
  mesh: false,
  points: false,
  probes: true,
  raster: true,
  streamlines: false,
  vectors: false,
};

describe("planar field layers", () => {
  it("creates the All objects layer with the magnetization direction defaults", () => {
    const layer = createFieldLayer("all");
    expect(layer.id).toBe("all");
    expect(layer.view_scope.kind).toBe("monitor_target");
    expect(layer.quantity_id).toBe("m");
    expect(layer.colormap).toBe("hsl_direction");
    expect(layer.visible).toBe(true);
    expect(layer.raster_visible).toBe(true);
    expect(layer.vectors_visible).toBe(false);
  });

  it("derives stable ids and scopes for objects and the Airbox", () => {
    expect(layerIdForTarget("all")).toBe("all");
    expect(layerIdForTarget(film)).toBe("object:film");
    expect(layerIdForTarget(airbox)).toBe("airbox");
    expect(createFieldLayer(film).view_scope).toEqual({ kind: "object", scope_id: "film" });
    expect(createFieldLayer(airbox)).toMatchObject({
      id: "airbox",
      quantity_id: "H_demag",
      view_scope: { kind: "airbox" },
    });
  });

  it("refuses the seventeenth layer and a duplicate id", () => {
    const full = Array.from({ length: PLANAR_FIELD_LAYERS_MAX }, (_, index) =>
      createFieldLayer({ id: `object:body-${index}`, kind: "object" }));
    expect(addFieldLayer(full, createFieldLayer(film))).toEqual({ refused: "max_layers" });
    expect(addFieldLayer([createFieldLayer(film)], createFieldLayer(film))).toEqual({ refused: "duplicate" });
  });

  it("adds a layer on top without replacing other layers", () => {
    const all = createFieldLayer("all");
    const result = addFieldLayer([all], createFieldLayer(film));
    expect(result).toEqual({ layers: [createFieldLayer(film), all] });
  });

  it("moves a layer and keeps every layer", () => {
    const layers = ["all", "object:a", "object:b", "airbox"].map((id) => ({ ...createFieldLayer("all"), id }));
    const moved = moveFieldLayer(layers, "airbox", 0);
    expect(moved.map((layer) => layer.id)).toEqual(["airbox", "all", "object:a", "object:b"]);
    expect([...moved].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [...layers].sort((a, b) => a.id.localeCompare(b.id)),
    );
    expect(moveFieldLayer(layers, "all", 99).map((layer) => layer.id)).toEqual(["object:a", "object:b", "airbox", "all"]);
  });

  it("patches one layer without touching other layers or its identity", () => {
    const a = createFieldLayer(film);
    const b = createFieldLayer(airbox);
    const original = [a, b];
    const next = patchFieldLayer(original, a.id, {
      colormap: "inferno",
      id: "object:other",
      vectors_visible: true,
      view_scope: { kind: "airbox" },
    });
    expect(next).toEqual([{ ...a, colormap: "inferno", vectors_visible: true }, b]);
    expect(original).toEqual([a, b]);
    expect(removeFieldLayer(next, a.id)).toEqual([b]);
  });

  it("resolves view mask AND layer flag", () => {
    const layer = { ...createFieldLayer(film), vectors_visible: true, streamlines_visible: true };
    expect(effectivePass(layer, masks, "raster")).toBe("on");
    expect(effectivePass(layer, masks, "vectors")).toBe("masked");
    expect(effectivePass(layer, { ...masks, vectors: true }, "vectors")).toBe("on");
    expect(effectivePass(layer, masks, "points")).toBe("off");
    const legacyMasks: PlanarLayerState = { ...masks };
    delete legacyMasks.streamlines;
    expect(effectivePass(layer, legacyMasks, "streamlines")).toBe("masked");
    for (const pass of ["raster", "vectors", "points", "mesh", "contours", "streamlines"] as const) {
      expect(effectivePass({ ...layer, visible: false }, { ...masks, vectors: true }, pass)).toBe("off");
    }
  });

  it("uses the first visible layer for multislice", () => {
    const hidden = { ...createFieldLayer(film), visible: false };
    const all = createFieldLayer("all");
    expect(multisliceLayer([hidden, all])).toBe(all);
    expect(multisliceLayer([hidden])).toBeNull();
  });
});
