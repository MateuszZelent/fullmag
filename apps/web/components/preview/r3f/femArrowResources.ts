import { useLayoutEffect, useMemo, useRef } from "react";
import type { RefObject } from "react";
import * as THREE from "three";
import type {
  ArrowSamplingMode,
  FemArrowColorMode,
  FemColorField,
  FemMeshData,
} from "../fem/femMeshTypes";
import { isNodeActive } from "../fem/femNodeMask";
import { divergingColor, magnitudeColor } from "./colorUtils";
import { applyMagnetizationHsl } from "../magnetizationColor";
import { applyLiveBufferTransition } from "./liveBufferAnimation";

export type ArrowLengthMode = "constant" | "magnitude" | "sqrt" | "log";

export const MAX_ARROW_CAPACITY = 1 << 20; // 1 048 576 arrows hard cap
export const ARROW_ANIMATION_BYTE_BUDGET = 64 * 1024 * 1024; // 64 MB for matrix animation

/**
 * Grows capacity to the next power-of-two >= count, capped at maxCapacity.
 * Shrinks only when count falls below 25% of the current bucket (hysteresis).
 */
export function resolveFemArrowStableCapacity(
  count: number,
  currentCapacity: number,
  maxCapacity = MAX_ARROW_CAPACITY,
): number {
  const desired = Math.max(1, Math.min(Math.ceil(count), maxCapacity));
  const current = Math.max(1, Math.ceil(currentCapacity));
  if (desired <= current && desired >= Math.ceil(current * 0.25)) {
    return current;
  }
  let capacity = 1;
  while (capacity < desired) {
    capacity *= 2;
  }
  return Math.min(capacity, maxCapacity);
}

export function useStableFemArrowCapacity(count: number): number {
  const capacityRef = useRef(1);
  const nextCapacity = resolveFemArrowStableCapacity(count, capacityRef.current);
  capacityRef.current = nextCapacity;
  return nextCapacity;
}

