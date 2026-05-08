import * as THREE from "three";
import type { FemMeshData, FemColorField } from "../fem/femMeshTypes";
import { computeVertexColors } from "./femVertexColorsCore";

export { computeVertexColors } from "./femVertexColorsCore";

const BASE_VERTEX_COLOR_CACHE = new WeakMap<object, Map<string, Float32Array>>();
const FIELD_DATA_ID_CACHE = new WeakMap<object, number>();
const QUALITY_PER_FACE_ID_CACHE = new WeakMap<object, number>();
let NEXT_FIELD_DATA_CACHE_ID = 1;
let NEXT_QUALITY_PER_FACE_CACHE_ID = 1;
const VERTEX_COLOR_WORKER_NODE_THRESHOLD = 100_000;
export const FEM_VERTEX_COLOR_CACHE_MAX_ENTRIES = 3;
export const FEM_VERTEX_COLOR_CACHE_MAX_BYTES = 96 * 1024 * 1024;
let femVertexColorWorker: Worker | null = null;
let femVertexColorWorkerDisabled = false;
let nextVertexColorWorkerRequestId = 1;
const vertexColorWorkerRequests = new Map<
  number,
  {
    resolve: (colors: Float32Array | null) => void;
  }
>();

interface VertexColorWorkerRequest {
  id: number;
  type: "compute";
  payload: {
    nNodes: number;
    field: FemColorField;
    fieldData: FemMeshData["fieldData"] | undefined;
    fieldNComp: number;
    nodes: ArrayLike<number>;
    boundaryFaces: ArrayLike<number>;
    qualityPerFace?: number[] | null;
  };
}

type VertexColorWorkerResponse =
  | { id: number; ok: true; colors: Float32Array }
  | { id: number; ok: false; error: string };

function resolveVertexColorWorkerRequest(id: number, colors: Float32Array | null): void {
  const request = vertexColorWorkerRequests.get(id);
  if (!request) return;
  vertexColorWorkerRequests.delete(id);
  request.resolve(colors);
}

function disableVertexColorWorker(): void {
  femVertexColorWorkerDisabled = true;
  femVertexColorWorker?.terminate();
  femVertexColorWorker = null;
  for (const id of vertexColorWorkerRequests.keys()) {
    resolveVertexColorWorkerRequest(id, null);
  }
}

function getFemVertexColorWorker(): Worker | null {
  if (femVertexColorWorkerDisabled || typeof window === "undefined" || typeof Worker === "undefined") {
    return null;
  }
  if (!femVertexColorWorker) {
    try {
      femVertexColorWorker = new Worker(new URL("./femVertexColors.worker.ts", import.meta.url), {
        type: "module",
        name: "fem-vertex-colors",
      });
      femVertexColorWorker.onmessage = (event: MessageEvent<VertexColorWorkerResponse>) => {
        const message = event.data;
        if (message.ok) {
          resolveVertexColorWorkerRequest(message.id, message.colors);
        } else {
          resolveVertexColorWorkerRequest(message.id, null);
        }
      };
      femVertexColorWorker.onerror = () => {
        disableVertexColorWorker();
      };
    } catch {
      disableVertexColorWorker();
    }
  }
  return femVertexColorWorker;
}

export function shouldUseVertexColorWorker(args: {
  enabled: boolean;
  nNodes: number;
  field: FemColorField;
  hasUniformColor: boolean;
}): boolean {
  return (
    args.enabled &&
    args.nNodes >= VERTEX_COLOR_WORKER_NODE_THRESHOLD &&
    !(args.field === "none" && args.hasUniformColor)
  );
}

export function computeVertexColorsOffThread(args: VertexColorWorkerRequest["payload"]): Promise<Float32Array | null> {
  const worker = getFemVertexColorWorker();
  if (!worker) return Promise.resolve(null);
  const id = nextVertexColorWorkerRequestId++;
  return new Promise((resolve) => {
    vertexColorWorkerRequests.set(id, { resolve });
    try {
      worker.postMessage({
        id,
        type: "compute",
        payload: args,
      } satisfies VertexColorWorkerRequest);
    } catch {
      resolveVertexColorWorkerRequest(id, null);
    }
  });
}

function fieldDataCacheId(fieldData: FemMeshData["fieldData"] | undefined): string {
  if (!fieldData || typeof fieldData !== "object") {
    return "none";
  }
  const key = fieldData;
  let id = FIELD_DATA_ID_CACHE.get(key);
  if (!id) {
    id = NEXT_FIELD_DATA_CACHE_ID++;
    FIELD_DATA_ID_CACHE.set(key, id);
  }
  return String(id);
}

