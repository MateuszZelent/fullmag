import { afterEach, describe, expect, it, vi } from "vitest";

import { FMRM_INACTIVE_REGION_ID } from "@/kernel/api/codecs";

import {
  buildViewport3DFdmCuboidOffMainThread,
  buildViewport3DFdmVectorsOffMainThread,
  disposeViewport3DFdmCuboidBuildWorker,
} from "./fdmCuboidBuildScheduler";
import {
  installFdmCuboidBuildWorker,
  type FdmCuboidBuildWorkerRequest,
  type FdmCuboidBuildWorkerResponse,
} from "./fdmCuboidBuildWorker";
import type { FdmCuboidBuildRequest } from "./fdmCuboidBuildModel";
import type { Viewport3DBuildDiagnosticRecord } from "../build-engine/viewport3dBuildEngineTypes";

class LoopbackFdmCuboidWorker {
  static instances: LoopbackFdmCuboidWorker[] = [];

  readonly requests: FdmCuboidBuildWorkerRequest[] = [];
  private readonly listeners = new Map<string, Set<EventListener>>();
  private workerListener:
    | ((event: MessageEvent<FdmCuboidBuildWorkerRequest>) => void)
    | null = null;

  constructor() {
    LoopbackFdmCuboidWorker.instances.push(this);
    installFdmCuboidBuildWorker({
      addEventListener: (_type, listener) => {
        this.workerListener = listener;
      },
      postMessage: (message: FdmCuboidBuildWorkerResponse) => {
        this.emit("message", { data: message });
      },
    });
  }

  addEventListener(type: string, listener: EventListener): void {
    (this.listeners.get(type) ?? this.createListeners(type)).add(listener);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(
    request: FdmCuboidBuildWorkerRequest,
    _transferables?: Transferable[],
  ): void {
    void _transferables;
    this.requests.push(request);
    this.workerListener?.({ data: request } as MessageEvent<FdmCuboidBuildWorkerRequest>);
  }

  terminate(): void {}

  private createListeners(type: string): Set<EventListener> {
    const listeners = new Set<EventListener>();
    this.listeners.set(type, listeners);
    return listeners;
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event as Event);
    }
  }
}

class ErroringFdmCuboidWorker {
  static instances: ErroringFdmCuboidWorker[] = [];