export function sampleFemArrowCandidateNodes(
  nodes: ArrayLike<number>,
  candidateNodes: readonly number[],
  targetDensity: number,
): number[] {
  if (candidateNodes.length === 0 || targetDensity <= 0) return [];
  const allBoundaryNodes = candidateNodes as number[];

  if (allBoundaryNodes.length <= targetDensity) return allBoundaryNodes;

  let bMinX = Infinity, bMinY = Infinity, bMinZ = Infinity;
  let bMaxX = -Infinity, bMaxY = -Infinity, bMaxZ = -Infinity;
  for (const ni of allBoundaryNodes) {
    const x = nodes[ni * 3], y = nodes[ni * 3 + 1], z = nodes[ni * 3 + 2];
    bMinX = Math.min(bMinX, x); bMaxX = Math.max(bMaxX, x);
    bMinY = Math.min(bMinY, y); bMaxY = Math.max(bMaxY, y);
    bMinZ = Math.min(bMinZ, z); bMaxZ = Math.max(bMaxZ, z);
  }

  const volume = Math.max(1e-30, (bMaxX - bMinX) * (bMaxY - bMinY) * (bMaxZ - bMinZ));
  const nCandidateCells = targetDensity * 4;
  const cellSize = Math.pow(volume / nCandidateCells, 1 / 3);
  const invCell = 1 / Math.max(cellSize, 1e-30);
  const nBinsX = Math.max(1, Math.ceil((bMaxX - bMinX) * invCell));
  const nBinsY = Math.max(1, Math.ceil((bMaxY - bMinY) * invCell));

  const cellMap = new Map<number, {
    cx: number;
    cy: number;
    cz: number;
    bestDistSq: number;
    bestNi: number;
  }>();

  for (const ni of allBoundaryNodes) {
    const x = nodes[ni * 3], y = nodes[ni * 3 + 1], z = nodes[ni * 3 + 2];
    const ix = Math.min(nBinsX - 1, Math.floor((x - bMinX) * invCell));
    const iy = Math.min(nBinsY - 1, Math.floor((y - bMinY) * invCell));
    const iz = Math.floor((z - bMinZ) * invCell);
    const key = ix + iy * nBinsX + iz * nBinsX * nBinsY;

    let cell = cellMap.get(key);
    if (!cell) {
      cell = {
        cx: bMinX + (ix + 0.5) * cellSize,
        cy: bMinY + (iy + 0.5) * cellSize,
        cz: bMinZ + (iz + 0.5) * cellSize,
        bestDistSq: Infinity,
        bestNi: -1,
      };
      cellMap.set(key, cell);
    }

    const dx = x - cell.cx, dy = y - cell.cy, dz = z - cell.cz;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq < cell.bestDistSq) {
      cell.bestDistSq = distSq;
      cell.bestNi = ni;
    }
  }

  interface Candidate { ni: number; hash: number; }
  const candidates: Candidate[] = [];
  const hashFn = (key: number) => {
    const xVal = Math.sin(key * 12.9898) * 43758.5453;
    return xVal - Math.floor(xVal);
  };

  for (const [key, cell] of cellMap.entries()) {
    candidates.push({ ni: cell.bestNi, hash: hashFn(key) });
  }

  if (candidates.length <= targetDensity) return candidates.map((candidate) => candidate.ni);

  candidates.sort((left, right) => left.hash - right.hash);
  const result: number[] = new Array(Math.min(targetDensity, candidates.length));
  const step = candidates.length / result.length;
  for (let i = 0; i < result.length; i += 1) {
    result[i] = candidates[Math.floor(i * step)].ni;
  }

  if (result.length > 1) {
    const unique: number[] = [];
    const seen = new Set<number>();
    for (const nodeIndex of result) {
      if (!seen.has(nodeIndex)) {
        seen.add(nodeIndex);
        unique.push(nodeIndex);
      }
    }
    if (unique.length === result.length) return result;
    for (const candidate of candidates) {
      if (unique.length >= targetDensity) break;
      if (seen.has(candidate.ni)) continue;
      seen.add(candidate.ni);
      unique.push(candidate.ni);
    }
    return unique;
  }

  return result;
}

export interface FemArrowSamplingState {
  effectiveNodeMask: Uint8Array | boolean[] | null;
  boundaryCandidateNodes: number[];
  filteredCandidateNodes: number[];
  sampledNodes: number[];
  useVolumeCandidates: boolean;
}

export interface FemArrowGeometryPayload {
  count: number;
  positions: Float32Array;
  quaternions: Float32Array;
  scales: Float32Array;
}

export interface FemArrowInstancePayload extends FemArrowGeometryPayload {
  colors: Float32Array;
}

const EMPTY_ARROW_GEOMETRY_PAYLOAD: FemArrowGeometryPayload = {
  count: 0,
  positions: new Float32Array(0),
  quaternions: new Float32Array(0),
  scales: new Float32Array(0),
};

const EMPTY_ARROW_INSTANCE_PAYLOAD: FemArrowInstancePayload = {
  count: 0,
  positions: new Float32Array(0),
  quaternions: new Float32Array(0),
  scales: new Float32Array(0),
  colors: new Float32Array(0),
};

