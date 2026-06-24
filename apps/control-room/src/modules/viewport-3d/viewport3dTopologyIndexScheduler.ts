"use client";

import {
  buildViewport3DTopologyIndexBundle,
  type Viewport3DTopologyIndexBundle,
  type Viewport3DTopologyIndexPartInput,
} from "./viewport3dTopologyIndexModel";

export interface Viewport3DTopologyIndexBuildRequest {
  airboxParts: readonly Viewport3DTopologyIndexPartInput[];
  magneticParts: readonly Viewport3DTopologyIndexPartInput[];
  magneticSurfacePartsByPartId?: ReadonlyMap<
    string,
    readonly Viewport3DTopologyIndexPartInput[]
  >;
  topology: {
    boundaryFaces: Uint32Array;
    indices: Uint32Array;
    nodeCount: number;
  };
}

export interface Viewport3DTopologyIndexBuildOptions {
  signal?: AbortSignal;
}

interface TopologyIndexWorkerRequest extends Viewport3DTopologyIndexBuildRequest {
  id: number;
  magneticSurfacePartsByPartIdEntries: Array<
    [string, Viewport3DTopologyIndexPartInput[]]
  >;
}

interface TopologyIndexWorkerOkResponse {
  data: Viewport3DTopologyIndexBundle;
  id: number;
  ok: true;
}

interface TopologyIndexWorkerErrorResponse {
  error: {
    message: string;
    name: string;
  };
  id: number;
  ok: false;
}

type TopologyIndexWorkerResponse =
  | TopologyIndexWorkerErrorResponse
  | TopologyIndexWorkerOkResponse;

interface PendingTopologyIndexBuild {
  abortListener: (() => void) | null;
  reject: (reason: unknown) => void;
  resolve: (value: Viewport3DTopologyIndexBundle) => void;
  signal: AbortSignal | null;
}

const TOPOLOGY_INDEX_WORKER_IDLE_TIMEOUT_MS = 30_000;

let topologyIndexWorkerClient:
  | TopologyIndexWorkerClient
  | null
  | undefined;

export async function buildViewport3DTopologyIndicesOffMainThread(
  request: Viewport3DTopologyIndexBuildRequest,
  options: Viewport3DTopologyIndexBuildOptions = {},
): Promise<Viewport3DTopologyIndexBundle> {
  throwIfAborted(options.signal);
  const client = getTopologyIndexWorkerClient();
  if (client) {
    try {
      return await client.build(request, options);
    } catch (error) {
      if (isAbortError(error)) throw error;
      topologyIndexWorkerClient = null;
    }
  }

  return buildViewport3DTopologyIndexBundle(request);
}

export function disposeViewport3DTopologyIndexWorkerForTests(): void {
  topologyIndexWorkerClient?.dispose();
  topologyIndexWorkerClient = undefined;
}

function getTopologyIndexWorkerClient(): TopologyIndexWorkerClient | null {
  if (topologyIndexWorkerClient !== undefined) {
    return topologyIndexWorkerClient;
  }

  if (typeof Worker === "undefined") {
    topologyIndexWorkerClient = null;
    return topologyIndexWorkerClient;
  }

  try {
    topologyIndexWorkerClient = new TopologyIndexWorkerClient();
  } catch {
    topologyIndexWorkerClient = null;
  }
  return topologyIndexWorkerClient;
}

class TopologyIndexWorkerClient {
  private disposed = false;
  private idleTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingTopologyIndexBuild>();
  private readonly worker: Worker;

  constructor() {
    this.worker = new Worker(
      new URL("./viewport3dTopologyIndexWorker.ts", import.meta.url),
      {
        name: "fullmag-viewport3d-topology-index",
        type: "module",
      },
    );
    this.worker.addEventListener("message", this.handleMessage);
    this.worker.addEventListener("error", this.handleError);
    this.worker.addEventListener("messageerror", this.handleError);
  }