function qualityPerFaceCacheId(qualityPerFace: number[] | null | undefined): string {
  if (!qualityPerFace || typeof qualityPerFace !== "object") {
    return "none";
  }
  let id = QUALITY_PER_FACE_ID_CACHE.get(qualityPerFace);
  if (!id) {
    id = NEXT_QUALITY_PER_FACE_CACHE_ID++;
    QUALITY_PER_FACE_ID_CACHE.set(qualityPerFace, id);
  }
  return String(id);
}

function getBaseVertexColorCache(meshData: FemMeshData): Map<string, Float32Array> {
  // Use the stable topology reference when available so the cache survives
  // field-data updates that create new FemMeshData wrapper objects.
  const cacheKey = (meshData.topologyRef as FemMeshData | undefined) ?? meshData;
  let cache = BASE_VERTEX_COLOR_CACHE.get(cacheKey);
  if (!cache) {
    cache = new Map<string, Float32Array>();
    BASE_VERTEX_COLOR_CACHE.set(cacheKey, cache);
  }
  return cache;
}

function estimateVertexColorCacheBytes(cache: Map<string, Float32Array>): number {
  let bytes = 0;
  for (const [key, colors] of cache) {
    bytes += key.length * 2 + colors.byteLength;
  }
  return bytes;
}

export function getSharedVertexColorCacheStats(meshData: FemMeshData): {
  entries: number;
  estimatedBytes: number;
} {
  const cache = getBaseVertexColorCache(meshData);
  return {
    entries: cache.size,
    estimatedBytes: estimateVertexColorCacheBytes(cache),
  };
}

function rememberSharedVertexColors(
  cache: Map<string, Float32Array>,
  key: string,
  colors: Float32Array,
): void {
  cache.delete(key);
  cache.set(key, colors);
  let estimatedBytes = estimateVertexColorCacheBytes(cache);
  while (
    cache.size > 0 &&
    (cache.size > FEM_VERTEX_COLOR_CACHE_MAX_ENTRIES ||
      estimatedBytes > FEM_VERTEX_COLOR_CACHE_MAX_BYTES)
  ) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    const evicted = cache.get(oldestKey);
    cache.delete(oldestKey);
    estimatedBytes -= oldestKey.length * 2 + (evicted?.byteLength ?? 0);
  }
}

export function getSharedVertexColors(args: {
  meshData: FemMeshData;
  field: FemColorField;
  fieldData?: FemMeshData["fieldData"];
  uniformColor?: string;
  qualityPerFace?: number[] | null;
}): Float32Array {
  const { meshData, field, fieldData = meshData.fieldData, uniformColor, qualityPerFace } = args;
  const baseVertexColorCache = getBaseVertexColorCache(meshData);
  const nNodes = meshData.nNodes;
  const fieldDataId = fieldDataCacheId(fieldData);
  const fieldRevision = meshData.fieldRevision ?? "none";
  const qualityRevision = qualityPerFaceCacheId(qualityPerFace);
  const cacheKey =
    field === "none"
      ? (uniformColor ? `none:uniform:${uniformColor}` : "none:default")
      : `field:${field}:ncomp:${meshData.fieldNComp ?? 3}:rev:${fieldRevision}:data:${fieldDataId}:quality:${qualityRevision}`;
  const cached = baseVertexColorCache.get(cacheKey);
  if (cached && cached.length === nNodes * 3) {
    baseVertexColorCache.delete(cacheKey);
    baseVertexColorCache.set(cacheKey, cached);
    return cached;
  }
  const computed =
    field === "none" && uniformColor
      ? (() => {
          const tint = new THREE.Color(uniformColor);
          const colors = new Float32Array(nNodes * 3);
          for (let index = 0; index < nNodes; index += 1) {
            colors[index * 3] = tint.r;
            colors[index * 3 + 1] = tint.g;
            colors[index * 3 + 2] = tint.b;
          }
          return colors;
        })()
      : computeVertexColors(
          meshData.nNodes,
          field,
          fieldData,
          meshData.fieldNComp ?? 3,
          meshData.nodes,
          meshData.boundaryFaces,
          qualityPerFace,
        );
  rememberSharedVertexColors(baseVertexColorCache, cacheKey, computed);
  return computed;
}
