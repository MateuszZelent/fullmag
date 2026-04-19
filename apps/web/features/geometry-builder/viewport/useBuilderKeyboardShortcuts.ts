"use client";

/**
 * P4 — Geometry Builder Keyboard Shortcuts
 *
 * Registers global keyboard shortcuts for the geometry builder mode.
 * Only active when the builder is enabled.
 */

import { useEffect, useCallback } from "react";
import { useGeometryBuilderStore } from "../store/useGeometryBuilderStore";

export function useBuilderKeyboardShortcuts() {
  const builderActive = useGeometryBuilderStore((s) => s.builderMode.active);
  const selectedPrimitiveId = useGeometryBuilderStore((s) => s.builderSelection?.primitiveId ?? null);
  const removePrimitive = useGeometryBuilderStore((s) => s.removePrimitive);
  const duplicatePrimitive = useGeometryBuilderStore((s) => s.duplicatePrimitive);
  const undo = useGeometryBuilderStore((s) => s.undo);
  const redo = useGeometryBuilderStore((s) => s.redo);
  const clearBuilderSelection = useGeometryBuilderStore((s) => s.clearBuilderSelection);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!builderActive) return;

      // Ignore when typing in input fields
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
        return;
      }

      // Delete selected primitive
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedPrimitiveId) {
          e.preventDefault();
          removePrimitive(selectedPrimitiveId);
        }
        return;
      }

      // Duplicate (Ctrl+D)
      if ((e.ctrlKey || e.metaKey) && e.key === "d") {
        if (selectedPrimitiveId) {
          e.preventDefault();
          duplicatePrimitive(selectedPrimitiveId);
        }
        return;
      }

      // Undo (Ctrl+Z)
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === "z") {
        e.preventDefault();
        undo();
        return;
      }

      // Redo (Ctrl+Shift+Z)
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "z") {
        e.preventDefault();
        redo();
        return;
      }

      // Escape — deselect
      if (e.key === "Escape") {
        if (selectedPrimitiveId) {
          e.preventDefault();
          clearBuilderSelection();
        }
        return;
      }
    },
    [builderActive, selectedPrimitiveId, removePrimitive, duplicatePrimitive, undo, redo, clearBuilderSelection],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);
}