// ---------------------------------------------------------------------------
// Geometry-only payload (positions / quaternions / scales)
// Does NOT depend on colorMode / monoColor / field — so style changes don't
// recompute node positions or orientation quaternions.
// ---------------------------------------------------------------------------
export function buildFemArrowGeometryPayload({
  arrowTemplateScale,
  center,
  lengthMode,
  lengthScale,
  meshData,
  sampledNodes,
  thickness,
  visible,
}: {
  arrowTemplateScale: number;
  center: THREE.Vector3;
  lengthMode: ArrowLengthMode;
  lengthScale: number;
  meshData: FemMeshData;
  sampledNodes: readonly number[];
  thickness: number;
  visible: boolean;
}): FemArrowGeometryPayload {
  if (!visible) return EMPTY_ARROW_GEOMETRY_PAYLOAD;
  const fieldData = meshData.fieldData;
  if (!fieldData) return EMPTY_ARROW_GEOMETRY_PAYLOAD;
  if (sampledNodes.length === 0) return EMPTY_ARROW_GEOMETRY_PAYLOAD;

  const resultCount = sampledNodes.length;
  let maxMag = 0;
  for (const nodeIndex of sampledNodes) {
    const vx = fieldData.x[nodeIndex] ?? 0;
    const vy = fieldData.y[nodeIndex] ?? 0;
    const vz = fieldData.z[nodeIndex] ?? 0;
    maxMag = Math.max(maxMag, Math.sqrt(vx * vx + vy * vy + vz * vz));
  }
  const scaleMag = Math.max(maxMag, 1e-12);
  const clampedLengthScale = Math.max(0.2, Math.min(4, lengthScale));
  const clampedThickness = Math.max(0.2, Math.min(4, thickness));

  const quaternions = new Float32Array(resultCount * 4);
  const scales = new Float32Array(resultCount * 3);
  const positions = new Float32Array(resultCount * 3);

  const direction = new THREE.Vector3();
  const defaultUp = new THREE.Vector3(0, 0, 1);
  const quaternion = new THREE.Quaternion();

  for (let i = 0; i < resultCount; i += 1) {
    const nodeIndex = sampledNodes[i];
    positions[i * 3] = meshData.nodes[nodeIndex * 3] - center.x;
    positions[i * 3 + 1] = meshData.nodes[nodeIndex * 3 + 1] - center.y;
    positions[i * 3 + 2] = meshData.nodes[nodeIndex * 3 + 2] - center.z;
    const vx = fieldData.x[nodeIndex] ?? 0;
    const vy = fieldData.y[nodeIndex] ?? 0;
    const vz = fieldData.z[nodeIndex] ?? 0;
    const length = Math.sqrt(vx * vx + vy * vy + vz * vz);

    if (length < 1e-12) {
      scales[i * 3] = 0;
      scales[i * 3 + 1] = 0;
      scales[i * 3 + 2] = 0;
      quaternion.identity();
    } else {
      let scalar = 1;
      if (lengthMode === "magnitude") {
        scalar = 0.2 + 0.8 * (length / scaleMag);
      } else if (lengthMode === "sqrt") {
        scalar = 0.2 + 0.8 * Math.sqrt(length / scaleMag);
      } else if (lengthMode === "log") {
        scalar = 0.2 + 0.8 * Math.log1p(length / scaleMag * 9) / Math.log(10);
      }
      scales[i * 3] = scalar * clampedThickness * arrowTemplateScale;
      scales[i * 3 + 1] = scalar * clampedThickness * arrowTemplateScale;
      scales[i * 3 + 2] = scalar * clampedLengthScale * arrowTemplateScale;
      direction.set(vx, vy, vz).normalize();
      quaternion.setFromUnitVectors(defaultUp, direction);
    }

    quaternions[i * 4] = quaternion.x;
    quaternions[i * 4 + 1] = quaternion.y;
    quaternions[i * 4 + 2] = quaternion.z;
    quaternions[i * 4 + 3] = quaternion.w;
  }

  return { count: resultCount, positions, quaternions, scales };
}

