/**
 * useMeshConfigStore — Zustand store for mesh configuration state
 *
 * Extracted from ControlRoomContext (Phase 2, Etap 2.3).
 *
 * Owns all mesh-configuration fields that were previously in
 * ControlRoomContext's useState hooks:
 *   - meshOptionsState — mesh generation parameters
 *   - meshGenerating — whether mesh build is in progress
 *   - lastBuiltMeshConfigSignature — fingerprint of the last successful build
 *   - meshSelection — selected mesh faces
 *
 * Phase 2.3 (PR 1): Store creation with structural sharing.
 * Phase 2.3 (PR 2): Sync bridge in ControlRoomContext.
 * Phase 2.3 (PR 3): Consumer migration (future).
 */

import { create } from "zustand";
import type { MeshOptionsState } from "@/lib/mesh/options";
import type { MeshSelectionSnapshot } from "@/components/preview/fem/femMeshTypes";
import { DEFAULT_MESH_OPTIONS } from "@/lib/mesh/options";

/* ══════════════════════════════════════════════════════════════════
 * Types
 * ══════════════════════════════════════════════════════════════════ */

export interface MeshConfigStoreState {
  /* ── Data ── */
  meshOptionsState: MeshOptionsState;
  meshGenerating: boolean;
  lastBuiltMeshConfigSignature: string | null;
  meshSelection: MeshSelectionSnapshot;

  /* ── Actions ── */
  setMeshOptions: (
    opts: MeshOptionsState | ((prev: MeshOptionsState) => MeshOptionsState),
  ) => void;
  setMeshGenerating: (v: boolean) => void;
  setLastBuiltMeshConfigSignature: (sig: string | null) => void;
  setMeshSelection: (
    sel:
      | MeshSelectionSnapshot
      | ((prev: MeshSelectionSnapshot) => MeshSelectionSnapshot),
  ) => void;

  /** Batch-set from sync bridge (structural sharing). */
  syncFromContext: (patch: MeshConfigSyncPatch) => void;
}

/** Fields synced from ControlRoomContext → store. */
export interface MeshConfigSyncPatch {
  meshOptionsState: MeshOptionsState;
  meshGenerating: boolean;
  lastBuiltMeshConfigSignature: string | null;
  meshSelection: MeshSelectionSnapshot;
}

/* ══════════════════════════════════════════════════════════════════
 * Defaults
 * ══════════════════════════════════════════════════════════════════ */

const DEFAULT_MESH_SELECTION: MeshSelectionSnapshot = {
  selectedFaceIndices: [],
  primaryFaceIndex: null,
};

const INITIAL_STATE: Omit<
  MeshConfigStoreState,
  | "setMeshOptions"
  | "setMeshGenerating"
  | "setLastBuiltMeshConfigSignature"
  | "setMeshSelection"
  | "syncFromContext"
> = {
  meshOptionsState: DEFAULT_MESH_OPTIONS,
  meshGenerating: false,
  lastBuiltMeshConfigSignature: null,
  meshSelection: DEFAULT_MESH_SELECTION,
};

/* ══════════════════════════════════════════════════════════════════
 * Store
 * ══════════════════════════════════════════════════════════════════ */

const SYNC_KEYS = [
  "meshOptionsState",
  "meshGenerating",
  "lastBuiltMeshConfigSignature",
  "meshSelection",
] as const;

export const useMeshConfigStore = create<MeshConfigStoreState>((set) => ({
  ...INITIAL_STATE,

  setMeshOptions: (opts) =>
    set((prev) => ({
      meshOptionsState:
        typeof opts === "function" ? opts(prev.meshOptionsState) : opts,
    })),

  setMeshGenerating: (v) => set({ meshGenerating: v }),

  setLastBuiltMeshConfigSignature: (sig) =>
    set({ lastBuiltMeshConfigSignature: sig }),

  setMeshSelection: (sel) =>
    set((prev) => ({
      meshSelection:
        typeof sel === "function" ? sel(prev.meshSelection) : sel,
    })),

  syncFromContext: (patch) =>
    set((prev) => {
      // Structural sharing: only update if at least one field changed
      let changed = false;
      for (const k of SYNC_KEYS) {
        if (!Object.is(prev[k], patch[k])) {
          changed = true;
          break;
        }
      }
      if (!changed) return prev;
      return { ...prev, ...patch };
    }),
}));

/* ══════════════════════════════════════════════════════════════════
 * Selectors — for use in hot paths (subscribe to minimal slices)
 * ══════════════════════════════════════════════════════════════════ */

export const selectMeshOptionsState = (s: MeshConfigStoreState) => s.meshOptionsState;
export const selectMeshGenerating = (s: MeshConfigStoreState) => s.meshGenerating;
export const selectLastBuiltMeshConfigSignature = (s: MeshConfigStoreState) =>
  s.lastBuiltMeshConfigSignature;
export const selectMeshSelection = (s: MeshConfigStoreState) => s.meshSelection;
