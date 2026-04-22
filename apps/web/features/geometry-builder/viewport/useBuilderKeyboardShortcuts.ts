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
  const builderActive = useGeometryBuilderStore((s) => s.builderMode.enabled);
  const selectedPrimitiveId = useGeometryBuilderStore((s) =>
    s.builderSelection.type === "primitive" ? s.builderSelection.id : null,
  );
  const activeTransformPrimitiveId = useGeometryBuilderStore(
    (s) => s.activeTransformTransaction?.primitiveId ?? null,
  );
  const viewportTool = useGeometryBuilderStore((s) => s.viewportTool);
  const removePrimitive = useGeometryBuilderStore((s) => s.removePrimitive);
  const duplicatePrimitive = useGeometryBuilderStore((s) => s.duplicatePrimitive);
  const undo = useGeometryBuilderStore((s) => s.undo);
  const redo = useGeometryBuilderStore((s) => s.redo);
  const clearBuilderSelection = useGeometryBuilderStore((s) => s.clearBuilderSelection);
  const setViewportTool = useGeometryBuilderStore((s) => s.setViewportTool);
  const requestFocusSelected = useGeometryBuilderStore((s) => s.requestFocusSelected);
  const requestFrameAll = useGeometryBuilderStore((s) => s.requestFrameAll);
  const cancelTransformTransaction = useGeometryBuilderStore(
    (s) => s.cancelTransformTransaction,
  );
  const toggleSnap = useGeometryBuilderStore((s) => s.toggleSnap);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!builderActive) return;

      // Ignore when typing in input fields
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
        return;
      }

      // Skip if any modifier key held (except Ctrl for undo/redo/duplicate)
      const noModifier = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;

      // Tool mode shortcuts (Q/W/E/R) — no modifier, single key
      if (noModifier) {
        switch (e.key.toUpperCase()) {
          case "Q":
            e.preventDefault();
            setViewportTool("camera");
            return;
          case "W":
            e.preventDefault();
            setViewportTool("move");
            return;
          case "E":
            e.preventDefault();
            setViewportTool("rotate");
            return;
          case "R":
            e.preventDefault();
            setViewportTool("scale");
            return;
          case "S":
            e.preventDefault();
            setViewportTool("select");
            return;
          case "G":
            e.preventDefault();
            toggleSnap();
            return;
          case "F":
            e.preventDefault();
            requestFocusSelected();
            setViewportTool("camera");
            return;
        }
      }
      if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toUpperCase() === "F") {
        e.preventDefault();
        requestFrameAll();
        setViewportTool("camera");
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
        if (activeTransformPrimitiveId) {
          e.preventDefault();
          cancelTransformTransaction(activeTransformPrimitiveId);
          setViewportTool("select");
          return;
        }
        if (selectedPrimitiveId) {
          e.preventDefault();
          clearBuilderSelection();
          return;
        }
        if (viewportTool !== "camera") {
          e.preventDefault();
          setViewportTool("camera");
        }
        return;
      }
    },
    [
      activeTransformPrimitiveId,
      builderActive,
      cancelTransformTransaction,
      selectedPrimitiveId,
      removePrimitive,
      duplicatePrimitive,
      undo,
      redo,
      clearBuilderSelection,
      setViewportTool,
      requestFocusSelected,
      requestFrameAll,
      toggleSnap,
      viewportTool,
    ],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);
}