// ---------------------------------------------------------------------------
// Color-only payload
// Does NOT depend on positions, quaternions, or scales.
// ---------------------------------------------------------------------------
export function buildFemArrowColorPayload({
  colorMode,
  field,
  meshData,
  monoColor,
  sampledNodes,
  visible,
}: {
  colorMode: FemArrowColorMode;
  field: FemColorField;
  meshData: FemMeshData;
  monoColor: string;
  sampledNodes: readonly number[];
  visible: boolean;
}): Float32Array {
  if (!visible) return new Float32Array(0);
  const fieldData = meshData.fieldData;
  if (!fieldData) return new Float32Array(0);
  if (sampledNodes.length === 0) return new Float32Array(0);

  const resultCount = sampledNodes.length;
  let maxAbsX = 0, maxAbsY = 0, maxAbsZ = 0, maxMag = 0;
  for (const nodeIndex of sampledNodes) {
    const vx = fieldData.x[nodeIndex] ?? 0;
    const vy = fieldData.y[nodeIndex] ?? 0;
    const vz = fieldData.z[nodeIndex] ?? 0;
    maxAbsX = Math.max(maxAbsX, Math.abs(vx));
    maxAbsY = Math.max(maxAbsY, Math.abs(vy));
    maxAbsZ = Math.max(maxAbsZ, Math.abs(vz));
    maxMag = Math.max(maxMag, Math.sqrt(vx * vx + vy * vy + vz * vz));
  }
  const scaleX = Math.max(maxAbsX, 1e-12);
  const scaleY = Math.max(maxAbsY, 1e-12);
  const scaleZ = Math.max(maxAbsZ, 1e-12);
  const scaleMag = Math.max(maxMag, 1e-12);

  const colors = new Float32Array(resultCount * 3);
  const color = new THREE.Color();

  for (let i = 0; i < resultCount; i += 1) {
    const nodeIndex = sampledNodes[i];
    const vx = fieldData.x[nodeIndex] ?? 0;
    const vy = fieldData.y[nodeIndex] ?? 0;
    const vz = fieldData.z[nodeIndex] ?? 0;
    const length = Math.sqrt(vx * vx + vy * vy + vz * vz);

    switch (colorMode) {
      case "orientation":
        applyMagnetizationHsl(vx, vy, vz, color);
        break;
      case "x":
        divergingColor(vx / scaleX, color);
        break;
      case "y":
        divergingColor(vy / scaleY, color);
        break;
      case "z":
        divergingColor(vz / scaleZ, color);
        break;
      case "magnitude":
        magnitudeColor(length / scaleMag, color);
        break;
      case "monochrome":
        color.set(monoColor);
        break;
      default:
        switch (field) {
          case "x": divergingColor(vx / scaleX, color); break;
          case "y": divergingColor(vy / scaleY, color); break;
          case "z": divergingColor(vz / scaleZ, color); break;
          case "magnitude": magnitudeColor(length / scaleMag, color); break;
          default: applyMagnetizationHsl(vx, vy, vz, color); break;
        }
        break;
    }

    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }

  return colors;
}

/**
 * Combined payload (backward-compat). Prefer using buildFemArrowGeometryPayload +
 * buildFemArrowColorPayload separately so style changes don't recompute geometry.
 */
export function buildFemArrowInstancePayload({
  arrowTemplateScale,
  center,
  colorMode,
  field,
  lengthMode,
  lengthScale,
  meshData,
  monoColor,
  sampledNodes,
  thickness,
  visible,
}: {
  arrowTemplateScale: number;
  center: THREE.Vector3;
  colorMode: FemArrowColorMode;
  field: FemColorField;
  lengthMode: ArrowLengthMode;
  lengthScale: number;
  meshData: FemMeshData;
  monoColor: string;
  sampledNodes: readonly number[];
  thickness: number;
  visible: boolean;
}): FemArrowInstancePayload {
  const geo = buildFemArrowGeometryPayload({
    arrowTemplateScale,
    center,
    lengthMode,
    lengthScale,
    meshData,
    sampledNodes,
    thickness,
    visible,
  });
  if (geo.count === 0) return EMPTY_ARROW_INSTANCE_PAYLOAD;
  const colors = buildFemArrowColorPayload({ colorMode, field, meshData, monoColor, sampledNodes, visible });
  return { ...geo, colors };
}

