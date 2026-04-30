import * as THREE from "three";
import type { FemMeshData, FemColorField } from "../fem/femMeshTypes";
import {
  computeFaceAspectRatios,
  qualityColor,
  sicnQualityColor,
  divergingColor,
  magnitudeColor,
} from "./colorUtils";
import { applyMagnetizationHsl } from "../magnetizationColor";

const BASE_VERTEX_COLOR_CACHE = new WeakMap<object, Map<string, Float32Array>>();
const FIELD_DATA_ID_CACHE = new WeakMap<object, number>();
const QUALITY_PER_FACE_ID_CACHE = new WeakMap<object, number>();
const FIELD_VALUE_SCALE_CACHE = new WeakMap<object, Map<string, FieldValueScales>>();
let NEXT_FIELD_DATA_CACHE_ID = 1;
let NEXT_QUALITY_PER_FACE_CACHE_ID = 1;
const VERTEX_COLOR_WORKER_NODE_THRESHOLD = 100_000;
let femVertexColorWorker: Worker | null = null;
let femVertexColorWorkerDisabled = false;
let nextVertexColorWorkerRequestId = 1;
const vertexColorWorkerRequests = new Map<
  number,
  {
    resolve: (colors: Float32Array | null) => void;
  }
>();

interface FieldValueScales {
  x: number;
  y: number;
  z: number;
  magnitude: number;
}

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

function resolveFieldValueScales(
  fieldValues: FemMeshData["fieldData"],
  nNodes: number,
  fieldNComp: number,
): FieldValueScales {
  if (!fieldValues || typeof fieldValues !== "object") {
    return { x: 1, y: 1, z: 1, magnitude: 1 };
  }
  const cacheKey = `nodes:${nNodes}:ncomp:${fieldNComp}`;
  let cache = FIELD_VALUE_SCALE_CACHE.get(fieldValues);
  if (!cache) {
    cache = new Map<string, FieldValueScales>();
    FIELD_VALUE_SCALE_CACHE.set(fieldValues, cache);
  }
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  let maxAbsX = 0;
  let maxAbsY = 0;
  let maxAbsZ = 0;
  let maxMag = 0;
  for (let nodeIndex = 0; nodeIndex < nNodes; nodeIndex += 1) {
    const fx = fieldValues.x[nodeIndex] ?? 0;
    const fy = fieldNComp >= 3 ? fieldValues.y[nodeIndex] ?? 0 : 0;
    const fz = fieldNComp >= 3 ? fieldValues.z[nodeIndex] ?? 0 : 0;
    maxAbsX = Math.max(maxAbsX, Math.abs(fx));
    maxAbsY = Math.max(maxAbsY, Math.abs(fy));
    maxAbsZ = Math.max(maxAbsZ, Math.abs(fz));
    maxMag = Math.max(maxMag, Math.sqrt(fx * fx + fy * fy + fz * fz));
  }
  const next = {
    x: maxAbsX > 1e-12 ? maxAbsX : 1,
    y: maxAbsY > 1e-12 ? maxAbsY : 1,
    z: maxAbsZ > 1e-12 ? maxAbsZ : 1,
    magnitude: maxMag > 1e-12 ? maxMag : 1,
  };
  cache.set(cacheKey, next);
  return next;
}

