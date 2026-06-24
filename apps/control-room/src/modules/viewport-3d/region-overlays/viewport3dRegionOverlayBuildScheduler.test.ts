import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Viewport3DBuildDiagnosticRecord } from "../build-engine/viewport3dBuildEngineTypes";
import {
  buildViewport3DRegionOverlaysOffMainThread,
  disposeViewport3DRegionOverlayBuildWorkerForTests,
} from "./viewport3dRegionOverlayBuildScheduler";

describe("viewport3dRegionOverlayBuildScheduler", () => {
  afterEach(() => {
    disposeViewport3DRegionOverlayBuildWorkerForTests();
    vi.unstubAllGlobals();
  });

  it("falls back to the shared region overlay builder when workers are unavailable", async () => {
    vi.stubGlobal("Worker", undefined);
    const records: Viewport3DBuildDiagnosticRecord[] = [];

    const result = await buildViewport3DRegionOverlaysOffMainThread(
      {
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
      },
      {
        buildKey: "region-overlay:fallback-worker-unavailable",
        onDiagnosticRecord: (record) => records.push(record),
        revisionSummary: "topology=mesh-7 regions=regions-7",
      },
    );

    expect(result.models).toHaveLength(1);
    expect(Array.from(result.models[0].surfaceIndices ?? [])).toEqual([0, 1, 2]);
    expect(records).toEqual([
      expect.objectContaining({
        fallbackReason: "worker-unavailable",
        key: "region-overlay:fallback-worker-unavailable",
        lane: "region-overlay",
        outputBytes: expect.any(Number),
        revisionSummary: "topology=mesh-7 regions=regions-7",
        state: "ready",
      }),
    ]);
  });

  it("transfers region overlay input and output buffers through the worker path", () => {
    const schedulerSource = readFileSync(
      new URL("./viewport3dRegionOverlayBuildScheduler.ts", import.meta.url),
      "utf8",
    );
    const workerSource = readFileSync(
      new URL("./viewport3dRegionOverlayBuildWorker.ts", import.meta.url),
      "utf8",
    );
    const modelSource = readFileSync(
      new URL("./viewport3dRegionOverlayBuildModel.ts", import.meta.url),
      "utf8",
    );

    expect(schedulerSource).toContain(
      "this.worker.postMessage(request, transferables)",
    );
    expect(schedulerSource).toContain("addArrayBufferTransferable");
    expect(workerSource).toContain(
      "transferablesForViewport3DRegionOverlayBuildResult(data)",
    );
    expect(modelSource).toContain(
      "transferablesForViewport3DRegionOverlayBuildResult",
    );
  });
});
