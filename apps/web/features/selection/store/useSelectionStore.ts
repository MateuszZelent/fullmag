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
 * Phase 2.2: Store ownership. ControlRoomContext reads and writes through
 * this store directly; there is no context→store sync bridge.
 */

import { create } from "zustand";
import type { SetStateAction } from "react";
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
  setSelectedSidebarNodeId: (id: SetStateAction<string | null>) => void;
  setSelectedObjectId: (id: SetStateAction<string | null>) => void;
  setSelectedEntityId: (id: SetStateAction<string | null>) => void;
  setFocusedEntityId: (id: SetStateAction<string | null>) => void;
  setViewportScope: (scope: SetStateAction<ViewportScope>) => void;
  setFocusObjectRequest: (request: SetStateAction<FocusObjectRequest | null>) => void;
  requestFocusObject: (objectId: string, revision?: number) => void;
  clearFocusObjectRequest: () => void;
  clearSelection: () => void;
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
  | "setFocusObjectRequest"
  | "requestFocusObject"
  | "clearFocusObjectRequest"
  | "clearSelection"
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

export const useSelectionStore = create<SelectionStoreState>((set) => ({
  ...INITIAL_STATE,

  setSelectedSidebarNodeId: (id) =>
    set((state) => ({
      selectedSidebarNodeId:
        typeof id === "function" ? id(state.selectedSidebarNodeId) : id,
    })),
  setSelectedObjectId: (id) =>
    set((state) => ({
      selectedObjectId: typeof id === "function" ? id(state.selectedObjectId) : id,
    })),
  setSelectedEntityId: (id) =>
    set((state) => ({
      selectedEntityId: typeof id === "function" ? id(state.selectedEntityId) : id,
    })),
  setFocusedEntityId: (id) =>
    set((state) => ({
      focusedEntityId: typeof id === "function" ? id(state.focusedEntityId) : id,
    })),
  setViewportScope: (scope) =>
    set((state) => ({
      viewportScope: typeof scope === "function" ? scope(state.viewportScope) : scope,
    })),

  setFocusObjectRequest: (request) =>
    set((state) => ({
      focusObjectRequest:
        typeof request === "function" ? request(state.focusObjectRequest) : request,
    })),

  requestFocusObject: (objectId, revision) => {
    const nextRevision = revision ?? ++_focusRevision;
    _focusRevision = Math.max(_focusRevision, nextRevision);
    set({
      focusObjectRequest: { objectId, revision: nextRevision },
    });
  },

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
