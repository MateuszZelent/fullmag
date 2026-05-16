import { afterEach, describe, expect, it, vi } from "vitest";

import type { FemMeshData } from "../femMeshTypes";
import { buildFemSliceSamplingWorkerPayload, visibilityPayloadToState } from "../femSliceSamplingTransport";
import { FemSliceSamplingWorkerClient } from "../useFemSliceSampling";
import type { SliceVisibilityState } from "../femSliceUtils";

function makeMeshData(): FemMeshData {
  return {
    nodes: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
    elements: new Uint32Array([0, 1, 2, 3]),
    boundaryFaces: new Uint32Array([0, 1, 2]),
    nNodes: 4,
    nElements: 1,
    fieldNComp: 3,
    fieldData: {
      x: new Float32Array([1, 2, 3, 4]),
      y: new Float32Array([5, 6, 7, 8]),
      z: new Float32Array([9, 10, 11, 12]),
    },
  };
}

function makeVisibilityState(): SliceVisibilityState {
  return {
    visibleElements: new Uint8Array([1]),
    visibleBoundaryFaces: new Uint8Array([1]),
    elementPartIds: ["part-a"],
    boundaryFacePartIds: ["part-a"],
    visiblePartIds: new Set(["part-a"]),
    partById: new Map([
      [
        "part-a",
        {
          id: "part-a",
          label: "Part A",
          role: "magnetic_object",
          object_id: "object-a",
          geometry_id: null,
          material_id: null,
          element_start: 0,
          element_count: 1,
          boundary_face_start: 0,
          boundary_face_count: 1,
          boundary_face_indices: [],
          node_start: 0,
          node_count: 4,
          node_indices: [],
          surface_faces: [],
          bounds_min: [0, 0, 0],
          bounds_max: [1, 1, 1],
        },
      ],
    ]),
  };
}

describe("buildFemSliceSamplingWorkerPayload", () => {
  it("builds a transfer-list payload without detaching canonical arrays", () => {
    const meshData = makeMeshData();
    const sourceNodes = meshData.nodes as Float32Array;
    const built = buildFemSliceSamplingWorkerPayload({
      id: 10,
      meshData,
      plane: "xy",
      planeCoord: 0.5,
      component: "magnitude",
      visibilityState: makeVisibilityState(),
      boundsStrategy: "visible-context",
    });

    expect(built.message.id).toBe(10);
    expect(built.message.payload.meshData).not.toBe(meshData);
    expect(built.message.payload.meshData.nodes).toBeInstanceOf(Float32Array);
    expect(built.message.payload.meshData.nodes).not.toBe(sourceNodes);
    expect(sourceNodes.byteLength).toBeGreaterThan(0);
    expect(built.transferList).toContain(built.message.payload.meshData.nodes.buffer);
    expect(built.transferList).toContain(built.message.payload.meshData.elements.buffer);
    expect(built.transferList).toContain(built.message.payload.meshData.fieldData?.x.buffer);
    expect(built.estimatedBytes).toBeGreaterThan(0);
  });

  it("round-trips compact visibility payload into SliceVisibilityState", () => {
    const built = buildFemSliceSamplingWorkerPayload({
      id: 1,
      meshData: makeMeshData(),
      plane: "xz",
      planeCoord: 0.25,
      component: "x",
      visibilityState: makeVisibilityState(),
      boundsStrategy: "visible-intersection",
    });

    const state = visibilityPayloadToState(built.message.payload.visibilityState);

    expect(state.visibleElements?.[0]).toBe(1);
    expect(state.visibleBoundaryFaces?.[0]).toBe(1);
    expect(state.visiblePartIds.has("part-a")).toBe(true);
    expect(state.partById.get("part-a")?.bounds_min).toEqual([0, 0, 0]);
  });
});

class MockWorker {
  static instances: MockWorker[] = [];
  listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  postMessage = vi.fn();
  terminate = vi.fn();

  constructor() {
    MockWorker.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data } as MessageEvent);
    }
  }
}

describe("FemSliceSamplingWorkerClient", () => {
  const originalWindow = globalThis.window;
  const originalWorker = globalThis.Worker;

  afterEach(() => {
    vi.restoreAllMocks();
    MockWorker.instances = [];
    Object.defineProperty(globalThis, "window", {
      value: originalWindow,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "Worker", {
      value: originalWorker,
      configurable: true,
      writable: true,
    });
  });

  it("ignores canceled responses and terminates the active worker", () => {
    Object.defineProperty(globalThis, "window", {
      value: {},
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "Worker", {
      value: MockWorker,
      configurable: true,
      writable: true,
    });
    const onSuccess = vi.fn();
    const onFailure = vi.fn();
    const client = new FemSliceSamplingWorkerClient();
    const result = client.postCompute(
      {
        meshData: makeMeshData(),
        plane: "xy",
        planeCoord: 0.5,
        component: "x",
        visibilityState: makeVisibilityState(),
        boundsStrategy: "visible-context",
      },
      { onSuccess, onFailure },
    );

    expect(result.ok).toBe(true);
    const worker = MockWorker.instances[0];
    client.cancelRequest(result.ok ? result.requestId : -1, "test-cancel");
    worker.emit("message", { id: result.ok ? result.requestId : -1, ok: true });

    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });
});
