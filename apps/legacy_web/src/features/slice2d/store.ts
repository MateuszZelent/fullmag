import { create } from "zustand";

import type { Slice2DToolbarState } from "./types";

const POSITION_WORLD_EPSILON = 1e-15;

interface Slice2DToolbarStore {
  patch: Partial<Slice2DToolbarState>;
  normalAxisBounds: { min: number; max: number } | null;
  magneticExtent: { min: number; max: number } | null;
  positionWorld: number | null;
  patchToolbar: (patch: Partial<Slice2DToolbarState>) => void;
  setNormalAxisBounds: (bounds: { min: number; max: number } | null) => void;
  setMagneticExtent: (extent: { min: number; max: number } | null) => void;
  setPositionWorld: (position: number | null) => void;
}

export const useSlice2DToolbarStore = create<Slice2DToolbarStore>((set) => ({
  patch: {},
  normalAxisBounds: null,
  magneticExtent: null,
  positionWorld: null,
  patchToolbar: (patch) =>
    set((state) => {
      const {
        normalAxisBounds,
        magneticExtent,
        positionWorld,
        ...toolbarPatch
      } = patch;
      return {
        patch: {
          ...state.patch,
          ...toolbarPatch,
        },
        normalAxisBounds:
          normalAxisBounds === undefined ? state.normalAxisBounds : normalAxisBounds,
        magneticExtent:
          magneticExtent === undefined ? state.magneticExtent : magneticExtent,
        positionWorld:
          positionWorld === undefined ? state.positionWorld : positionWorld,
      };
    }),
  setNormalAxisBounds: (normalAxisBounds) =>
    set((state) => {
      const current = state.normalAxisBounds;
      if (
        current?.min === normalAxisBounds?.min &&
        current?.max === normalAxisBounds?.max
      ) {
        return state;
      }
      return { normalAxisBounds };
    }),
  setMagneticExtent: (magneticExtent) =>
    set((state) => {
      const current = state.magneticExtent;
      if (
        current?.min === magneticExtent?.min &&
        current?.max === magneticExtent?.max
      ) {
        return state;
      }
      return { magneticExtent };
    }),
  setPositionWorld: (positionWorld) =>
    set((state) => {
      if (state.positionWorld == null || positionWorld == null) {
        return state.positionWorld === positionWorld ? state : { positionWorld };
      }
      return Math.abs(state.positionWorld - positionWorld) <= POSITION_WORLD_EPSILON
        ? state
        : { positionWorld };
    }),
}));
