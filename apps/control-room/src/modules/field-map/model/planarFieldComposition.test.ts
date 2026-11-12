import { describe, expect, it } from "vitest";
import type { PlanarFieldMetaResource } from "@/kernel/api/apiTypes";
import { buildFieldMapRenderModel } from "./fieldMapRenderModel";
import { alignPlanarFieldFrames, placePlanarOverlay, planarMetaFrame, planarPhysicalPosition } from "./planarFieldComposition";
import { planarScopeQuery } from "./fieldMapDataPlan";
import { createPlanarCompositionFrameStore } from "./planarCompositionFrame";

function meta(quantity: string, observation = "accepted-1"): PlanarFieldMetaResource {
  return {
    quantity_id: quantity, component: "magnitude", canonical_unit: quantity === "m" ? "dimensionless" : "A/m",
    field_revision: quantity === "m" ? "3" : "1", scene_revision: "1", generation_id: "domain-1", field_source: "live",
    frame: { origin_m: [0, -8.75e-9, 27.5e-9], u_axis: [1, 0, 0], v_axis: [0, 0, 1], normal: [0, -1, 0], bounds_uv_m: [-300e-9, 300e-9, -32.5e-9, 32.5e-9] },
    operator: { kind: "plane_sample" }, resolution: [2, 1], etag: `${quantity}:${observation}`,
    observation_frame: { observation_frame_id: observation },
  } as PlanarFieldMetaResource;
}
function frame(quantity: string, observation = "accepted-1") {
  const metadata = meta(quantity, observation);
  const model = buildFieldMapRenderModel({
    bounds: metadata.frame.bounds_uv_m as [number, number, number, number], frame: planarMetaFrame(metadata),
    canonicalUnit: metadata.canonical_unit, component: "magnitude", resolution: [2, 1],
    sampleIdentity: metadata.etag, scalar: new Float64Array([1, 2]), mask: new Uint8Array([0, 1]),
    range: { mode: "auto" }, layers: { contours: false, mesh: false, raster: true, vectors: false },
  });
  if (!model) throw new Error("fixture render model unavailable");
  return { meta: metadata, model };
}

describe("physical planar field composition", () => {
  it("uses the world-axis coordinate also for the negative Y normal", () => {
    expect(planarPhysicalPosition(meta("m"))).toBe(-8.75e-9);
  });
  it("places different local origins in one UV frame without changing resolution or data", () => {
    const base = frame("H_demag"); const overlay = frame("m");
    overlay.meta.frame.origin_m = [10e-9, -8.75e-9, 25e-9];
    const aligned = alignPlanarFieldFrames(base.meta, overlay.meta);
    expect(aligned.ok).toBe(true);
    if (!aligned.ok) throw new Error(aligned.reason);
    expect(aligned.shift[0]).toBeCloseTo(10e-9, 18);
    expect(aligned.shift[1]).toBeCloseTo(-2.5e-9, 18);
    const placed = placePlanarOverlay(overlay.model, base.model, aligned.shift);
    expect(placed.scalar).toBe(overlay.model.scalar);
    expect(placed.mask).toBe(overlay.model.mask);
    expect(placed.resolution).toBe(overlay.model.resolution);
    expect(placed.viewport).toBe(base.model.viewport);
    expect(placed.bounds[0]).toBeCloseTo(overlay.model.bounds[0] + 10e-9, 18);
  });
  it("rejects different physical planes instead of using the same slice percentage", () => {
    const base = meta("H_demag"); const overlay = meta("m");
    overlay.frame.origin_m = [0, -1.25e-9, 25e-9];
    expect(alignPlanarFieldFrames(base, overlay)).toMatchObject({ ok: false });
  });
  it("keeps object identity in the canonical scoped query", () => {
    expect(planarScopeQuery({ kind: "object", scope_id: "upper-cylinder" })).toEqual({
      scope_kind: "object", scope_id: "upper-cylinder", scope_region_id: undefined,
    });
  });
});

