import { describe, expect, it } from "vitest";

import type { ViewportCameraState } from "@/features/workspace-graph";
import {
  buildViewportFitSeed,
  resolveViewportCameraPersistCandidate,
} from "../useViewportDataBridge";

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

describe("buildViewportFitSeed", () => {
  it("stays stable across presentation mode changes and only tracks topology-relevant inputs", () => {
    const base = buildViewportFitSeed({
      resolvedFemTopologyKey: "gen:42",
      scaledFemMeshData: {
        nNodes: 128,
        nElements: 96,
        boundaryFaces: new Array(24).fill(0),
      },
    });

    const sameTopology = buildViewportFitSeed({
      resolvedFemTopologyKey: "gen:42",
      scaledFemMeshData: {
        nNodes: 128,
        nElements: 96,
        boundaryFaces: new Array(24).fill(1),
      },
    });

    const newTopology = buildViewportFitSeed({
      resolvedFemTopologyKey: "gen:43",
      scaledFemMeshData: {
        nNodes: 128,
        nElements: 96,
        boundaryFaces: new Array(24).fill(0),
      },
    });

    expect(base).toBe(sameTopology);
    expect(newTopology).not.toBe(base);
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