export function useFemArrowSamplingResource({
  activeNodeMask,
  arrowDensity,
  boundaryFaceIndices,
  meshData,
  samplingMode,
  visible,
}: {
  activeNodeMask?: Uint8Array | boolean[] | null;
  arrowDensity: number;
  boundaryFaceIndices?: number[] | null;
  meshData: FemMeshData;
  samplingMode: ArrowSamplingMode;
  visible: boolean;
}): FemArrowSamplingState {
  const effectiveNodeMask = useMemo(() => {
    if (activeNodeMask && activeNodeMask.length === meshData.nNodes) {
      return activeNodeMask;
    }
    if (
      meshData.quantityDomain === "magnetic_only" &&
      meshData.activeMask &&
      meshData.activeMask.length === meshData.nNodes
    ) {
      return meshData.activeMask;
    }
    return null;
  }, [activeNodeMask, meshData.activeMask, meshData.nNodes, meshData.quantityDomain]);

  const boundaryCandidateNodes = useMemo(() => {
    const unique = new Set<number>();
    if (boundaryFaceIndices && boundaryFaceIndices.length > 0) {
      for (const faceIndex of boundaryFaceIndices) {
        const base = faceIndex * 3;
        if (base + 2 >= meshData.boundaryFaces.length) continue;
        unique.add(meshData.boundaryFaces[base]);
        unique.add(meshData.boundaryFaces[base + 1]);
        unique.add(meshData.boundaryFaces[base + 2]);
      }
    } else {
      for (let i = 0; i < meshData.boundaryFaces.length; i += 1) {
        unique.add(meshData.boundaryFaces[i]);
      }
    }
    return Array.from(unique);
  }, [boundaryFaceIndices, meshData.boundaryFaces]);

  const volumeCandidateNodes = useMemo(() => {
    const allNodes = new Array<number>(meshData.nNodes);
    for (let nodeIndex = 0; nodeIndex < meshData.nNodes; nodeIndex += 1) {
      allNodes[nodeIndex] = nodeIndex;
    }
    return allNodes;
  }, [meshData.nNodes]);

  const useVolumeCandidates =
    samplingMode === "volume"
      ? true
      : samplingMode === "surface"
        ? false
        : (
            Boolean(effectiveNodeMask) ||
            meshData.quantityDomain === "full_domain" ||
            meshData.quantityDomain === "surface_only"
          );

  const filteredCandidateNodes = useMemo(() => {
    const source = useVolumeCandidates ? volumeCandidateNodes : boundaryCandidateNodes;
    if (!effectiveNodeMask) return source;
    return source.filter((nodeIndex) => isNodeActive(effectiveNodeMask, nodeIndex));
  }, [boundaryCandidateNodes, effectiveNodeMask, useVolumeCandidates, volumeCandidateNodes]);

  const sampledNodes = useMemo(() => {
    if (!visible) return [] as number[];
    if (!meshData.fieldData) return [] as number[];
    const primaryCandidates = effectiveNodeMask
      ? filteredCandidateNodes
      : filteredCandidateNodes.length > 0
        ? filteredCandidateNodes
        : useVolumeCandidates
          ? volumeCandidateNodes
          : boundaryCandidateNodes;
    const sampledPrimary = sampleFemArrowCandidateNodes(meshData.nodes, primaryCandidates, arrowDensity);
    if (sampledPrimary.length > 0 || !useVolumeCandidates) {
      return sampledPrimary;
    }
    const boundaryFallbackCandidates = effectiveNodeMask
      ? boundaryCandidateNodes.filter((nodeIndex) => isNodeActive(effectiveNodeMask, nodeIndex))
      : boundaryCandidateNodes;
    return sampleFemArrowCandidateNodes(meshData.nodes, boundaryFallbackCandidates, arrowDensity);
  }, [
    arrowDensity,
    boundaryCandidateNodes,
    effectiveNodeMask,
    filteredCandidateNodes,
    meshData.fieldData,
    meshData.nodes,
    useVolumeCandidates,
    visible,
    volumeCandidateNodes,
  ]);

  return {
    effectiveNodeMask,
    boundaryCandidateNodes,
    filteredCandidateNodes,
    sampledNodes,
    useVolumeCandidates,
  };
}