describe("accepted observation composition barrier", () => {
  it("retains the last complete frame as pending while an enabled layer loads vectors", () => {
    const store = createPlanarCompositionFrameStore();
    store.configure("view", frame("H_demag"), ["magnet"], false);
    store.accept("view", "magnet", frame("m"));
    const visible = store.getSnapshot().frame;
    store.accept("view", "magnet", null);
    expect(store.getSnapshot()).toMatchObject({ frame: visible, pending: true });
    store.accept("view", "magnet", frame("m"));
    expect(store.getSnapshot().pending).toBe(false);
  });
  it("waits for all requested fields, despite different per-quantity revisions", () => {
    const store = createPlanarCompositionFrameStore();
    store.configure("view", frame("H_demag"), ["cylinder", "film"], false);
    expect(store.getSnapshot().frame).toBeNull();
    store.accept("view", "cylinder", frame("m"));
    expect(store.getSnapshot().frame).toBeNull();
    store.accept("view", "film", frame("m"));
    expect(store.getSnapshot()).toMatchObject({ pending: false, frame: { coherence: "verified" } });
    expect(store.getSnapshot().frame?.overlays).toHaveLength(2);
  });
  it("retains the complete old frame until both quantities reach the next accepted observation", () => {
    const store = createPlanarCompositionFrameStore();
    store.configure("view", frame("H_demag"), ["magnet"], false);
    store.accept("view", "magnet", frame("m"));
    const first = store.getSnapshot().frame;
    store.configure("view", frame("H_demag", "accepted-2"), ["magnet"], false);
    expect(store.getSnapshot().frame).toBe(first);
    expect(store.getSnapshot().pending).toBe(true);
    store.accept("view", "magnet", frame("m", "accepted-2"));
    expect(store.getSnapshot().pending).toBe(false);
    expect(store.getSnapshot().frame).not.toBe(first);
  });
  it("rejects late completions from another view", () => {
    const store = createPlanarCompositionFrameStore();
    store.configure("new-view", frame("H_demag"), ["magnet"], false);
    store.accept("old-view", "magnet", frame("m"));
    expect(store.getSnapshot().frame).toBeNull();
  });
  it("does not claim observation coherence when a stored field has no receipt", () => {
    const store = createPlanarCompositionFrameStore();
    const overlay = frame("m"); overlay.meta.observation_frame = null;
    store.configure("view", frame("H_demag"), ["magnet"], false);
    store.accept("view", "magnet", overlay);
    expect(store.getSnapshot().frame).toBeNull();
    store.configure("view", frame("H_demag"), ["magnet"], true);
    expect(store.getSnapshot()).toMatchObject({ pending: false, frame: { coherence: "unverified" } });
    expect(store.getSnapshot().reason).toContain("alignment is unavailable");
  });
  it("keeps one snapshot identity for identical candidates, preventing render feedback", () => {
    const store = createPlanarCompositionFrameStore();
    const base = frame("H_demag"); const overlay = frame("m");
    store.configure("view", base, ["magnet"], false);
    store.accept("view", "magnet", overlay);
    const first = store.getSnapshot();
    store.configure("view", base, ["magnet"], false);
    store.accept("view", "magnet", overlay);
    expect(store.getSnapshot()).toBe(first);
  });
});

describe("placePlanarOverlay sample points", () => {
  it("moves sample markers with the shifted raster", () => {
    const model = { bounds: [0, 1, 0, 1], boundsCenter: [0.5, 0.5], samplePoints: [{ index: 0, u: 0.25, v: 0.75 }] };
    const base = { frame: {}, viewport: [0, 2, 0, 2], interaction: { panU: 0, panV: 0, zoom: 1 } };
    const placed = placePlanarOverlay(model as never, base as never, [1, -0.5]);
    expect(placed.samplePoints).toEqual([{ index: 0, u: 1.25, v: 0.25 }]);
    expect(placed.bounds).toEqual([1, 2, -0.5, 0.5]);
  });
});