  readonly terminate = vi.fn();
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor() {
    ErroringFdmCuboidWorker.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(
    _request: FdmCuboidBuildWorkerRequest,
    _transferables?: Transferable[],
  ): void {
    void _transferables;
    for (const listener of this.listeners.get("error") ?? []) {
      listener(new Event("error"));
    }
  }
}

function createFallbackFdmCuboidRequest(
  displayCellCount: number,
): FdmCuboidBuildRequest {
  const isLarge = displayCellCount > 2;
  return {
    cellSelection: "all",
    domain: {
      bounds: null,
      displayCellBudget: displayCellCount,
      displayCellCount,
      kind: "fdm-grid",
      origin: [0, 0, 0],
      shape: [displayCellCount, 1, 1],
      spacing: [1, 1, 1],
      stride: 1,
      totalCells: displayCellCount,
    },
    maxVectorGlyphs: 0,
    realizedRegionIds: isLarge
      ? null
      : new Uint32Array([FMRM_INACTIVE_REGION_ID, 7]),
    vectorAnchorMode: "center",
    vectorScale: 0,
    voxelFillRatio: 0.92,
    voxelMagnitudeThreshold: 0,
    voxelTopography: {
      amplitudeCells: 0,
      component: "magnitude",
      enabled: false,
    },
  };
}

describe("FDM cuboid build scheduler", () => {
  afterEach(() => {
    disposeViewport3DFdmCuboidBuildWorker();
    LoopbackFdmCuboidWorker.instances = [];
    ErroringFdmCuboidWorker.instances = [];
    vi.unstubAllGlobals();
  });

  it("preserves cell selection through the scheduler and worker request round-trip", async () => {
    vi.stubGlobal("Worker", LoopbackFdmCuboidWorker);

    const result = await buildViewport3DFdmCuboidOffMainThread(
      {
        cellSelection: "inactive",
        domain: {
          bounds: null,
          displayCellBudget: 2,
          displayCellCount: 2,
          kind: "fdm-grid",
          origin: [0, 0, 0],
          shape: [2, 1, 1],
          spacing: [1, 1, 1],
          stride: 1,
          totalCells: 2,
        },
        maxVectorGlyphs: 0,
        realizedRegionIds: new Uint32Array([FMRM_INACTIVE_REGION_ID, 7]),
        vectorAnchorMode: "center",
        vectorScale: 0,
        voxelFillRatio: 0.92,
        voxelMagnitudeThreshold: 0,
        voxelTopography: {
          amplitudeCells: 0,
          component: "magnitude",
          enabled: false,
        },
      },
      { buildKey: "fdm-cuboid:inactive-round-trip" },
    );

    expect(LoopbackFdmCuboidWorker.instances[0]?.requests[0]?.cellSelection).toBe(
      "inactive",
    );
    expect(result.model?.cellIndices).toEqual(new Uint32Array([0]));
    expect(result.model?.regionIds).toEqual(
      new Uint32Array([FMRM_INACTIVE_REGION_ID]),
    );
  });

  it("routes vector-only requests through the worker without a cuboid model", async () => {
    vi.stubGlobal("Worker", LoopbackFdmCuboidWorker);
    const result = await buildViewport3DFdmVectorsOffMainThread(
      {
        anchorMode: "center",
        anchors: new Float32Array([0, 0, 0, 1, 0, 0]),
        cellIndices: new Uint32Array([0, 1]),
        fieldVector: {
          dtype: "float64",
          grid: [2, 1, 1],
          nComp: 3,
          pointCount: 2,
          quantityId: "H_demag",
          valueCount: 6,
          values: new Float64Array([1, 0, 0, 0, 1, 0]),
        },
        gridShape: [2, 1, 1],
        membershipAdmission: "full-domain",
        maxVectors: 2,
        scale: 1,
      },
      { buildKey: "fdm-vector-only:test" },
    );

    expect(LoopbackFdmCuboidWorker.instances[0]?.requests[0]?.vectorOnly).toBeTruthy();
    expect(result.model).toBeNull();
    expect(result.vectorCellIndices).toEqual(new Uint32Array([0, 1]));
  });

  it("carries exact vectors-only membership through the worker request", async () => {
    vi.stubGlobal("Worker", LoopbackFdmCuboidWorker);
    const result = await buildViewport3DFdmVectorsOffMainThread(
      {
        anchorMode: "center",
        anchors: new Float32Array([0, 0, 0, 1, 0, 0]),
        cellIndices: new Uint32Array([0, 1]),
        cellSelection: "active",
        fieldVector: {
          dtype: "float64",
          grid: [2, 1, 1],
          nComp: 3,
          pointCount: 2,
          quantityId: "H_demag",
          valueCount: 6,
          values: new Float64Array([1, 0, 0, 0, 1, 0]),
        },
        gridShape: [2, 1, 1],
        maxVectors: 2,
        realizedRegionIds: new Uint32Array([0, FMRM_INACTIVE_REGION_ID]),
        scale: 1,
      },
      { buildKey: "fdm-vector-only:exact-membership" },
    );

    expect(LoopbackFdmCuboidWorker.instances[0]?.requests[0]?.cellSelection).toBe(
      "active",
    );
    expect(result.vectorCellIndices).toEqual(new Uint32Array([0]));
  });

  it("carries native mask evidence through the worker and filters active vectors", async () => {
    vi.stubGlobal("Worker", LoopbackFdmCuboidWorker);
    const result = await buildViewport3DFdmVectorsOffMainThread(
      {
        anchorMode: "center",
        anchors: new Float32Array([0, 0, 0, 1, 0, 0]),
        cellIndices: new Uint32Array([0, 1]),
        cellSelection: "active",
        fieldVector: {
          dtype: "float64",
          grid: [2, 1, 1],
          nComp: 3,
          pointCount: 2,
          quantityId: "H_demag",
          valueCount: 6,
          values: new Float64Array([1, 0, 0, 0, 1, 0]),
        },
        gridShape: [2, 1, 1],
        maxVectors: 2,
        nativeActiveMask: new Uint8Array([1, 0]),
        scale: 1,
      },
      { buildKey: "fdm-vector-only:native-mask" },
    );

    expect(
      LoopbackFdmCuboidWorker.instances[0]?.requests[0]?.vectorOnly
        ?.nativeActiveMask,
    ).toEqual(new Uint8Array([1, 0]));
    expect(result.vectorCellIndices).toEqual(new Uint32Array([0]));
  });

  it("does not schedule a worker for exact admission without exact evidence", async () => {
    vi.stubGlobal("Worker", LoopbackFdmCuboidWorker);
    const result = await buildViewport3DFdmVectorsOffMainThread(
      {
        anchorMode: "center",
        anchors: new Float32Array([0, 0, 0]),
        cellIndices: new Uint32Array([0]),
        fieldVector: {
          dtype: "float64",
          grid: [1, 1, 1],
          nComp: 3,
          pointCount: 1,
          quantityId: "H_demag",
          valueCount: 3,
          values: new Float64Array([1, 0, 0]),
        },
        gridShape: [1, 1, 1],
        membershipAdmission: "exact",
        maxVectors: 1,
        scale: 1,
      },
      { buildKey: "fdm-vector-only:missing-membership" },
    );

    expect(LoopbackFdmCuboidWorker.instances).toHaveLength(0);
    expect(result.vectorCellIndices).toBeNull();
    expect(result.vectorSegments).toBeNull();
  });

  it("rejects full-domain admission for dense vectors-only selection before scheduling", async () => {
    vi.stubGlobal("Worker", LoopbackFdmCuboidWorker);
    const result = await buildViewport3DFdmVectorsOffMainThread(
      {
        anchorMode: "center",
        anchors: new Float32Array([0, 0, 0]),
        cellIndices: new Uint32Array([0]),
        cellSelection: "dense",
        fieldVector: {
          dtype: "float64",
          grid: [1, 1, 1],
          nComp: 3,
          pointCount: 1,
          quantityId: "H_demag",
          valueCount: 3,
          values: new Float64Array([1, 0, 0]),
        },
        gridShape: [1, 1, 1],
        membershipAdmission: "full-domain",
        maxVectors: 1,
        scale: 1,
      },
      { buildKey: "fdm-vector-only:dense-full-domain" },
    );

    expect(LoopbackFdmCuboidWorker.instances).toHaveLength(0);
    expect(result.vectorCellIndices).toBeNull();
    expect(result.vectorSegments).toBeNull();
  });

  it.each(["realizedRegionIds", "nativeActiveMask"] as const)(
    "rejects wrong-length %s before scheduling",
    async (evidenceKind) => {
      vi.stubGlobal("Worker", LoopbackFdmCuboidWorker);
      const result = await buildViewport3DFdmVectorsOffMainThread(
        {
          anchorMode: "center",
          anchors: new Float32Array([0, 0, 0, 1, 0, 0]),
          cellIndices: new Uint32Array([0, 1]),
          cellSelection: "active",
          fieldVector: {
            dtype: "float64",
            grid: [2, 1, 1],
            nComp: 3,
            pointCount: 2,
            quantityId: "H_demag",
            valueCount: 6,
            values: new Float64Array([1, 0, 0, 0, 1, 0]),
          },
          gridShape: [2, 1, 1],
          membershipAdmission: "exact",
          maxVectors: 2,
          nativeActiveMask:
            evidenceKind === "nativeActiveMask"
              ? new Uint8Array([1])
              : null,
          realizedRegionIds:
            evidenceKind === "realizedRegionIds"
              ? new Uint32Array([0])
              : null,
          scale: 1,
        },
        { buildKey: "fdm-vector-only:wrong-" + evidenceKind },
      );

      expect(LoopbackFdmCuboidWorker.instances).toHaveLength(0);
      expect(result.vectorCellIndices).toBeNull();
      expect(result.vectorSegments).toBeNull();
    },
  );

  it("does not schedule an active full-cuboid job without exact membership", async () => {
    vi.stubGlobal("Worker", LoopbackFdmCuboidWorker);
    const request = createFallbackFdmCuboidRequest(1);
    const result = await buildViewport3DFdmCuboidOffMainThread(
      {
        ...request,
        cellSelection: "active",
        realizedRegionIds: null,
      },
      { buildKey: "fdm-cuboid:missing-active-membership" },
    );

    expect(LoopbackFdmCuboidWorker.instances).toHaveLength(0);
    expect(result.model).toBeNull();
    expect(result.vectorCellIndices).toBeNull();
  });

  it("keeps a small full-cuboid fallback available when the worker is unavailable", async () => {
    vi.stubGlobal("Worker", undefined);
    const records: Viewport3DBuildDiagnosticRecord[] = [];

    const result = await buildViewport3DFdmCuboidOffMainThread(
      createFallbackFdmCuboidRequest(2),
      {
        buildKey: "fdm-cuboid:small-worker-unavailable",
        onDiagnosticRecord: (record) => records.push(record),
      },
    );

    expect(result.model?.count).toBe(2);
    expect(records).toEqual([
      expect.objectContaining({
        fallbackReason: "worker-unavailable",
        key: "fdm-cuboid:small-worker-unavailable",
        state: "ready",
      }),
    ]);
  });

  it("fails closed instead of building a large cuboid on the main thread", async () => {
    vi.stubGlobal("Worker", undefined);
    const records: Viewport3DBuildDiagnosticRecord[] = [];

    await expect(
      buildViewport3DFdmCuboidOffMainThread(
        createFallbackFdmCuboidRequest(4097),
        {
          buildKey: "fdm-cuboid:large-worker-unavailable",
          onDiagnosticRecord: (record) => records.push(record),
        },
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("worker is unavailable"),
      name: "Viewport3DFdmCuboidWorkerUnavailableError",
    });

    expect(records).toEqual([
      expect.objectContaining({
        fallbackReason: "worker-unavailable",
        key: "fdm-cuboid:large-worker-unavailable",
        state: "failed",
      }),
    ]);
  });

  it("terminates a failed worker before rejecting a large fallback", async () => {
    vi.stubGlobal("Worker", ErroringFdmCuboidWorker);
    const records: Viewport3DBuildDiagnosticRecord[] = [];

    await expect(
      buildViewport3DFdmCuboidOffMainThread(
        createFallbackFdmCuboidRequest(4097),
        {
          buildKey: "fdm-cuboid:large-worker-error",
          onDiagnosticRecord: (record) => records.push(record),
        },
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("worker failed"),
      name: "Viewport3DFdmCuboidWorkerFailedError",
    });

    expect(ErroringFdmCuboidWorker.instances[0]?.terminate).toHaveBeenCalledOnce();
    expect(records).toEqual([
      expect.objectContaining({
        fallbackReason: "worker-error",
        key: "fdm-cuboid:large-worker-error",
        state: "failed",
      }),
    ]);
  });
});
