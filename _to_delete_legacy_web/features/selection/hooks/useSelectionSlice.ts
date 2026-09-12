"use client";

import { useMemo } from "react";

import {
  selectFocusedEntityId,
  selectFocusObjectRequest,
  selectSelectedEntityId,
  selectSelectedObjectId,
  selectSelectedSidebarNodeId,
  selectViewportScope,
  useSelectionStore,
} from "../store/useSelectionStore";

export function useSelectedSidebarNodeId() {
  return useSelectionStore(selectSelectedSidebarNodeId);
}

export function useSelectedObjectId() {
  return useSelectionStore(selectSelectedObjectId);
}

export function useSelectedEntityId() {
  return useSelectionStore(selectSelectedEntityId);
}

export function useFocusedEntityId() {
  return useSelectionStore(selectFocusedEntityId);
}

export function useViewportScopeSelection() {
  return useSelectionStore(selectViewportScope);
}

export function useFocusObjectRequest() {
  return useSelectionStore(selectFocusObjectRequest);
}

export function useSelectionState() {
  const selectedSidebarNodeId = useSelectedSidebarNodeId();
  const selectedObjectId = useSelectedObjectId();
  const selectedEntityId = useSelectedEntityId();
  const focusedEntityId = useFocusedEntityId();
  const viewportScope = useViewportScopeSelection();
  const focusObjectRequest = useFocusObjectRequest();

  return useMemo(
    () => ({
      selectedSidebarNodeId,
      selectedObjectId,
      selectedEntityId,
      focusedEntityId,
      viewportScope,
      focusObjectRequest,
    }),
    [
      focusedEntityId,
      focusObjectRequest,
      selectedEntityId,
      selectedObjectId,
      selectedSidebarNodeId,
      viewportScope,
    ],
  );
}

export function useSelectionActions() {
  const setSelectedSidebarNodeId = useSelectionStore((s) => s.setSelectedSidebarNodeId);
  const setSelectedObjectId = useSelectionStore((s) => s.setSelectedObjectId);
  const setSelectedEntityId = useSelectionStore((s) => s.setSelectedEntityId);
  const setFocusedEntityId = useSelectionStore((s) => s.setFocusedEntityId);
  const setViewportScope = useSelectionStore((s) => s.setViewportScope);
  const setFocusObjectRequest = useSelectionStore((s) => s.setFocusObjectRequest);
  const requestFocusObject = useSelectionStore((s) => s.requestFocusObject);
  const clearFocusObjectRequest = useSelectionStore((s) => s.clearFocusObjectRequest);
  const clearSelection = useSelectionStore((s) => s.clearSelection);

  return useMemo(
    () => ({
      setSelectedSidebarNodeId,
      setSelectedObjectId,
      setSelectedEntityId,
      setFocusedEntityId,
      setViewportScope,
      setFocusObjectRequest,
      requestFocusObject,
      clearFocusObjectRequest,
      clearSelection,
    }),
    [
      clearFocusObjectRequest,
      clearSelection,
      requestFocusObject,
      setFocusedEntityId,
      setFocusObjectRequest,
      setSelectedEntityId,
      setSelectedObjectId,
      setSelectedSidebarNodeId,
      setViewportScope,
    ],
  );
}
