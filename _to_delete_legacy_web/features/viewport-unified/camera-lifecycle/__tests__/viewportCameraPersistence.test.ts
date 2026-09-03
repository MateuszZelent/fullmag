import { describe, expect, it } from "vitest";

import type { ViewportCameraState } from "@/features/workspace-graph";
import {
  resolveViewportCameraPersistCandidate,
  resolveViewportCameraPersistFlush,
  viewportCameraStatesEqual,
} from "../viewportCameraPersistence";

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

describe("viewportCameraStatesEqual", () => {
  it("tolerates tiny floating-point round-trip noise", () => {
    const currentCamera = cameraState([1, 2, 3]);

    expect(
      viewportCameraStatesEqual(currentCamera, {
        ...currentCamera,
        position: [1, 2, 3 + 1e-10],
      }),
    ).toBe(true);
  });
});

describe("resolveViewportCameraPersistCandidate", () => {
  it("skips graph writes for camera states already persisted on the document", () => {
    const currentCamera = cameraState([1, 2, 3]);

    expect(
      resolveViewportCameraPersistCandidate({
        documentId: "viewport:study:core:3d",
        currentCamera,
        pending: null,
        nextCamera: { ...currentCamera, position: [1, 2, 3 + 1e-10] },
      }),
    ).toBeNull();
  });

  it("deduplicates repeated camera changes already queued for the same document", () => {
    const currentCamera = cameraState([1, 2, 3]);
    const nextCamera = cameraState([4, 5, 6]);
    const pending = {
      documentId: "viewport:study:core:3d",
      cameraState: nextCamera,
    };

    expect(
      resolveViewportCameraPersistCandidate({
        documentId: "viewport:study:core:3d",
        currentCamera,
        pending,
        nextCamera: { ...nextCamera },
      }),
    ).toBeNull();
  });

  it("keeps pending camera writes scoped to the viewport document", () => {
    const currentCamera = cameraState([1, 2, 3]);
    const nextCamera = cameraState([4, 5, 6]);

    expect(
      resolveViewportCameraPersistCandidate({
        documentId: "viewport:study:core:3d",
        currentCamera,
        pending: {
          documentId: "viewport:study:core:2d",
          cameraState: nextCamera,
        },
        nextCamera,
      }),
    ).toEqual({
      documentId: "viewport:study:core:3d",
      cameraState: nextCamera,
    });
  });
});

describe("resolveViewportCameraPersistFlush", () => {
  it("defers pending graph writes while camera interaction is active", () => {
    const pending = {
      documentId: "viewport:study:core:3d",
      cameraState: cameraState([4, 5, 6]),
    };

    expect(
      resolveViewportCameraPersistFlush({
        interactionActive: true,
        pending,
      }),
    ).toBeNull();
  });

  it("allows the pending graph write after camera interaction ends", () => {
    const pending = {
      documentId: "viewport:study:core:3d",
      cameraState: cameraState([4, 5, 6]),
    };

    expect(
      resolveViewportCameraPersistFlush({
        interactionActive: false,
        pending,
      }),
    ).toBe(pending);
  });
});
