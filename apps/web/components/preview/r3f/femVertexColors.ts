import * as THREE from "three";
import type { FemMeshData, FemColorField } from "../FemMeshView3D";
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
let NEXT_FIELD_DATA_CACHE_ID = 1;

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
  let scaleX = 1;
  let scaleY = 1;
  let scaleZ = 1;
  let scaleMagnitude = 1;
  if (fieldValues) {
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
    scaleX = maxAbsX > 1e-12 ? maxAbsX : 1;
    scaleY = maxAbsY > 1e-12 ? maxAbsY : 1;
    scaleZ = maxAbsZ > 1e-12 ? maxAbsZ : 1;
    scaleMagnitude = maxMag > 1e-12 ? maxMag : 1;
  }

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
            magnitudeColor(Math.abs(fx) / scaleX, color);
          }
          break;
        case "x":
          divergingColor(fx / scaleX, color);
          break;
        case "y":
          divergingColor(fy / scaleY, color);
          break;
        case "z":
          divergingColor(fz / scaleZ, color);
          break;
        case "magnitude":
          magnitudeColor(Math.sqrt(fx * fx + fy * fy + fz * fz) / scaleMagnitude, color);
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
  const cacheKey = meshData;
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
  const cacheableField = field !== "quality" && field !== "sicn";

  if (cacheableField) {
    const fieldDataId = fieldDataCacheId(fieldData);
    const fieldRevision = meshData.fieldRevision ?? "none";
    const cacheKey =
      field === "none"
        ? (uniformColor ? `none:uniform:${uniformColor}` : "none:default")
        : `field:${field}:ncomp:${meshData.fieldNComp ?? 3}:rev:${fieldRevision}:data:${fieldDataId}`;
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

  return computeVertexColors(
    meshData.nNodes,
    field,
    fieldData,
    meshData.fieldNComp ?? 3,
    meshData.nodes,
    meshData.boundaryFaces,
    qualityPerFace,
  );
}
