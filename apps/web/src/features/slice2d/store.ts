import { create } from "zustand";

import type { Slice2DToolbarState } from "./types";

interface Slice2DToolbarStore {
  patch: Partial<Slice2DToolbarState>;
  patchToolbar: (patch: Partial<Slice2DToolbarState>) => void;
}

export const useSlice2DToolbarStore = create<Slice2DToolbarStore>((set) => ({
  patch: {},
  patchToolbar: (patch) =>
    set((state) => ({
      patch: {
        ...state.patch,
        ...patch,
      },
    })),
}));
