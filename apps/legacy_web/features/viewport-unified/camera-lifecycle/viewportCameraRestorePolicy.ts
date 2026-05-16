import type { ViewportCameraState } from "@/features/workspace-graph";

import { viewportCameraStatesEqual } from "./viewportCameraPersistence";

export type LastRestoredViewportCamera = {
  key: string;
  state: ViewportCameraState | null;
};

export function shouldSkipViewportCameraRestoreForScope(args: {
  restoreReady: boolean;
  restoredScope: string | null;
  currentScope: string;
  lastRestoredContextKey: number;
  currentContextKey: number;
}): boolean {
  return (
    args.restoreReady &&
    args.restoredScope === args.currentScope &&
    args.lastRestoredContextKey === args.currentContextKey
  );
}

export function shouldSkipViewportCameraRestoreForAppliedState(args: {
  restoreReady: boolean;
  persistedCameraState: ViewportCameraState | null | undefined;
  lastAppliedCameraState: ViewportCameraState | null | undefined;
}): boolean {
  return (
    args.restoreReady &&
    Boolean(args.persistedCameraState) &&
    Boolean(args.lastAppliedCameraState) &&
    viewportCameraStatesEqual(args.persistedCameraState, args.lastAppliedCameraState)
  );
}

export function shouldSkipViewportCameraRestoreForRestoredState(args: {
  restoreReady: boolean;
  cameraKey: string;
  persistedCameraState: ViewportCameraState | null | undefined;
  currentCameraState: ViewportCameraState | null | undefined;
  lastRestoredCamera: LastRestoredViewportCamera | null | undefined;
}): boolean {
  return (
    args.restoreReady &&
    args.lastRestoredCamera?.key === args.cameraKey &&
    viewportCameraStatesEqual(args.lastRestoredCamera.state, args.persistedCameraState) &&
    (!args.persistedCameraState ||
      viewportCameraStatesEqual(args.currentCameraState, args.persistedCameraState))
  );
}

export function isViewportCameraAlreadyAtPersistedState(args: {
  persistedCameraState: ViewportCameraState | null | undefined;
  currentCameraState: ViewportCameraState | null | undefined;
}): boolean {
  return (
    Boolean(args.persistedCameraState) &&
    viewportCameraStatesEqual(args.currentCameraState, args.persistedCameraState)
  );
}