  build(
    input: Viewport3DTopologyIndexBuildRequest,
    options: Viewport3DTopologyIndexBuildOptions,
  ): Promise<Viewport3DTopologyIndexBundle> {
    if (this.disposed) {
      return Promise.reject(
        new Error("Viewport 3D topology index worker has been disposed."),
      );
    }
    throwIfAborted(options.signal);
    this.clearIdleDisposeTimer();
    const id = this.nextId++;
    const boundaryFaces = new Uint32Array(input.topology.boundaryFaces);
    const indices = new Uint32Array(input.topology.indices);
    const request: TopologyIndexWorkerRequest = {
      airboxParts: clonePartInputs(input.airboxParts),
      id,
      magneticParts: clonePartInputs(input.magneticParts),
      magneticSurfacePartsByPartId: undefined,
      magneticSurfacePartsByPartIdEntries: serializePartMap(
        input.magneticSurfacePartsByPartId,
      ),
      topology: {
        boundaryFaces,
        indices,
        nodeCount: input.topology.nodeCount,
      },
    };
    const transferables: Transferable[] = [];
    addArrayBufferTransferable(transferables, boundaryFaces.buffer);
    addArrayBufferTransferable(transferables, indices.buffer);

    return new Promise((resolve, reject) => {
      const signal = options.signal ?? null;
      const abortListener = signal
        ? () => {
            this.abortPending(id);
          }
        : null;
      if (signal && abortListener) {
        signal.addEventListener("abort", abortListener, { once: true });
      }
      this.pending.set(id, {
        abortListener,
        reject,
        resolve,
        signal,
      });
      try {
        this.worker.postMessage(request, transferables);
      } catch (error) {
        this.clearPending(id);
        this.dispose(error);
        reject(error);
      }
    });
  }

  dispose(reason?: unknown): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearIdleDisposeTimer();
    const error =
      reason instanceof Error
        ? reason
        : new Error("Viewport 3D topology index worker has been disposed.");
    for (const id of this.pending.keys()) {
      const pending = this.clearPending(id);
      pending?.reject(error);
    }
    this.worker.removeEventListener("message", this.handleMessage);
    this.worker.removeEventListener("error", this.handleError);
    this.worker.removeEventListener("messageerror", this.handleError);
    this.worker.terminate();
    if (topologyIndexWorkerClient === this) {
      topologyIndexWorkerClient = undefined;
    }
  }

  private readonly handleMessage = (
    event: MessageEvent<TopologyIndexWorkerResponse>,
  ): void => {
    if (this.disposed) return;
    const response = event.data;
    const pending = this.clearPending(response.id);
    if (!pending) {
      return;
    }

    if (response.ok) {
      pending.resolve(response.data);
      this.scheduleIdleDispose();
      return;
    }

    const error = new Error(response.error.message);
    error.name = response.error.name;
    pending.reject(error);
    this.scheduleIdleDispose();
  };

  private readonly handleError = (event: Event): void => {
    const message =
      typeof ErrorEvent !== "undefined" && event instanceof ErrorEvent
        ? event.message
        : "Viewport 3D topology index worker failed.";
    const error = new Error(message);
    error.name = "Viewport3DTopologyIndexWorkerError";
    this.dispose(error);
  };

  private clearPending(id: number): PendingTopologyIndexBuild | null {
    const pending = this.pending.get(id);
    if (!pending) return null;
    this.pending.delete(id);
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
    return pending;
  }

  private abortPending(id: number): void {
    const pending = this.clearPending(id);
    if (!pending) return;
    pending.reject(createAbortError());
    this.scheduleIdleDispose();
  }

  private scheduleIdleDispose(): void {
    if (this.pending.size > 0 || this.idleTimeoutId !== null) return;
    this.idleTimeoutId = setTimeout(() => {
      this.idleTimeoutId = null;
      this.dispose();
    }, TOPOLOGY_INDEX_WORKER_IDLE_TIMEOUT_MS);
  }

  private clearIdleDisposeTimer(): void {
    if (this.idleTimeoutId === null) return;
    clearTimeout(this.idleTimeoutId);
    this.idleTimeoutId = null;
  }
}

function clonePartInputs(
  parts: readonly Viewport3DTopologyIndexPartInput[],
): Viewport3DTopologyIndexPartInput[] {
  return parts.map((part) => ({
    boundary_face_count: part.boundary_face_count,
    boundary_face_indices: part.boundary_face_indices
      ? [...part.boundary_face_indices]
      : undefined,
    boundary_face_start: part.boundary_face_start,
    element_count: part.element_count,
    element_start: part.element_start,
    id: part.id,
    node_count: part.node_count,
    node_indices: part.node_indices ? [...part.node_indices] : undefined,
    node_start: part.node_start,
    nodeCount: part.nodeCount,
    surface_faces: part.surface_faces
      ? part.surface_faces.map((face) => [...face])
      : undefined,
  }));
}

function serializePartMap(
  partMap:
    | ReadonlyMap<string, readonly Viewport3DTopologyIndexPartInput[]>
    | undefined,
): Array<[string, Viewport3DTopologyIndexPartInput[]]> {
  if (!partMap) return [];
  return [...partMap.entries()].map(([id, parts]) => [id, clonePartInputs(parts)]);
}

function addArrayBufferTransferable(
  transferables: Transferable[],
  buffer: ArrayBufferLike | undefined,
): void {
  if (buffer instanceof ArrayBuffer) {
    transferables.push(buffer);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function createAbortError(): Error {
  const error = new Error("Topology index build aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      error.message === "Topology index build aborted")
  );
}
