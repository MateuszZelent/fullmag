import { describe, expect, it } from "vitest";
import type { PlanarFieldMetaResource } from "@/kernel/api/apiTypes";
import { buildFieldMapRenderModel } from "./fieldMapRenderModel";
import { planarModelRenderKey, type PlanarRenderEvidence } from "./fieldMapEvidence";
import type { PlanarCompositionFrame } from "./planarCompositionFrame";
import { createPlanarCompositionBufferStore, PLANAR_COMPOSITION_BASE_LAYER, planarCompositionOverlayLayer } from "./planarCompositionBuffers";

function frame(sample: string, colormap = "viridis"): PlanarCompositionFrame {
  const model = buildFieldMapRenderModel({ bounds: [0, 1, 0, 1], canonicalUnit: "1", component: "magnitude",
    frame: { normal: [0, 0, 1], origin: [0, 0, 0], uAxis: [1, 0, 0], vAxis: [0, 1, 0] },
    layers: { contours: false, mesh: false, raster: true, vectors: false },
    range: { mode: "auto" }, resolution: [1, 1], scalar: new Float64Array([1]), sampleIdentity: sample, colormap });
  const meta = {} as PlanarFieldMetaResource;
  return { base: { meta, model }, overlays: [{ id: "magnet", meta, model }], coherence: "verified" };
}
function evidence(model: PlanarCompositionFrame["base"]["model"]): PlanarRenderEvidence {
  return { sampleIdentity: model.sampleIdentity, renderKey: planarModelRenderKey(model), glyphCount: 0,
    overlayCounts: { contours: 0, meshSegments: 0 }, raster: null };
}
function finish(store: ReturnType<typeof createPlanarCompositionBufferStore>) {
  const snapshot = store.getSnapshot(); const id = snapshot.preparingSlot!; const slot = snapshot.slots[id]!;
  store.acknowledge(id, slot.generation, PLANAR_COMPOSITION_BASE_LAYER, evidence(slot.frame.base.model));
  for (const layer of slot.frame.overlays) store.acknowledge(id, slot.generation, planarCompositionOverlayLayer(layer.id), evidence(layer.model));
}

describe("atomic planar render buffers", () => {
  it("starts blank and publishes only after every layer acknowledges the exact presentation", () => {
    const store = createPlanarCompositionBufferStore(); const next = frame("step-1");
    store.prepare("session-1", next); const before = store.getSnapshot(); const slot = before.slots.A!;
    expect(before.visibleSlot).toBeNull();
    store.acknowledge("A", slot.generation, "base", evidence(next.base.model));
    expect(store.getSnapshot()).toBe(before);
    store.acknowledge("A", slot.generation, "overlay:magnet", { ...evidence(next.overlays[0]!.model), renderKey: "obsolete" });
    expect(store.getSnapshot().visibleSlot).toBeNull();
    store.acknowledge("A", slot.generation, "overlay:magnet", evidence(next.overlays[0]!.model));
    expect(store.getSnapshot().visibleSlot).toBe("A");
    expect(store.getSnapshot().slots.A!.baseEvidence?.renderKey).toBe(planarModelRenderKey(next.base.model));
  });

  it("keeps the entire old stack while preparing another, ignoring replaced-generation acknowledgements", () => {
    const store = createPlanarCompositionBufferStore(); store.prepare("session", frame("step-1")); finish(store);
    const oldVisible = store.getSnapshot().slots.A;
    store.prepare("session", frame("step-2")); const replaced = store.getSnapshot().slots.B!;
    store.prepare("session", frame("step-3"));
    store.acknowledge("B", replaced.generation, "base", evidence(replaced.frame.base.model));
    store.acknowledge("B", replaced.generation, "overlay:magnet", evidence(replaced.frame.overlays[0]!.model));
    expect(store.getSnapshot().visibleSlot).toBe("A");
    expect(store.getSnapshot().slots.A).toBe(oldVisible);
    finish(store); expect(store.getSnapshot().visibleSlot).toBe("B");
    store.prepare("session", frame("step-4")); expect(store.getSnapshot().preparingSlot).toBe("A");
  });

  it("rejects late palette evidence even when the sample token is unchanged", () => {
    const store = createPlanarCompositionBufferStore(); const old = frame("same-token", "viridis"); const next = frame("same-token", "inferno");
    store.prepare("session", old); finish(store); store.prepare("session", next);
    const slot = store.getSnapshot().slots.B!;
    store.acknowledge("B", slot.generation, "base", evidence(old.base.model));
    store.acknowledge("B", slot.generation, "overlay:magnet", evidence(old.overlays[0]!.model));
    expect(store.getSnapshot().visibleSlot).toBe("A");
    finish(store); expect(store.getSnapshot().visibleSlot).toBe("B");
  });

  it("retains a complete frame for missing payloads but drops it across session/domain scopes", () => {
    const store = createPlanarCompositionBufferStore(); store.prepare("session-1", frame("step-1")); finish(store);
    const before = store.getSnapshot(); store.prepare("session-1", null); expect(store.getSnapshot()).toBe(before);
    store.prepare("session-2", null); expect(store.getSnapshot().visibleSlot).toBeNull();
    expect(store.getSnapshot().slots).toEqual({ A: null, B: null });
  });
});
