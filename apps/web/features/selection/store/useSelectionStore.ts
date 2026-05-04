/**
 * useSelectionStore — Zustand store for selection/focus state
 *
 * Extracted from ControlRoomContext (Phase 2, Etap 2.2).
 *
 * Owns all selection-related fields that were previously scattered
 * across ControlRoomContext's useState hooks:
 *   - selectedSidebarNodeId — active tree node
 *   - selectedObjectId — resolved geometry object
 *   - selectedEntityId — mesh entity (part/face)
 *   - focusedEntityId — hovered mesh entity
 *   - viewportScope — "universe" or "object:<id>"
 *   - focusObjectRequest — camera focus request
 *
 * Phase 2.2 (PR 1): Store creation with structural sharing.
 * Phase 2.2 (PR 2): Sync bridge in ControlRoomContext.
 * Phase 2.2 (PR 3): Consumer migration (future).
 */

import { create } from "zustand";
import type {
  ViewportScope,
  FocusObjectRequest,
} from "@/components/runs/control-room/shared";

/* ══════════════════════════════════════════════════════════════════
 * Types
 * ══════════════════════════════════════════════════════════════════ */

export interface SelectionStoreState {
  /* ── Data ── */
  selectedSidebarNodeId: string | null;
  selectedObjectId: string | null;
  selectedEntityId: string | null;
  focusedEntityId: string | null;
  viewportScope: ViewportScope;
  focusObjectRequest: FocusObjectRequest | null;

  /* ── Actions ── */
  setSelectedSidebarNodeId: (id: string | null) => void;
  setSelectedObjectId: (id: string | null) => void;
  setSelectedEntityId: (id: string | null) => void;
  setFocusedEntityId: (id: string | null) => void;
  setViewportScope: (scope: ViewportScope) => void;
  requestFocusObject: (objectId: string) => void;
  clearFocusObjectRequest: () => void;
  clearSelection: () => void;

  /** Batch-set from sync bridge (structural sharing). */
  syncFromContext: (patch: SelectionSyncPatch) => void;
}

/** Fields synced from ControlRoomContext → store. */
export interface SelectionSyncPatch {
  selectedSidebarNodeId: string | null;
  selectedObjectId: string | null;
  selectedEntityId: string | null;
  focusedEntityId: string | null;
  viewportScope: ViewportScope;
  focusObjectRequest: FocusObjectRequest | null;
}

/* ══════════════════════════════════════════════════════════════════
 * Defaults
 * ══════════════════════════════════════════════════════════════════ */

const INITIAL_STATE: Omit<
  SelectionStoreState,
  | "setSelectedSidebarNodeId"
  | "setSelectedObjectId"
  | "setSelectedEntityId"
  | "setFocusedEntityId"
  | "setViewportScope"
  | "requestFocusObject"
  | "clearFocusObjectRequest"
  | "clearSelection"
  | "syncFromContext"
> = {
  selectedSidebarNodeId: null,
  selectedObjectId: null,
  selectedEntityId: null,
  focusedEntityId: null,
  viewportScope: "universe",
  focusObjectRequest: null,
};

/* ══════════════════════════════════════════════════════════════════
 * Store
 * ══════════════════════════════════════════════════════════════════ */

/** Focus request revision counter for `requestFocusObject`. */
let _focusRevision = 0;

const SYNC_KEYS = [
  "selectedSidebarNodeId",
  "selectedObjectId",
  "selectedEntityId",
  "focusedEntityId",
  "viewportScope",
  "focusObjectRequest",
] as const;

export const useSelectionStore = create<SelectionStoreState>((set) => ({
  ...INITIAL_STATE,

  setSelectedSidebarNodeId: (id) => set({ selectedSidebarNodeId: id }),
  setSelectedObjectId: (id) => set({ selectedObjectId: id }),
  setSelectedEntityId: (id) => set({ selectedEntityId: id }),
  setFocusedEntityId: (id) => set({ focusedEntityId: id }),
  setViewportScope: (scope) => set({ viewportScope: scope }),

  requestFocusObject: (objectId) =>
    set({
      focusObjectRequest: { objectId, revision: ++_focusRevision },
    }),

  clearFocusObjectRequest: () => set({ focusObjectRequest: null }),

  clearSelection: () =>
    set({
      selectedSidebarNodeId: null,
      selectedObjectId: null,
      selectedEntityId: null,
      focusedEntityId: null,
      viewportScope: "universe",
      focusObjectRequest: null,
    }),

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

export const selectSelectedSidebarNodeId = (s: SelectionStoreState) => s.selectedSidebarNodeId;
export const selectSelectedObjectId = (s: SelectionStoreState) => s.selectedObjectId;
export const selectSelectedEntityId = (s: SelectionStoreState) => s.selectedEntityId;
export const selectFocusedEntityId = (s: SelectionStoreState) => s.focusedEntityId;
export const selectViewportScope = (s: SelectionStoreState) => s.viewportScope;
export const selectFocusObjectRequest = (s: SelectionStoreState) => s.focusObjectRequest;
