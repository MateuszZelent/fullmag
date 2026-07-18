import { describe, expect, it } from "vitest";

import {
  buildViewport3DRegionOverlayModels,
  estimateViewport3DRegionOverlayBuildInputBytes,
  transferablesForViewport3DRegionOverlayBuildResult,
} from "./viewport3dRegionOverlayBuildModel";

describe("viewport3dRegionOverlayBuildModel", () => {
  it("builds mesh-backed overlay models from worker-safe structured inputs", () => {
    const result = buildViewport3DRegionOverlayModels({
      magneticParts: [
        {
          element_count: 1,
          element_start: 0,
          id: "part:film:core",
          object_id: "film",
          surface_faces: [[0, 1, 2]],
        },
      ],
      regions: [
        {
          enabled: true,
          mesh_part_ids: ["part:film:core"],
          name: "Core",
          owner_object_id: "film",
          priority: 0,
          region_id: "film:core",
        },
      ],
      selectedRegionId: "film:core",
      theme: "mocha",
      topology: {
        boundaryFaceCount: 0,
        boundaryFaces: new Uint32Array(),
        boundaryMarkers: new Uint32Array(),
        elementCount: 1,
        elementMarkers: Uint32Array.from([1]),
        indices: Uint32Array.from([0, 1, 2, 3]),
        nodeCount: 4,
        positions: Float64Array.from([
          0, 0, 0,
          1, 0, 0,
          0, 1, 0,
          0, 0, 1,
        ]),
      },
    });

    expect(result.models).toHaveLength(1);
    expect(result.models[0]).toMatchObject({
      label: "Core",
      objectId: "film",
      regionId: "film:core",
      selected: true,
      style: {
        wireframeVisible: true,
      },
    });
    expect(Array.from(result.models[0].positions)).toEqual([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
    ]);
    expect(Array.from(result.models[0].surfaceIndices ?? [])).toEqual([0, 1, 2]);
  });

  it("estimates input bytes and exposes derived buffers as transferables", () => {
    const result = buildViewport3DRegionOverlayModels({
      magneticParts: [
        {
          element_count: 1,
          element_start: 0,
          id: "part:film:core",
          object_id: "film",
        },
      ],
      regions: [
        {
          enabled: true,
          mesh_part_ids: ["part:film:core"],
          owner_object_id: "film",
          region_id: "film:core",
        },
      ],
      topology: {
        boundaryFaceCount: 0,
        boundaryFaces: new Uint32Array(),
        boundaryMarkers: new Uint32Array(),
        elementCount: 1,
        elementMarkers: Uint32Array.from([1]),
        indices: Uint32Array.from([0, 1, 2, 3]),
        nodeCount: 4,
        positions: Float64Array.from([
          0, 0, 0,
          1, 0, 0,
          0, 1, 0,
          0, 0, 1,
        ]),
      },
    });

    expect(
      estimateViewport3DRegionOverlayBuildInputBytes({
        magneticParts: [],
        regions: [],
        topology: {
          indices: Uint32Array.from([0, 1, 2, 3]),
          positions: Float64Array.from([0, 0, 0]),
        },
      }),
    ).toBe(40);
    expect(transferablesForViewport3DRegionOverlayBuildResult(result)).toContain(
      result.models[0].positions.buffer,
    );
    expect(transferablesForViewport3DRegionOverlayBuildResult(result)).toContain(
      result.models[0].surfaceIndices?.buffer,
    );
  });
});
