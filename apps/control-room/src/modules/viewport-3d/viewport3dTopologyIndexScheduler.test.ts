import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildViewport3DTopologyIndicesOffMainThread,
  estimateTopologyIndexBuildOutputBytes,
  type Viewport3DTopologyIndexBuildRequest,
} from "./viewport3dTopologyIndexScheduler";
import { topologyIndexBundleByteLength } from "./viewport3dTopologyIndexModel";
import type { Viewport3DBuildDiagnosticRecord } from "./build-engine/viewport3dBuildEngineTypes";

describe("viewport3dTopologyIndexScheduler", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to the shared topology index builder when workers are unavailable", async () => {
    vi.stubGlobal("Worker", undefined);

    const bundle = await buildViewport3DTopologyIndicesOffMainThread({
      airboxParts: [
        {
          boundary_face_count: 1,
          boundary_face_start: 1,
          id: "airbox",
        },
      ],
      magneticParts: [
        {
          boundary_face_count: 1,
          boundary_face_start: 0,
          element_count: 1,
          element_start: 0,
          id: "magnetic",
        },
      ],
      magneticSurfacePartsByPartId: new Map([
        [
          "magnetic",
          [
            {
              boundary_face_count: 1,
              boundary_face_start: 1,
              id: "magnetic-surface",
            },
          ],
        ],
      ]),
      topology: {
        boundaryFaces: new Uint32Array([
          0, 1, 2,
          3, 2, 1,
        ]),
        indices: new Uint32Array([0, 1, 2, 3]),
        nodeCount: 4,
      },
    });

    expect(Array.from(bundle.fallbackSurfaceIndices)).toEqual([
      0, 1, 2,
      0, 1, 3,
      0, 2, 3,
      1, 2, 3,
    ]);
    expect(
      Array.from(bundle.magneticPartsById.get("magnetic")?.surfaceIndices ?? []),
    ).toEqual([
      0, 1, 2,
      3, 2, 1,
    ]);
    expect(
      Array.from(bundle.airboxPartsById.get("airbox")?.surfaceIndices ?? []),
    ).toEqual([3, 2, 1]);
  });

  it("transfers topology input and output buffers through the worker path", () => {
    const schedulerSource = readFileSync(
      new URL("./viewport3dTopologyIndexScheduler.ts", import.meta.url),
      "utf8",
    );
    const workerSource = readFileSync(
      new URL("./viewport3dTopologyIndexWorker.ts", import.meta.url),
      "utf8",
    );
    const modelSource = readFileSync(
      new URL("./viewport3dTopologyIndexModel.ts", import.meta.url),
      "utf8",
    );

    expect(schedulerSource).toContain(
      "this.worker.postMessage(request, transferables)",
    );
    expect(schedulerSource).toContain("addArrayBufferTransferable");
    expect(schedulerSource).toContain("cellGlobalOrdinals");
    expect(workerSource).toContain("cellGlobalOrdinals");
    expect(workerSource).toContain("transferablesForTopologyIndexBundle(data)");
    expect(modelSource).toContain("transferablesForTopologyIndexBundle");
  });

  it("routes topology index work through the build-engine topology-index lane", async () => {
    vi.stubGlobal("Worker", undefined);
    const records: Viewport3DBuildDiagnosticRecord[] = [];

    const request: Viewport3DTopologyIndexBuildRequest = {
      airboxParts: [],
      magneticParts: [
        {
          boundary_face_count: 0,
          boundary_face_start: 0,
          element_count: 1,
          element_start: 0,
          id: "magnetic",
        },
      ],
      topology: {
        boundaryFaces: new Uint32Array([]),
        indices: new Uint32Array([0, 1, 2, 3]),
        nodeCount: 4,
      },
    };
    await buildViewport3DTopologyIndicesOffMainThread(
      request,
      {
        buildKey: "topology-index:session=current:topology=mesh-7",
        groupKey: "topology-index:session=current",
        latestWins: true,
        onDiagnosticRecord: (record) => records.push(record),
        revisionSummary: "topology=mesh-7",
      },
    );

    expect(records).toEqual([
      expect.objectContaining({
        inputBytes: 16,
        itemCount: 4,
        key: "topology-index:session=current:topology=mesh-7",
        lane: "topology-index",
        mainAdoptMs: 0,
        outputBytes: 368,
        queueWaitMs: expect.any(Number),
        revisionSummary: "topology=mesh-7",
        state: "ready",
      }),
    ]);
  });

  it("includes aligned surface cell identity arrays in output byte estimates", async () => {
    vi.stubGlobal("Worker", undefined);
    const records: Viewport3DBuildDiagnosticRecord[] = [];

    const request: Viewport3DTopologyIndexBuildRequest = {
      airboxParts: [],
      magneticParts: [
        {
          boundary_face_count: 1,
          boundary_face_start: 0,
          element_count: 1,
          element_start: 0,
          id: "magnetic",
        },
      ],
      topology: {
        boundaryFaces: new Uint32Array([0, 1, 2]),
        cellGlobalOrdinals: new BigUint64Array([
          BigInt("9007199254740993"),
        ]),
        indices: new Uint32Array([0, 1, 2, 3]),
        nodeCount: 4,
      },
    };
    const bundle = await buildViewport3DTopologyIndicesOffMainThread(
      request,
      {
        buildKey: "topology-index:identity-bytes",
        onDiagnosticRecord: (record) => records.push(record),
      },
    );

    expect(records.at(-1)).toMatchObject({
      inputBytes: 36,
      outputBytes: 272,
      state: "ready",
    });
    expect(estimateTopologyIndexBuildOutputBytes(request)).toBeGreaterThanOrEqual(
      topologyIndexBundleByteLength(bundle),
    );
  });

  describe("M-08 · recovers the worker instead of permanently degrading a lane", () => {
    const source = readFileSync(
      new URL("./viewport3dTopologyIndexScheduler.ts", import.meta.url),
      "utf8",
    );
    const executeStart = source.indexOf(
      "async function executeViewport3DTopologyIndexBuild",
    );
    const disposeStart = source.indexOf(
      "export function disposeViewport3DTopologyIndexWorker",
    );
    const executeSource = source.slice(executeStart, disposeStart);
    const getClientStart = source.indexOf(
      "function getTopologyIndexWorkerClient(",
    );
    const getClientSource = source.slice(
      getClientStart,
      source.indexOf("\n}\n", getClientStart),
    );

    it("disposes the failed worker and clears it to undefined instead of null so it can be recreated", () => {
      expect(executeSource).toContain(
        "topologyIndexWorkerClient?.dispose(error);",
      );
      expect(executeSource).toContain("topologyIndexWorkerClient = undefined;");
      expect(executeSource).not.toContain("topologyIndexWorkerClient = null;");
    });

    it("backs off before recreating a worker that just failed", () => {
      expect(source).toContain(
        "const TOPOLOGY_INDEX_WORKER_RETRY_BACKOFF_MS = 5_000;",
      );
      expect(executeSource).toContain(
        "topologyIndexWorkerRetryNotBeforeMs =\n        Date.now() + TOPOLOGY_INDEX_WORKER_RETRY_BACKOFF_MS;",
      );
      expect(getClientSource).toContain(
        "if (Date.now() < topologyIndexWorkerRetryNotBeforeMs) {",
      );
    });

    it("resets the backoff window on an explicit dispose", () => {
      expect(source).toContain(
        "topologyIndexWorkerFallbackReason = undefined;\n  topologyIndexWorkerRetryNotBeforeMs = 0;",
      );
    });
  });
});
