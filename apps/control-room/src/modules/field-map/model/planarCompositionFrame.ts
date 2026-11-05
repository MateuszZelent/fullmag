import type { PlanarFieldMetaResource } from "@/kernel/api/apiTypes";
import type { FieldMapRenderModel } from "./fieldMapRenderModel";
import { alignPlanarFieldFrames, placePlanarOverlay } from "./planarFieldComposition";

export interface PlanarLayerFrame { meta: PlanarFieldMetaResource; model: FieldMapRenderModel }
export interface PlanarCompositionFrame {
  base: PlanarLayerFrame;
  overlays: readonly (PlanarLayerFrame & { id: string })[];
  coherence: "verified" | "unverified";
}
export interface PlanarCompositionSnapshot {
  key: string | null;
  frame: PlanarCompositionFrame | null;
  pending: boolean;
  reason: string | null;
}

/** Bounded references to one displayed composite; resource caches own the payloads. */
export function createPlanarCompositionFrameStore() {
  let key: string | null = null;
  let base: PlanarLayerFrame | null = null;
  let ids: readonly string[] = [];
  let allowUnverified = false;
  const candidates = new Map<string, PlanarLayerFrame>();
  const errors = new Map<string, string>();
  const listeners = new Set<() => void>();
  let snapshot: PlanarCompositionSnapshot = { key, frame: null, pending: true, reason: null };
  const publish = (frame: PlanarCompositionFrame | null, pending: boolean, reason: string | null) => {
    if (snapshot.key === key && snapshot.frame === frame && snapshot.pending === pending && snapshot.reason === reason) return;
    snapshot = { key, frame, pending, reason };
    for (const listener of listeners) listener();
  };
  const resolve = () => {
    if (!base) return;
    const layers: (PlanarLayerFrame & { id: string })[] = [];
    let coherence: PlanarCompositionFrame["coherence"] = "verified";
    for (const id of ids) {
      const candidate = candidates.get(id);
      if (errors.has(id) || !candidate) {
        publish(snapshot.frame, true, errors.get(id) ?? "Loading the requested field layers.");
        return;
      }
      const alignment = alignPlanarFieldFrames(base.meta, candidate.meta);
      if (!alignment.ok) { publish(snapshot.frame, true, alignment.reason); return; }
      const primaryObservation = base.meta.observation_frame;
      const overlayObservation = candidate.meta.observation_frame;
      if (primaryObservation && overlayObservation) {
        if (primaryObservation.observation_frame_id !== overlayObservation.observation_frame_id) {
          publish(snapshot.frame, true, "Waiting for fields from the same accepted observation.");
          return;
        }
      } else if (allowUnverified) {
        coherence = "unverified";
      } else {
        publish(snapshot.frame, true, "The live fields have no common accepted observation identity.");
        return;
      }
      layers.push({ ...candidate, id, model: placePlanarOverlay(candidate.model, base.model, alignment.shift) });
    }
    // Compare object references, not field arrays: unchanged resource inputs
    // must not create a subscription/render feedback loop.
    const previous = snapshot.frame;
    if (previous?.base === base && previous.coherence === coherence &&
        previous.overlays.length === layers.length && layers.every((layer, index) =>
          previous.overlays[index]?.id === layer.id &&
          previous.overlays[index]?.meta === layer.meta &&
          previous.overlays[index]?.model.sampleIdentity === layer.model.sampleIdentity &&
          candidates.get(layer.id)?.model === previousModels.get(layer.id))) {
      publish(previous, false, coherence === "unverified" ? "Stored fields: observation alignment is unavailable." : null);
      return;
    }
    previousModels.clear();
    for (const id of ids) { const candidate = candidates.get(id); if (candidate) previousModels.set(id, candidate.model); }
    publish({ base, overlays: layers, coherence }, false,
      coherence === "unverified" ? "Stored fields: observation alignment is unavailable." : null);
  };
  const previousModels = new Map<string, FieldMapRenderModel>();
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => snapshot,
    configure(nextKey: string, nextBase: PlanarLayerFrame, nextIds: readonly string[], terminal: boolean) {
      if (key !== nextKey) {
        key = nextKey; candidates.clear(); errors.clear(); previousModels.clear();
        snapshot = { key, frame: null, pending: true, reason: null };
      }
      base = nextBase; ids = nextIds; allowUnverified = terminal;
      for (const id of candidates.keys()) if (!ids.includes(id)) candidates.delete(id);
      resolve();
    },
    accept(requestKey: string, id: string, candidate: PlanarLayerFrame | null, error: string | null = null) {
      if (requestKey !== key || !ids.includes(id)) return;
      if (candidate) candidates.set(id, candidate);
      else candidates.delete(id);
      if (error) errors.set(id, error); else errors.delete(id);
      resolve();
    },
    dispose() { candidates.clear(); errors.clear(); previousModels.clear(); listeners.clear(); base = null; },
  };
}
export type PlanarCompositionFrameStore = ReturnType<typeof createPlanarCompositionFrameStore>;
