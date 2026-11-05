import type { PlanarRenderEvidence } from "./fieldMapEvidence";
import { planarModelRenderKey } from "./fieldMapEvidence";
import type { PlanarCompositionFrame } from "./planarCompositionFrame";

export type PlanarCompositionSlotId = "A" | "B";
export const PLANAR_COMPOSITION_BASE_LAYER = "base";
export function planarCompositionOverlayLayer(id: string): string { return `overlay:${id}`; }
export interface PlanarCompositionBufferSlot {
  frame: PlanarCompositionFrame;
  generation: number;
  expected: ReadonlyMap<string, string>;
  baseEvidence: PlanarRenderEvidence | null;
}
export interface PlanarCompositionBufferSnapshot {
  scopeKey: string | null;
  slots: Readonly<Record<PlanarCompositionSlotId, PlanarCompositionBufferSlot | null>>;
  visibleSlot: PlanarCompositionSlotId | null;
  preparingSlot: PlanarCompositionSlotId | null;
}

/** At most two resident canvas stacks; a whole prepared stack is committed together. */
export function createPlanarCompositionBufferStore() {
  let snapshot: PlanarCompositionBufferSnapshot = {
    scopeKey: null, slots: { A: null, B: null }, visibleSlot: null, preparingSlot: null,
  };
  let generation = 0;
  let requested: PlanarCompositionFrame | null = null;
  const ready = new Set<string>();
  let preparingBaseEvidence: PlanarRenderEvidence | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: PlanarCompositionBufferSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => snapshot,
    prepare(scopeKey: string, frame: PlanarCompositionFrame | null) {
      if (scopeKey !== snapshot.scopeKey) {
        requested = null; ready.clear();
        snapshot = { scopeKey, slots: { A: null, B: null }, visibleSlot: null, preparingSlot: null };
        if (!frame) { publish(snapshot); return; }
      }
      if (!frame || frame === requested) return;
      requested = frame;
      const slotId = snapshot.visibleSlot === "A" ? "B" : "A";
      const expected = new Map([[PLANAR_COMPOSITION_BASE_LAYER, planarModelRenderKey(frame.base.model)]]);
      for (const overlay of frame.overlays) expected.set(planarCompositionOverlayLayer(overlay.id), planarModelRenderKey(overlay.model));
      ready.clear(); preparingBaseEvidence = null;
      publish({ ...snapshot, preparingSlot: slotId,
        slots: { ...snapshot.slots, [slotId]: { frame, generation: ++generation, expected, baseEvidence: null } },
      });
    },
    acknowledge(slotId: PlanarCompositionSlotId, slotGeneration: number, layerId: string, evidence: PlanarRenderEvidence) {
      const slot = snapshot.slots[slotId];
      if (snapshot.preparingSlot !== slotId || !slot || slot.generation !== slotGeneration ||
          evidence.renderKey !== slot.expected.get(layerId) || !slot.expected.has(layerId)) return;
      ready.add(layerId);
      if (layerId === PLANAR_COMPOSITION_BASE_LAYER) preparingBaseEvidence = evidence;
      // Keep partial acknowledgements private; nothing visible has changed.
      if (ready.size !== slot.expected.size) return;
      const nextSlot = { ...slot, baseEvidence: preparingBaseEvidence };
      publish({ ...snapshot, visibleSlot: slotId, preparingSlot: null,
        slots: { ...snapshot.slots, [slotId]: nextSlot },
      });
    },
  };
}