export function computeVertexColors(
  nNodes: number,
  field: FemColorField,
  fieldData: FemMeshData["fieldData"] | undefined,
  fieldNComp: number,
  nodes: ArrayLike<number>,
  boundaryFaces: ArrayLike<number>,
  qualityPerFace?: number[] | null,
): Float32Array {
  const colors = new Float32Array(nNodes * 3);
  const color = new THREE.Color();
  const nFaces = boundaryFaces.length / 3;

  if (field === "quality") {
    const faceARs = computeFaceAspectRatios(nodes, boundaryFaces);
    const vertexAR = new Float32Array(nNodes);
    const vertexCount = new Uint16Array(nNodes);
    for (let faceIndex = 0; faceIndex < nFaces; faceIndex += 1) {
      const ar = faceARs[faceIndex];
      for (let vertexIndex = 0; vertexIndex < 3; vertexIndex += 1) {
        const nodeIndex = boundaryFaces[faceIndex * 3 + vertexIndex];
        vertexAR[nodeIndex] += ar;
        vertexCount[nodeIndex] += 1;
      }
    }
    for (let nodeIndex = 0; nodeIndex < nNodes; nodeIndex += 1) {
      const avg = vertexCount[nodeIndex] > 0 ? vertexAR[nodeIndex] / vertexCount[nodeIndex] : 1;
      qualityColor(avg, color);
      colors[nodeIndex * 3] = color.r;
      colors[nodeIndex * 3 + 1] = color.g;
      colors[nodeIndex * 3 + 2] = color.b;
    }
    return colors;
  }

  if (field === "sicn" && qualityPerFace && qualityPerFace.length === nFaces) {
    const vertexSicn = new Float32Array(nNodes);
    const vertexCount = new Uint16Array(nNodes);
    for (let faceIndex = 0; faceIndex < nFaces; faceIndex += 1) {
      const value = qualityPerFace[faceIndex];
      for (let vertexIndex = 0; vertexIndex < 3; vertexIndex += 1) {
        const nodeIndex = boundaryFaces[faceIndex * 3 + vertexIndex];
        vertexSicn[nodeIndex] += value;
        vertexCount[nodeIndex] += 1;
      }
    }
    for (let nodeIndex = 0; nodeIndex < nNodes; nodeIndex += 1) {
      const avg = vertexCount[nodeIndex] > 0 ? vertexSicn[nodeIndex] / vertexCount[nodeIndex] : 0;
      sicnQualityColor(avg, color);
      colors[nodeIndex * 3] = color.r;
      colors[nodeIndex * 3 + 1] = color.g;
      colors[nodeIndex * 3 + 2] = color.b;
    }
    return colors;
  }

  if (field === "sicn") {
    const faceARs = computeFaceAspectRatios(nodes, boundaryFaces);
    const vertexAR = new Float32Array(nNodes);
    const vertexCount = new Uint16Array(nNodes);
    for (let faceIndex = 0; faceIndex < nFaces; faceIndex += 1) {
      for (let vertexIndex = 0; vertexIndex < 3; vertexIndex += 1) {
        const nodeIndex = boundaryFaces[faceIndex * 3 + vertexIndex];
        vertexAR[nodeIndex] += faceARs[faceIndex];
        vertexCount[nodeIndex] += 1;
      }
    }
    for (let nodeIndex = 0; nodeIndex < nNodes; nodeIndex += 1) {
      const avg = vertexCount[nodeIndex] > 0 ? vertexAR[nodeIndex] / vertexCount[nodeIndex] : 1;
      qualityColor(avg, color);
      colors[nodeIndex * 3] = color.r;
      colors[nodeIndex * 3 + 1] = color.g;
      colors[nodeIndex * 3 + 2] = color.b;
    }
    return colors;
  }

  const fieldValues = fieldData;
  const scales = resolveFieldValueScales(fieldValues, nNodes, fieldNComp);

  for (let nodeIndex = 0; nodeIndex < nNodes; nodeIndex += 1) {
    if (!fieldValues || field === "none") {
      color.setHSL(0, 0, 0.6);
    } else {
      const fx = fieldValues.x[nodeIndex] ?? 0;
      const fy = fieldNComp >= 3 ? fieldValues.y[nodeIndex] ?? 0 : 0;
      const fz = fieldNComp >= 3 ? fieldValues.z[nodeIndex] ?? 0 : 0;
      switch (field) {
        case "orientation":
          if (fieldNComp >= 3) {
            applyMagnetizationHsl(fx, fy, fz, color);
          } else {
            magnitudeColor(Math.abs(fx) / scales.x, color);
          }
          break;
        case "x":
          divergingColor(fx / scales.x, color);
          break;
        case "y":
          divergingColor(fy / scales.y, color);
          break;
        case "z":
          divergingColor(fz / scales.z, color);
          break;
        case "magnitude":
          magnitudeColor(Math.sqrt(fx * fx + fy * fy + fz * fz) / scales.magnitude, color);
          break;
      }
    }
    colors[nodeIndex * 3] = color.r;
    colors[nodeIndex * 3 + 1] = color.g;
    colors[nodeIndex * 3 + 2] = color.b;
  }
  return colors;
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
  baseVertexColorCache.set(cacheKey, computed);
  return computed;
}
