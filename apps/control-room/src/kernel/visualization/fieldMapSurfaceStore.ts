"use client";

import { useSyncExternalStore } from "react";

import type { VisualizationStateResource } from "@/kernel/api/apiTypes";

import type { PlanarSectionGeometry } from "./planarSectionModel";

/** Frame evidence of the mounted 2D surface (meta + scalar + raster identity). */
export type FieldMapSurfaceEvidenceStatus = "error" | "loading" | "ready";

/**
 * Client-only facts published by the mounted 2D surface. The planar profile
 * itself stays server-owned in `visualization/state.planar`; this store only
 * carries what the surface derived from it, so keyboard commands and the
 * Inspector read one owner instead of opening their own subscriptions.
 */
export interface FieldMapState {
  /** Section geometry of the active default slice; null when 2D is not mounted. */
  sectionGeometry: PlanarSectionGeometry | null;
  /** Frame evidence status of the mounted surface (meta + scalar + raster identity). */
  evidenceStatus: FieldMapSurfaceEvidenceStatus | null;
  /**
   * Planar profile as the mounted surface presents it (server state plus
   * queued optimistic patches), so repeated keyboard steps build on each other.
   */
  planar: NonNullable<VisualizationStateResource["planar"]> | null;
}

type Listener = () => void;

const INITIAL_STATE: FieldMapState = {
  evidenceStatus: null,
  planar: null,
  sectionGeometry: null,
};

let state = INITIAL_STATE;
const listeners = new Set<Listener>();

function sameGeometry(
  left: PlanarSectionGeometry | null,
  right: PlanarSectionGeometry | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.plane === right.plane &&
    left.normalMin === right.normalMin &&
    left.normalMax === right.normalMax &&
    left.layerCount === right.layerCount &&
    left.layerSpacing === right.layerSpacing &&
    (left.navigationStepM ?? null) === (right.navigationStepM ?? null) &&
    left.nativeResolution?.[0] === right.nativeResolution?.[0] &&
    left.nativeResolution?.[1] === right.nativeResolution?.[1] &&
    (left.stops?.length ?? 0) === (right.stops?.length ?? 0) &&
    (left.stops ?? []).every((stop, index) => stop === right.stops?.[index]);
}

export const fieldMapSurfaceStore = {
  get: () => state,
  reset: () => fieldMapSurfaceStore.set(INITIAL_STATE),
  set: (patch: Partial<FieldMapState>) => {
    const next = { ...state, ...patch };
    if (
      sameGeometry(next.sectionGeometry, state.sectionGeometry) &&
      next.evidenceStatus === state.evidenceStatus &&
      next.planar === state.planar
    ) {
      return;
    }
    state = next;
    for (const listener of listeners) listener();
  },
  subscribe: (listener: Listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

const serverSnapshot = () => INITIAL_STATE;

export function useFieldMapSurfaceState(): FieldMapState {
  return useSyncExternalStore(
    fieldMapSurfaceStore.subscribe,
    fieldMapSurfaceStore.get,
    serverSnapshot,
  );
}

const serverEvidenceStatus = () => null;

/**
 * Evidence status only. Consumers outside the 2D surface (the Inspector)
 * must not re-render for every presented-profile update during pan/zoom.
 */
export function useFieldMapSurfaceEvidenceStatus(): FieldMapSurfaceEvidenceStatus | null {
  return useSyncExternalStore(
    fieldMapSurfaceStore.subscribe,
    () => fieldMapSurfaceStore.get().evidenceStatus,
    serverEvidenceStatus,
  );
}
