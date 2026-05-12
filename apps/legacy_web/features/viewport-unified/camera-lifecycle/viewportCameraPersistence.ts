import type { ViewportCameraState } from "@/features/workspace-graph";

export type PendingViewportCameraPersist = {
  documentId: string;
  cameraState: ViewportCameraState;
};

function tupleClose(
  a: readonly number[] | null | undefined,
  b: readonly number[] | null | undefined,
): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((value, index) => Math.abs(value - (b[index] ?? Number.NaN)) < 1e-9);
}

export function viewportCameraStatesEqual(
  a: ViewportCameraState | null | undefined,
  b: ViewportCameraState | null | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    tupleClose(a.position, b.position) &&
    tupleClose(a.target, b.target) &&
    tupleClose(a.up, b.up) &&
    a.projection === b.projection &&
    a.navigation === b.navigation &&
    a.lastFocusedObjectId === b.lastFocusedObjectId
  );
}

export function resolveViewportCameraPersistCandidate(args: {
  documentId: string;
  currentCamera: ViewportCameraState | null | undefined;
  pending: PendingViewportCameraPersist | null | undefined;
  nextCamera: ViewportCameraState | null | undefined;
}): PendingViewportCameraPersist | null {
  if (!args.nextCamera || viewportCameraStatesEqual(args.currentCamera, args.nextCamera)) {
    return null;
  }
  if (
    args.pending?.documentId === args.documentId &&
    viewportCameraStatesEqual(args.pending.cameraState, args.nextCamera)
  ) {
    return null;
  }
  return {
    documentId: args.documentId,
    cameraState: args.nextCamera,
  };
}

export function resolveViewportCameraPersistFlush(args: {
  interactionActive: boolean;
  pending: PendingViewportCameraPersist | null | undefined;
}): PendingViewportCameraPersist | null {
  if (args.interactionActive || !args.pending) {
    return null;
  }
  return args.pending;
}
