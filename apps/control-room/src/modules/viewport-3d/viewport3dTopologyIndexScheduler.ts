"use client";

import {
  buildViewport3DTopologyIndexBundle,
  topologyIndexBundleByteLength,
  type Viewport3DTopologyIndexBundle,
  type Viewport3DTopologyIndexPartInput,
} from "./viewport3dTopologyIndexModel";
import type { Viewport3DBuildDiagnosticRecord } from "./build-engine/viewport3dBuildEngineTypes";
import { recordViewport3DBuildDiagnostic } from "./build-engine/viewport3dBuildDiagnostics";
import { createViewport3DBuildScheduler } from "./build-engine/viewport3dBuildScheduler";

export interface Viewport3DTopologyIndexBuildRequest {
  airboxParts: readonly Viewport3DTopologyIndexPartInput[];
  magneticParts: readonly Viewport3DTopologyIndexPartInput[];
  magneticSurfacePartsByPartId?: ReadonlyMap<
    string,
    readonly Viewport3DTopologyIndexPartInput[]
  >;
  topology: {
    boundaryFaces: Uint32Array;
    cellGlobalOrdinals?: BigUint64Array;
    cellNodes?: Uint32Array;
    cellOffsets?: Uint32Array;
    cellTypes?: Uint32Array;
    facetNodes?: Uint32Array;
    facetOffsets?: Uint32Array;
    facetTypes?: Uint32Array;
    indices: Uint32Array;
    nodeCount: number;
  };
}

export interface Viewport3DTopologyIndexBuildOptions {
  buildKey?: string;
  groupKey?: string;
  latestWins?: boolean;
  onDiagnosticRecord?: (record: Viewport3DBuildDiagnosticRecord) => void;
  revisionSummary?: string;
  signal?: AbortSignal;
}

