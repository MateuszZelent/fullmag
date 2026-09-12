"use client";

import { useCallback, useEffect, useRef } from "react";

import {
  useWorkspaceGraphStore,
  type ViewportCameraState,
  type ViewportDocumentState,
} from "@/features/workspace-graph";

import {
  resolveViewportCameraPersistCandidate,
  resolveViewportCameraPersistFlush,
  viewportCameraStatesEqual,
  type PendingViewportCameraPersist,
} from "./viewportCameraPersistence";

const CAMERA_GRAPH_PERSIST_DEBOUNCE_MS = 600;

type ViewportGraphCameraBridgeLogger = (
  event: string,
  payload?: Record<string, unknown>,
) => void;

/**
 * Structural equality for ViewportDocumentState to prevent Zustand selectors
 * from returning a new reference every time the workspace graph snapshot
 * changes for unrelated reasons. Camera values are compared with epsilon
 * tolerance so floating-point round-trip noise does not trigger restores.
 */
export function viewportDocumentShallowEqual(
  a: ViewportDocumentState | null,
  b: ViewportDocumentState | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.id === b.id &&
    a.workspaceMode === b.workspaceMode &&
    a.tabId === b.tabId &&
    a.viewMode === b.viewMode &&
    a.quantityId === b.quantityId &&
    a.component === b.component &&
    a.plane === b.plane &&
    a.sliceIndex === b.sliceIndex &&
    a.selectedDatasetId === b.selectedDatasetId &&
    a.selectedResultNodeId === b.selectedResultNodeId &&
    a.renderMode === b.renderMode &&
    viewportCameraStatesEqual(a.camera, b.camera) &&
    a.overlayToggles.telemetryHudVisible === b.overlayToggles.telemetryHudVisible &&
    a.overlayToggles.previewNoticesVisible === b.overlayToggles.previewNoticesVisible
  );
}

export function useViewportGraphCameraBridge(logDebug?: ViewportGraphCameraBridgeLogger) {
  const graphActiveViewportDocumentRaw = useWorkspaceGraphStore((state) => {
    const id = state.snapshot.selection.activeViewportDocumentId;
    return id ? state.snapshot.viewportDocuments[id] ?? null : null;
  });
  const graphActiveViewportDocumentRef = useRef(graphActiveViewportDocumentRaw);
  if (!viewportDocumentShallowEqual(graphActiveViewportDocumentRef.current, graphActiveViewportDocumentRaw)) {
    graphActiveViewportDocumentRef.current = graphActiveViewportDocumentRaw;
  }
  const graphActiveViewportDocument = graphActiveViewportDocumentRef.current;
  const upsertViewportDocument = useWorkspaceGraphStore((state) => state.upsertViewportDocument);
  const graphActiveResultNodeId = useWorkspaceGraphStore((state) =>
    state.snapshot.selection.activeResultNodeId,
  );
  const graphViewportResultNodeId =
    graphActiveViewportDocument?.selectedResultNodeId ?? graphActiveResultNodeId;
  const graphActiveViewportDocumentId = graphActiveViewportDocument?.id ?? null;
  const graphActiveViewportCameraState = graphActiveViewportDocument?.camera ?? null;
  const lastLoggedViewportDocumentIdRef = useRef<string | null>(null);
  const pendingViewportCameraPersistRef = useRef<PendingViewportCameraPersist | null>(null);
  const pendingViewportCameraTimerRef = useRef<number | null>(null);
  const cameraInteractionActiveRef = useRef(false);

  const flushPendingViewportCameraState = useCallback(() => {
    pendingViewportCameraTimerRef.current = null;
    const pending = resolveViewportCameraPersistFlush({
      interactionActive: cameraInteractionActiveRef.current,
      pending: pendingViewportCameraPersistRef.current,
    });
    if (!pending) {
      return;
    }
    pendingViewportCameraPersistRef.current = null;
    const document = useWorkspaceGraphStore.getState().snapshot.viewportDocuments[pending.documentId];
    if (!document || viewportCameraStatesEqual(document.camera, pending.cameraState)) {
      return;
    }
    logDebug?.("persist camera to workspace graph", {
      viewportDocumentId: document.id,
      projection: pending.cameraState.projection,
      navigation: pending.cameraState.navigation,
      position: pending.cameraState.position,
      target: pending.cameraState.target,
    });
    upsertViewportDocument({
      ...document,
      camera: pending.cameraState,
    });
  }, [logDebug, upsertViewportDocument]);

  const schedulePendingViewportCameraFlush = useCallback(() => {
    if (pendingViewportCameraTimerRef.current !== null) {
      window.clearTimeout(pendingViewportCameraTimerRef.current);
      pendingViewportCameraTimerRef.current = null;
    }
    if (cameraInteractionActiveRef.current) {
      return;
    }
    pendingViewportCameraTimerRef.current = window.setTimeout(
      flushPendingViewportCameraState,
      CAMERA_GRAPH_PERSIST_DEBOUNCE_MS,
    );
  }, [flushPendingViewportCameraState]);

  useEffect(() => {
    return () => {
      if (pendingViewportCameraTimerRef.current !== null) {
        window.clearTimeout(pendingViewportCameraTimerRef.current);
        pendingViewportCameraTimerRef.current = null;
      }
      if (!cameraInteractionActiveRef.current) {
        flushPendingViewportCameraState();
      }
    };
  }, [flushPendingViewportCameraState]);

  useEffect(() => {
    if (lastLoggedViewportDocumentIdRef.current === graphActiveViewportDocumentId) {
      return;
    }
    logDebug?.("active viewport document changed", {
      previousId: lastLoggedViewportDocumentIdRef.current,
      nextId: graphActiveViewportDocumentId,
      hasCameraState: Boolean(graphActiveViewportCameraState),
    });
    lastLoggedViewportDocumentIdRef.current = graphActiveViewportDocumentId;
  }, [graphActiveViewportCameraState, graphActiveViewportDocumentId, logDebug]);

  const persistViewportCameraState = useCallback(
    (cameraState: ViewportCameraState | null) => {
      const document = graphActiveViewportDocumentRef.current;
      if (!document || !cameraState) {
        return;
      }
      const nextPersist = resolveViewportCameraPersistCandidate({
        documentId: document.id,
        currentCamera: document.camera,
        pending: pendingViewportCameraPersistRef.current,
        nextCamera: cameraState,
      });
      if (!nextPersist) {
        return;
      }
      pendingViewportCameraPersistRef.current = nextPersist;
      schedulePendingViewportCameraFlush();
    },
    [schedulePendingViewportCameraFlush],
  );

  const setViewportCameraInteractionActive = useCallback(
    (active: boolean) => {
      if (cameraInteractionActiveRef.current === active) {
        return;
      }
      cameraInteractionActiveRef.current = active;
      if (active) {
        if (pendingViewportCameraTimerRef.current !== null) {
          window.clearTimeout(pendingViewportCameraTimerRef.current);
          pendingViewportCameraTimerRef.current = null;
        }
        return;
      }
      if (pendingViewportCameraPersistRef.current) {
        schedulePendingViewportCameraFlush();
      }
    },
    [schedulePendingViewportCameraFlush],
  );

  return {
    graphActiveViewportDocument,
    graphViewportResultNodeId,
    graphActiveViewportDocumentId,
    graphActiveViewportCameraState,
    persistViewportCameraState,
    setViewportCameraInteractionActive,
  };
}
