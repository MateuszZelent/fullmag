/**
 * Slice 2D airbox store — tracks 2D/3D airbox synchronisation policy.
 *
 * This is the single source of truth for whether a 2D airbox toggle also
 * invalidates the 3D viewport.  The separation ensures that working in the
 * 2D slice view does not rebuild 3D WebGL geometry unless the user has
 * explicitly enabled synchronisation.
 *
 * The `showAirbox2D` field mirrors the value last dispatched via
 * `VisualizationAction airbox.setVisible2D`.  It intentionally does NOT
 * call the backend `patchDisplay` API — 2D airbox visibility is
 * client-side-only.  The server state can diverge; it is reconciled on
 * the next full viewport restore / session reload.
 */
import { create } from "zustand";

export interface Slice2DAirboxStore {
  /** Current 2D-only airbox visibility (local; not pushed to backend). */
  showAirbox2D: boolean;
  /**
   * When `true`, toggling 2D airbox visibility also patches the 3D render plan.
   * Disabled by default — 2D and 3D airbox are independent unless the user
   * explicitly opts in to synchronisation.
   */
  sync2D3D: boolean;

  setShowAirbox2D: (visible: boolean) => void;
  setSyncAirbox3D: (sync: boolean) => void;
}

export const useSlice2DAirboxStore = create<Slice2DAirboxStore>((set) => ({
  showAirbox2D: false,
  sync2D3D: false,
  setShowAirbox2D: (visible) => set({ showAirbox2D: visible }),
  setSyncAirbox3D: (sync) => set({ sync2D3D: sync }),
}));
