import { describe, expect, it } from "vitest";

import type { ViewportCameraState } from "@/features/workspace-graph";
import {
  isViewportCameraAlreadyAtPersistedState,
  shouldSkipViewportCameraRestoreForAppliedState,
  shouldSkipViewportCameraRestoreForRestoredState,
  shouldSkipViewportCameraRestoreForScope,
} from "../viewportCameraRestorePolicy";

function cameraState(
  position: [number, number, number],
  target: [number, number, number] = [0, 0, 0],
): ViewportCameraState {
  return {
    position,
    target,
    up: [0, 1, 0],
    projection: "perspective",
    navigation: "cad",
    lastFocusedObjectId: null,
  };
}

describe("shouldSkipViewportCameraRestoreForScope", () => {
  it("skips restore for the already restored scope and canvas context", () => {
    expect(
      shouldSkipViewportCameraRestoreForScope({
        restoreReady: true,
        restoredScope: "viewport:study:core:3d",
        currentScope: "viewport:study:core:3d",
        lastRestoredContextKey: 2,
        currentContextKey: 2,
      }),
    ).toBe(true);
  });

  it("allows restore after canvas context changes", () => {
    expect(
      shouldSkipViewportCameraRestoreForScope({
        restoreReady: true,
        restoredScope: "viewport:study:core:3d",
        currentScope: "viewport:study:core:3d",
        lastRestoredContextKey: 1,
        currentContextKey: 2,
      }),
    ).toBe(false);
  });
});

describe("shouldSkipViewportCameraRestoreForAppliedState", () => {
  it("skips restore when persisted camera values match the already applied state", () => {
    const persisted = cameraState([1, 2, 3]);

    expect(
      shouldSkipViewportCameraRestoreForAppliedState({
        restoreReady: true,
        persistedCameraState: { ...persisted, position: [1, 2, 3 + 1e-10] },
        lastAppliedCameraState: persisted,
      }),
    ).toBe(true);
  });
});

describe("shouldSkipViewportCameraRestoreForRestoredState", () => {
  it("skips restore when the same camera was already restored and the scene is already there", () => {
    const persisted = cameraState([1, 2, 3]);

    expect(
      shouldSkipViewportCameraRestoreForRestoredState({
        restoreReady: true,
        cameraKey: "viewport-doc:viewport:study:core:3d",
        persistedCameraState: persisted,
        currentCameraState: { ...persisted },
        lastRestoredCamera: {
          key: "viewport-doc:viewport:study:core:3d",
          state: persisted,
        },
      }),
    ).toBe(true);
  });
});

describe("isViewportCameraAlreadyAtPersistedState", () => {
  it("marks the current scene camera as already restored when it equals persisted camera", () => {
    const persisted = cameraState([1, 2, 3]);

    expect(
      isViewportCameraAlreadyAtPersistedState({
        persistedCameraState: persisted,
        currentCameraState: { ...persisted },
      }),
    ).toBe(true);
  });
});
