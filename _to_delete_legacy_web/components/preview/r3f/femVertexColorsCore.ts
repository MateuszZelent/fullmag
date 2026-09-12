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

interface FieldValueScales {
  x: number;
  y: number;
  z: number;
  magnitude: number;
}

const FIELD_VALUE_SCALE_CACHE = new WeakMap<object, Map<string, FieldValueScales>>();

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