export function useFemArrowInstanceBufferUpload({
  colors,
  count,
  instanceColorAttribute,
  meshRef,
  positions,
  quaternions,
  renderOrder,
  scales,
  scheduleInvalidate,
  animationByteBudget = ARROW_ANIMATION_BYTE_BUDGET,
}: {
  colors: Float32Array;
  count: number;
  instanceColorAttribute: THREE.InstancedBufferAttribute;
  meshRef: RefObject<THREE.InstancedMesh | null>;
  positions: Float32Array;
  quaternions: Float32Array;
  renderOrder: number;
  scales: Float32Array;
  scheduleInvalidate: () => void;
  /** Max bytes for animated matrix transition. Uploads directly when exceeded. */
  animationByteBudget?: number;
}): void {
  const previousInstanceCountRef = useRef(0);
  const transitionCleanupRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    mesh.instanceColor = instanceColorAttribute;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.renderOrder = renderOrder;
    const meshInstanceColor = mesh.instanceColor;
    if (!meshInstanceColor) return;
    const matrixArray = mesh.instanceMatrix.array as Float32Array;
    const colorArray = meshInstanceColor.array as Float32Array;
    const nextMatrices = new Float32Array(count * 16);
    const dummy = new THREE.Object3D();
    let matrixOffset = 0;

    for (let i = 0; i < count; i += 1) {
      dummy.position.set(
        positions[i * 3],
        positions[i * 3 + 1],
        positions[i * 3 + 2],
      );
      dummy.quaternion.set(
        quaternions[i * 4],
        quaternions[i * 4 + 1],
        quaternions[i * 4 + 2],
        quaternions[i * 4 + 3],
      );
      dummy.scale.set(scales[i * 3], scales[i * 3 + 1], scales[i * 3 + 2]);
      dummy.updateMatrix();
      dummy.matrix.toArray(nextMatrices, matrixOffset);
      matrixOffset += 16;
    }

    mesh.count = count;
    transitionCleanupRef.current?.();
    // Animate only when count is stable AND matrices fit within the byte budget.
    const matrixBytes = count * 16 * Float32Array.BYTES_PER_ELEMENT;
    const animate =
      previousInstanceCountRef.current === count && matrixBytes <= animationByteBudget;
    previousInstanceCountRef.current = count;
    const colorTarget = colors.subarray(0, count * 3);
    if (!animate) {
      matrixArray.set(nextMatrices, 0);
      colorArray.set(colorTarget, 0);
      mesh.instanceMatrix.needsUpdate = true;
      meshInstanceColor.needsUpdate = true;
      scheduleInvalidate();
      transitionCleanupRef.current = null;
      return;
    }
    const cleanupMatrix = applyLiveBufferTransition({
      destination: matrixArray.subarray(0, count * 16),
      target: nextMatrices,
      maxAnimatedValues: 320_000,
      markNeedsUpdate: () => {
        mesh.instanceMatrix.needsUpdate = true;
      },
      scheduleInvalidate,
    });
    const cleanupColors = applyLiveBufferTransition({
      destination: colorArray.subarray(0, count * 3),
      target: colorTarget,
      maxAnimatedValues: 180_000,
      markNeedsUpdate: () => {
        meshInstanceColor.needsUpdate = true;
      },
      scheduleInvalidate,
    });
    transitionCleanupRef.current = () => {
      cleanupMatrix();
      cleanupColors();
    };
    return () => {
      transitionCleanupRef.current?.();
      transitionCleanupRef.current = null;
    };
  }, [
    animationByteBudget,
    colors,
    count,
    instanceColorAttribute,
    meshRef,
    positions,
    quaternions,
    renderOrder,
    scales,
    scheduleInvalidate,
  ]);
}
