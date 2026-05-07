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
 * Store ownership is complete: ControlRoomContext reads and writes this store
 * directly; there is no context-to-store sync bridge.
 */

import { create } from "zustand";
import type { SetStateAction } from "react";
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
  setMeshGenerating: (v: SetStateAction<boolean>) => void;
  setLastBuiltMeshConfigSignature: (sig: SetStateAction<string | null>) => void;
  setMeshSelection: (
    sel:
      | MeshSelectionSnapshot
      | ((prev: MeshSelectionSnapshot) => MeshSelectionSnapshot),
  ) => void;

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
> = {
  meshOptionsState: DEFAULT_MESH_OPTIONS,
  meshGenerating: false,
  lastBuiltMeshConfigSignature: null,
  meshSelection: DEFAULT_MESH_SELECTION,
};

/* ══════════════════════════════════════════════════════════════════
 * Store
 * ══════════════════════════════════════════════════════════════════ */

export const useMeshConfigStore = create<MeshConfigStoreState>((set) => ({
  ...INITIAL_STATE,

  setMeshOptions: (opts) =>
    set((prev) => ({
      meshOptionsState:
        typeof opts === "function" ? opts(prev.meshOptionsState) : opts,
    })),

  setMeshGenerating: (v) =>
    set((prev) => ({
      meshGenerating: typeof v === "function" ? v(prev.meshGenerating) : v,
    })),

  setLastBuiltMeshConfigSignature: (sig) =>
    set((prev) => ({
      lastBuiltMeshConfigSignature:
        typeof sig === "function" ? sig(prev.lastBuiltMeshConfigSignature) : sig,
    })),

  setMeshSelection: (sel) =>
    set((prev) => ({
      meshSelection:
        typeof sel === "function" ? sel(prev.meshSelection) : sel,
    })),

}));

/* ══════════════════════════════════════════════════════════════════
 * Selectors — for use in hot paths (subscribe to minimal slices)
 * ══════════════════════════════════════════════════════════════════ */

export const selectMeshOptionsState = (s: MeshConfigStoreState) => s.meshOptionsState;
export const selectMeshGenerating = (s: MeshConfigStoreState) => s.meshGenerating;
export const selectLastBuiltMeshConfigSignature = (s: MeshConfigStoreState) =>
  s.lastBuiltMeshConfigSignature;
export const selectMeshSelection = (s: MeshConfigStoreState) => s.meshSelection;
