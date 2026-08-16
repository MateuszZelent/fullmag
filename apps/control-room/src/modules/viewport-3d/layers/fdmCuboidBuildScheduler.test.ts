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

describe("FDM cuboid build scheduler", () => {
  afterEach(() => {
    disposeViewport3DFdmCuboidBuildWorker();
    LoopbackFdmCuboidWorker.instances = [];
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
        maxVectors: 2,
        scale: 1,
      },
      { buildKey: "fdm-vector-only:test" },
    );

    expect(LoopbackFdmCuboidWorker.instances[0]?.requests[0]?.vectorOnly).toBeTruthy();
    expect(result.model).toBeNull();
    expect(result.vectorCellIndices).toEqual(new Uint32Array([0, 1]));
  });
});
