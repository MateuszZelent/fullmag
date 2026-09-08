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

  describe("M-08 · recovers the worker instead of permanently degrading a lane", () => {
    const source = readFileSync(
      new URL("./viewport3dRegionOverlayBuildScheduler.ts", import.meta.url),
      "utf8",
    );
    const executeStart = source.indexOf(
      "async function executeViewport3DRegionOverlayBuild",
    );
    const disposeStart = source.indexOf(
      "export function disposeViewport3DRegionOverlayBuildWorker",
    );
    const executeSource = source.slice(executeStart, disposeStart);
    const getClientStart = source.indexOf(
      "function getRegionOverlayWorkerClient(",
    );
    const getClientSource = source.slice(
      getClientStart,
      source.indexOf("\n}\n", getClientStart),
    );

    it("disposes the failed worker and clears it to undefined instead of null so it can be recreated", () => {
      expect(executeSource).toContain(
        "regionOverlayWorkerClient?.dispose(error);",
      );
      expect(executeSource).toContain("regionOverlayWorkerClient = undefined;");
      expect(executeSource).not.toContain("regionOverlayWorkerClient = null;");
    });

    it("backs off before recreating a worker that just failed", () => {
      expect(source).toContain(
        "const REGION_OVERLAY_WORKER_RETRY_BACKOFF_MS = 5_000;",
      );
      expect(executeSource).toContain(
        "regionOverlayWorkerRetryNotBeforeMs =\n        Date.now() + REGION_OVERLAY_WORKER_RETRY_BACKOFF_MS;",
      );
      expect(getClientSource).toContain(
        "if (Date.now() < regionOverlayWorkerRetryNotBeforeMs) {",
      );
    });

    it("resets the backoff window on an explicit dispose", () => {
      expect(source).toContain(
        "regionOverlayWorkerFallbackReason = undefined;\n  regionOverlayWorkerRetryNotBeforeMs = 0;",
      );
    });
  });
});