interface Viewport3DTopologyIndexBuildExecutionOptions
  extends Viewport3DTopologyIndexBuildOptions {
  recordFallback?: (reason: string) => void;
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

let fallbackTopologyIndexBuildId = 1;
let topologyIndexBuildJobScheduler:
  | ReturnType<typeof createViewport3DBuildScheduler>
  | undefined;
let topologyIndexWorkerClient:
  | TopologyIndexWorkerClient
  | null
  | undefined;
let topologyIndexWorkerFallbackReason: string | null | undefined;

export async function buildViewport3DTopologyIndicesOffMainThread(
  request: Viewport3DTopologyIndexBuildRequest,
  options: Viewport3DTopologyIndexBuildOptions = {},
): Promise<Viewport3DTopologyIndexBundle> {
  throwIfAborted(options.signal);
  const buildKey =
    options.buildKey ??
    `topology-index:adhoc:${fallbackTopologyIndexBuildId++}`;
  const scheduler = getTopologyIndexBuildJobScheduler();
  return scheduler.schedule(
    {
      groupKey: options.groupKey,
      inputBytes: estimateTopologyIndexBuildInputBytes(request),
      itemCount: request.topology.nodeCount,
      key: buildKey,
      lane: "topology-index",
      outputBytesEstimate: estimateTopologyIndexBuildOutputBytes(request),
      revisionSummary: options.revisionSummary ?? buildKey,
    },
    async (_buildRequest, context) => {
      const bundle = await executeViewport3DTopologyIndexBuild(request, {
        recordFallback: context.recordFallback,
        signal: context.signal,
      });
      context.recordOutputBytes(topologyIndexBundleByteLength(bundle));
      return bundle;
    },
    {
      latestWins: options.latestWins,
      onDiagnosticRecord: options.onDiagnosticRecord,
      signal: options.signal,
    },
  );
}

async function executeViewport3DTopologyIndexBuild(
  request: Viewport3DTopologyIndexBuildRequest,
  options: Viewport3DTopologyIndexBuildExecutionOptions,
): Promise<Viewport3DTopologyIndexBundle> {
  throwIfAborted(options.signal);
  const client = getTopologyIndexWorkerClient();
  if (client) {
    try {
      return await client.build(request, options);
    } catch (error) {
      if (isAbortError(error)) throw error;
      topologyIndexWorkerFallbackReason = "worker-error";
      options.recordFallback?.(topologyIndexWorkerFallbackReason);
      topologyIndexWorkerClient = null;
    }
  } else {
    options.recordFallback?.(
      topologyIndexWorkerFallbackReason ?? "worker-unavailable",
    );
  }

  return buildViewport3DTopologyIndexBundle(request);
}

export function disposeViewport3DTopologyIndexWorker(): void {
  topologyIndexBuildJobScheduler?.dispose();
  topologyIndexBuildJobScheduler = undefined;
  topologyIndexWorkerClient?.dispose();
  topologyIndexWorkerClient = undefined;
  topologyIndexWorkerFallbackReason = undefined;
}

/** @deprecated Use disposeViewport3DTopologyIndexWorker. */
export const disposeViewport3DTopologyIndexWorkerForTests =
  disposeViewport3DTopologyIndexWorker;

export function getViewport3DTopologyIndexWorkerRuntimeCounts(): { timers: number; workers: number } {
  return topologyIndexWorkerClient?.getRuntimeCounts() ?? { timers: 0, workers: 0 };
}
export function getViewport3DTopologyIndexPendingJobCount(): number { return topologyIndexBuildJobScheduler?.getPendingJobCount() ?? 0; }

function getTopologyIndexBuildJobScheduler(): ReturnType<
  typeof createViewport3DBuildScheduler
> {
  if (!topologyIndexBuildJobScheduler) {
    topologyIndexBuildJobScheduler = createViewport3DBuildScheduler({
      laneConcurrency: {
        "topology-index": 1,
      },
      onDiagnosticRecord: recordViewport3DBuildDiagnostic,
    });
  }
  return topologyIndexBuildJobScheduler;
}

function getTopologyIndexWorkerClient(): TopologyIndexWorkerClient | null {
  if (topologyIndexWorkerClient !== undefined) {
    return topologyIndexWorkerClient;
  }

  if (typeof Worker === "undefined") {
    topologyIndexWorkerFallbackReason = "worker-unavailable";
    topologyIndexWorkerClient = null;
    return topologyIndexWorkerClient;
  }

  try {
    topologyIndexWorkerClient = new TopologyIndexWorkerClient();
    topologyIndexWorkerFallbackReason = null;
  } catch {
    topologyIndexWorkerFallbackReason = "worker-construction-failed";
    topologyIndexWorkerClient = null;
  }
  return topologyIndexWorkerClient;
}

function estimateTopologyIndexBuildInputBytes(
  request: Viewport3DTopologyIndexBuildRequest,
): number {
  return request.topology.boundaryFaces.byteLength +
    request.topology.indices.byteLength +
    (request.topology.cellNodes?.byteLength ?? 0) +
    (request.topology.cellGlobalOrdinals?.byteLength ?? 0) +
    (request.topology.cellOffsets?.byteLength ?? 0) +
    (request.topology.cellTypes?.byteLength ?? 0) +
    (request.topology.facetNodes?.byteLength ?? 0) +
    (request.topology.facetOffsets?.byteLength ?? 0) +
    (request.topology.facetTypes?.byteLength ?? 0);
}

export function estimateTopologyIndexBuildOutputBytes(
  request: Viewport3DTopologyIndexBuildRequest,
): number {
  const cellMetrics = estimateTopologyCellDerivedCounts(request.topology);
  let outputBytes = 0;
  outputBytes = saturatingByteAdd(
    outputBytes,
    cellMetrics.surfaceTriangleCount * 3 * Uint32Array.BYTES_PER_ELEMENT,
    cellMetrics.surfaceFaceNodeCount * 2 * Uint32Array.BYTES_PER_ELEMENT,
    Math.min(
      request.topology.nodeCount,
      cellMetrics.surfaceTriangleCount * 3,
    ) * Uint32Array.BYTES_PER_ELEMENT,
    cellMetrics.volumeEdgeCount * 2 * Uint32Array.BYTES_PER_ELEMENT,
  );
  for (const part of request.magneticParts) {
    outputBytes = saturatingByteAdd(
      outputBytes,
      estimatePreparedPartOutputBytes(
        part,
        request.magneticSurfacePartsByPartId?.get(part.id) ?? [],
        request.topology,
        cellMetrics.volumeEdgeCount,
      ),
    );
  }
  for (const part of request.airboxParts) {
    outputBytes = saturatingByteAdd(
      outputBytes,
      estimatePreparedPartOutputBytes(
        part,
        [],
        request.topology,
        cellMetrics.volumeEdgeCount,
      ),
    );
  }
  return outputBytes;
}

function estimatePreparedPartOutputBytes(
  part: Viewport3DTopologyIndexPartInput,
  supplemental: readonly Viewport3DTopologyIndexPartInput[],
  topology: Viewport3DTopologyIndexBuildRequest["topology"],
  topologyVolumeEdgeCount: number,
): number {
  let surfaceTriangleCount = estimatePartSurfaceTriangleCount(part, topology);
  let surfaceFaceNodeCount = estimatePartSurfaceFaceNodeCount(part, topology);
  for (const surfacePart of supplemental) {
    surfaceTriangleCount += estimatePartSurfaceTriangleCount(
      surfacePart,
      topology,
    );
    surfaceFaceNodeCount += estimatePartSurfaceFaceNodeCount(
      surfacePart,
      topology,
    );
  }
  const surfaceNodeCount = part.surface_node_indices
    ? part.surface_node_indices.length
    : Math.min(topology.nodeCount, surfaceTriangleCount * 3);
  return saturatingByteAdd(
    surfaceTriangleCount * 3 * Uint32Array.BYTES_PER_ELEMENT,
    surfaceTriangleCount * Uint32Array.BYTES_PER_ELEMENT,
    surfaceTriangleCount * Uint32Array.BYTES_PER_ELEMENT,
    surfaceTriangleCount * BigUint64Array.BYTES_PER_ELEMENT,
    surfaceFaceNodeCount * 2 * Uint32Array.BYTES_PER_ELEMENT,
    surfaceNodeCount * Uint32Array.BYTES_PER_ELEMENT,
    topologyVolumeEdgeCount * 2 * Uint32Array.BYTES_PER_ELEMENT,
  );
}

function estimateTopologyCellDerivedCounts(
  topology: Viewport3DTopologyIndexBuildRequest["topology"],
): {
  surfaceFaceNodeCount: number;
  surfaceTriangleCount: number;
  volumeEdgeCount: number;
} {
  let surfaceFaceNodeCount = 0;
  let surfaceTriangleCount = 0;
  let volumeEdgeCount = 0;
  const cellTypes = topology.cellTypes;
  if (cellTypes) {
    for (const type of cellTypes) {
      switch (type) {
        case 1:
          surfaceFaceNodeCount += 12;
          surfaceTriangleCount += 4;
          volumeEdgeCount += 6;
          break;
        case 2:
          surfaceFaceNodeCount += 18;
          surfaceTriangleCount += 8;
          volumeEdgeCount += 9;
          break;
        case 3:
          surfaceFaceNodeCount += 16;
          surfaceTriangleCount += 6;
          volumeEdgeCount += 8;
          break;
        case 4:
          surfaceFaceNodeCount += 24;
          surfaceTriangleCount += 12;
          volumeEdgeCount += 12;
          break;
      }
    }
    return { surfaceFaceNodeCount, surfaceTriangleCount, volumeEdgeCount };
  }
  const tetraCount = Math.floor(topology.indices.length / 4);
  return {
    surfaceFaceNodeCount: tetraCount * 12,
    surfaceTriangleCount: tetraCount * 4,
    volumeEdgeCount: tetraCount * 6,
  };
}

function estimatePartSurfaceTriangleCount(
  part: Viewport3DTopologyIndexPartInput,
  topology: Viewport3DTopologyIndexBuildRequest["topology"],
): number {
  if (part.surface_faces?.length) {
    return part.surface_faces.reduce(
      (total, face) => total + Math.max(0, face.length - 2),
      0,
    );
  }
  let triangleCount = 0;
  forEachEstimatedPartFaceIndex(part, (faceIndex) => {
    if (
      topology.facetOffsets &&
      topology.facetTypes &&
      topology.facetOffsets.length === topology.facetTypes.length + 1 &&
      faceIndex >= 0 &&
      faceIndex < topology.facetTypes.length
    ) {
      const start = topology.facetOffsets[faceIndex] ?? 0;
      const end = topology.facetOffsets[faceIndex + 1] ?? start;
      triangleCount += Math.max(0, end - start - 2);
      return;
    }
    if (faceIndex >= 0 && faceIndex * 3 + 2 < topology.boundaryFaces.length) {
      triangleCount += 1;
    }
  });
  return triangleCount;
}

function estimatePartSurfaceFaceNodeCount(
  part: Viewport3DTopologyIndexPartInput,
  topology: Viewport3DTopologyIndexBuildRequest["topology"],
): number {
  if (part.surface_faces?.length) {
    return part.surface_faces.reduce(
      (total, face) => total + Math.max(0, face.length),
      0,
    );
  }
  let nodeCount = 0;
  forEachEstimatedPartFaceIndex(part, (faceIndex) => {
    if (
      topology.facetOffsets &&
      topology.facetTypes &&
      topology.facetOffsets.length === topology.facetTypes.length + 1 &&
      faceIndex >= 0 &&
      faceIndex < topology.facetTypes.length
    ) {
      const start = topology.facetOffsets[faceIndex] ?? 0;
      const end = topology.facetOffsets[faceIndex + 1] ?? start;
      nodeCount += Math.max(0, end - start);
      return;
    }
    if (faceIndex >= 0 && faceIndex * 3 + 2 < topology.boundaryFaces.length) {
      nodeCount += 3;
    }
  });
  return nodeCount;
}

function forEachEstimatedPartFaceIndex(
  part: Viewport3DTopologyIndexPartInput,
  visit: (faceIndex: number) => void,
): void {
  if (part.boundary_face_indices?.length) {
    for (const faceIndex of part.boundary_face_indices) visit(faceIndex);
    return;
  }
  const count = Math.max(0, Math.floor(part.boundary_face_count));
  const start = Math.max(0, Math.floor(part.boundary_face_start));
  for (let index = 0; index < count; index += 1) visit(start + index);
}

function saturatingByteAdd(...values: number[]): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isFinite(value) || value < 0) return Number.MAX_SAFE_INTEGER;
    total += value;
    if (!Number.isSafeInteger(total)) return Number.MAX_SAFE_INTEGER;
  }
  return total;
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
    const cellNodes = cloneOptionalArray(input.topology.cellNodes);
    const cellGlobalOrdinals = cloneOptionalBigUint64Array(
      input.topology.cellGlobalOrdinals,
    );
    const cellOffsets = cloneOptionalArray(input.topology.cellOffsets);
    const cellTypes = cloneOptionalArray(input.topology.cellTypes);
    const facetNodes = cloneOptionalArray(input.topology.facetNodes);
    const facetOffsets = cloneOptionalArray(input.topology.facetOffsets);
    const facetTypes = cloneOptionalArray(input.topology.facetTypes);
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
        cellGlobalOrdinals,
        cellNodes,
        cellOffsets,
        cellTypes,
        facetNodes,
        facetOffsets,
        facetTypes,
        indices,
        nodeCount: input.topology.nodeCount,
      },
    };
    const transferables: Transferable[] = [];
    addArrayBufferTransferable(transferables, boundaryFaces.buffer);
    addArrayBufferTransferable(transferables, indices.buffer);
    addArrayBufferTransferable(transferables, cellNodes?.buffer);
    addArrayBufferTransferable(transferables, cellGlobalOrdinals?.buffer);
    addArrayBufferTransferable(transferables, cellOffsets?.buffer);
    addArrayBufferTransferable(transferables, cellTypes?.buffer);
    addArrayBufferTransferable(transferables, facetNodes?.buffer);
    addArrayBufferTransferable(transferables, facetOffsets?.buffer);
    addArrayBufferTransferable(transferables, facetTypes?.buffer);

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

  getRuntimeCounts(): { timers: number; workers: number } {
    return { timers: this.idleTimeoutId === null ? 0 : 1, workers: this.disposed ? 0 : 1 };
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

function cloneOptionalArray(
  source: Uint32Array | undefined,
): Uint32Array | undefined {
  return source ? new Uint32Array(source) : undefined;
}

function cloneOptionalBigUint64Array(
  source: BigUint64Array | undefined,
): BigUint64Array | undefined {
  return source ? new BigUint64Array(source) : undefined;
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
