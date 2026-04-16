import React, { useMemo, useRef, useEffect, useLayoutEffect } from "react";
import * as THREE from "three";
import { useThree } from "@react-three/fiber";
import { FemMeshData, FemColorField, FemArrowColorMode, ArrowSamplingMode } from "../FemMeshView3D";
import { divergingColor, magnitudeColor } from "./colorUtils";
import { applyMagnetizationHsl } from "../magnetizationColor";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { isNodeActive, maskKind } from "../fem/femNodeMask";
import { RENDER_POLICIES_V2 } from "../shared/renderPolicyV2";

export type ArrowLengthMode = "constant" | "magnitude" | "sqrt" | "log";

interface FemArrowsProps {
  meshData: FemMeshData;
  field: FemColorField;
  arrowDensity: number;
  colorMode?: FemArrowColorMode;
  monoColor?: string;
  alpha?: number;
  lengthScale?: number;
  thickness?: number;
  center: THREE.Vector3;
  maxDim: number;
  visible: boolean;
  activeNodeMask?: Uint8Array | boolean[] | null;
  boundaryFaceIndices?: number[] | null;
  lengthMode?: ArrowLengthMode;
  samplingMode?: ArrowSamplingMode;
  /** Reports the final sampled node count after density filtering. */
  onSampledCount?: (count: number | undefined) => void;
}

/* ── Arrow template geometry — only depends on maxDim ───────────────── */
function useArrowTemplate(maxDim: number) {
  return useMemo(() => {
    const arrowLen = maxDim * 0.035;
    const shaftRadius = arrowLen * 0.08;
    const headRadius = arrowLen * 0.20;
    const headLen = arrowLen * 0.35;
    const shaftLen = arrowLen - headLen;

    const shaft = new THREE.CylinderGeometry(shaftRadius, shaftRadius, shaftLen, 6);
    shaft.rotateX(Math.PI / 2);
    shaft.translate(0, 0, shaftLen / 2);
    
    const head = new THREE.ConeGeometry(headRadius, headLen, 6);
    head.rotateX(Math.PI / 2);
    head.translate(0, 0, shaftLen + headLen / 2);

    const shaftPos = shaft.getAttribute("position") as THREE.BufferAttribute;
    const headPos = head.getAttribute("position") as THREE.BufferAttribute;
    const totalVerts = shaftPos.count + headPos.count;
    const positions = new Float32Array(totalVerts * 3);
    const normals = new Float32Array(totalVerts * 3);
    positions.set(new Float32Array(shaftPos.array), 0);
    positions.set(new Float32Array(headPos.array), shaftPos.count * 3);
    const shaftNorm = shaft.getAttribute("normal") as THREE.BufferAttribute;
    const headNorm = head.getAttribute("normal") as THREE.BufferAttribute;
    normals.set(new Float32Array(shaftNorm.array), 0);
    normals.set(new Float32Array(headNorm.array), shaftPos.count * 3);

    const merged = new THREE.BufferGeometry();
    merged.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    merged.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    const baseColors = new Float32Array(totalVerts * 3);
    baseColors.fill(1);
    merged.setAttribute("color", new THREE.BufferAttribute(baseColors, 3));

    const shaftIdx = shaft.getIndex()!;
    const headIdx = head.getIndex()!;
    const indexArr = new Uint32Array(shaftIdx.count + headIdx.count);
    for (let i = 0; i < shaftIdx.count; i++) indexArr[i] = shaftIdx.array[i];
    for (let i = 0; i < headIdx.count; i++) indexArr[shaftIdx.count + i] = headIdx.array[i] + shaftPos.count;
    merged.setIndex(new THREE.BufferAttribute(indexArr, 1));
    merged.translate(0, 0, -arrowLen / 2);

    shaft.dispose();
    head.dispose();
    return merged;
  }, [maxDim]);
}

/* ── Sample candidate nodes adaptively ─────────────────────────────── */
function sampleCandidateNodes(
  nodes: number[], 
  candidateNodes: readonly number[],
  targetDensity: number,
): number[] {
  if (candidateNodes.length === 0 || targetDensity <= 0) return [];
  // Input candidate list is already de-duplicated in the caller.
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
    const distSq = dx*dx + dy*dy + dz*dz;
    if (distSq < cell.bestDistSq) {
      cell.bestDistSq = distSq;
      cell.bestNi = ni;
    }
  }

  interface Candidate { ni: number; hash: number; }
  const candidates: Candidate[] = [];
  
  const hashFn = (k: number) => {
    const xVal = Math.sin(k * 12.9898) * 43758.5453;
    return xVal - Math.floor(xVal);
  };

  for (const [key, cell] of cellMap.entries()) {
    candidates.push({ ni: cell.bestNi, hash: hashFn(key) });
  }

  if (candidates.length <= targetDensity) return candidates.map((c) => c.ni);

  candidates.sort((a, b) => a.hash - b.hash);
  const result: number[] = new Array(Math.min(targetDensity, candidates.length));
  const step = candidates.length / result.length;
  for (let i = 0; i < result.length; i += 1) {
    result[i] = candidates[Math.floor(i * step)].ni;
  }

  // De-duplicate occasional collisions due to index quantization.
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

export function FemArrows({
  meshData,
  field,
  arrowDensity,
  colorMode = "orientation",
  monoColor = "#00c2ff",
  alpha = 1,
  lengthScale = 1,
  thickness = 1,
  center,
  maxDim,
  visible,
  activeNodeMask,
  boundaryFaceIndices,
  lengthMode = "magnitude",
  samplingMode = "auto",
  onSampledCount,
}: FemArrowsProps) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const { invalidate } = useThree();
  const glyphPolicy = RENDER_POLICIES_V2.glyphs;
  const clampedAlpha = Math.max(0.05, Math.min(1, alpha));
  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        vertexColors: true,
        transparent: glyphPolicy.transparent || clampedAlpha < 0.999,
        opacity: clampedAlpha,
        depthWrite: glyphPolicy.depthWrite,
        depthTest: glyphPolicy.depthTest,
        side: glyphPolicy.side,
        toneMapped: false,
      }),
    [
      clampedAlpha,
      glyphPolicy.depthTest,
      glyphPolicy.depthWrite,
      glyphPolicy.side,
      glyphPolicy.transparent,
    ],
  );

  const templateGeometry = useArrowTemplate(maxDim);

  useEffect(() => {
    return () => {
      material.dispose();
    };
  }, [material]);

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
        if (base + 2 >= meshData.boundaryFaces.length) {
          continue;
        }
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
            meshData.quantityDomain === "full_domain" ||
            meshData.quantityDomain === "surface_only"
          );

  const filteredCandidateNodes = useMemo(() => {
    const source = useVolumeCandidates ? volumeCandidateNodes : boundaryCandidateNodes;
    if (!effectiveNodeMask) {
      return source;
    }
    return source.filter((nodeIndex) => isNodeActive(effectiveNodeMask, nodeIndex));
  }, [boundaryCandidateNodes, effectiveNodeMask, useVolumeCandidates, volumeCandidateNodes]);

  const sampledNodes = useMemo(() => {
    if (!visible) return [] as number[];
    if (!meshData.fieldData) return [] as number[];
    if (meshData.quantityDomain === "magnetic_only" && !effectiveNodeMask) {
      return [] as number[];
    }
    const primaryCandidates = effectiveNodeMask
      ? filteredCandidateNodes
      : filteredCandidateNodes.length > 0
        ? filteredCandidateNodes
        : useVolumeCandidates
          ? volumeCandidateNodes
          : boundaryCandidateNodes;
    const sampledPrimary = sampleCandidateNodes(meshData.nodes, primaryCandidates, arrowDensity);
    if (sampledPrimary.length > 0 || !useVolumeCandidates) {
      return sampledPrimary;
    }
    const boundaryFallbackCandidates = effectiveNodeMask
      ? boundaryCandidateNodes.filter((nodeIndex) => isNodeActive(effectiveNodeMask, nodeIndex))
      : boundaryCandidateNodes;
    return sampleCandidateNodes(meshData.nodes, boundaryFallbackCandidates, arrowDensity);
  }, [
    arrowDensity,
    boundaryCandidateNodes,
    effectiveNodeMask,
    filteredCandidateNodes,
    meshData.fieldData,
    meshData.nodes,
    meshData.nNodes,
    meshData.quantityDomain,
    useVolumeCandidates,
    visible,
    volumeCandidateNodes,
  ]);

  // Report sampled count to parent for ArrowRenderState refinement.
  useEffect(() => {
    if (!visible || !meshData.fieldData) {
      onSampledCount?.(undefined);
      return;
    }
    onSampledCount?.(sampledNodes.length);
  }, [meshData.fieldData, onSampledCount, sampledNodes.length, visible]);

  const { count, positions, quaternions, scales, colors } = useMemo(() => {
    const emptyRet = {
      count: 0,
      positions: new Float32Array(0),
      quaternions: new Float32Array(0),
      scales: new Float32Array(0),
      colors: new Float32Array(0),
    };
    if (!visible) return emptyRet;
    const fld = meshData.fieldData;
    if (!fld) return emptyRet;
    if (sampledNodes.length === 0) {
      return emptyRet;
    }
    const resultCount = sampledNodes.length;

    let maxAbsX = 0, maxAbsY = 0, maxAbsZ = 0, maxMag = 0;
    for (const ni of sampledNodes) {
      const vx = fld.x[ni] ?? 0, vy = fld.y[ni] ?? 0, vz = fld.z[ni] ?? 0;
      maxAbsX = Math.max(maxAbsX, Math.abs(vx));
      maxAbsY = Math.max(maxAbsY, Math.abs(vy));
      maxAbsZ = Math.max(maxAbsZ, Math.abs(vz));
      maxMag = Math.max(maxMag, Math.sqrt(vx * vx + vy * vy + vz * vz));
    }
    const scaleX = Math.max(maxAbsX, 1e-12);
    const scaleY = Math.max(maxAbsY, 1e-12);
    const scaleZ = Math.max(maxAbsZ, 1e-12);
    const scaleMag = Math.max(maxMag, 1e-12);
    const clampedLengthScale = Math.max(0.2, Math.min(4, lengthScale));
    const clampedThickness = Math.max(0.2, Math.min(4, thickness));

    const quaternionsList = new Float32Array(resultCount * 4);
    const scalesList = new Float32Array(resultCount * 3);
    const colorsList = new Float32Array(resultCount * 3);
    const positionsList = new Float32Array(resultCount * 3);

    const _dir = new THREE.Vector3();
    const _defaultUp = new THREE.Vector3(0, 0, 1);
    const _color = new THREE.Color();
    const _dummyQ = new THREE.Quaternion();

    for (let i = 0; i < resultCount; i++) {
      const ni = sampledNodes[i];
      positionsList[i * 3] = meshData.nodes[ni * 3] - center.x;
      positionsList[i * 3 + 1] = meshData.nodes[ni * 3 + 1] - center.y;
      positionsList[i * 3 + 2] = meshData.nodes[ni * 3 + 2] - center.z;
      const vx = fld.x[ni] ?? 0, vy = fld.y[ni] ?? 0, vz = fld.z[ni] ?? 0;
      const len = Math.sqrt(vx * vx + vy * vy + vz * vz);

      if (len < 1e-12) {
        scalesList[i * 3] = 0; scalesList[i * 3 + 1] = 0; scalesList[i * 3 + 2] = 0;
        _dummyQ.identity();
      } else {
        let s = 1;
        if (lengthMode === "magnitude") {
          s = 0.2 + 0.8 * (len / scaleMag);
        } else if (lengthMode === "sqrt") {
          s = 0.2 + 0.8 * Math.sqrt(len / scaleMag);
        } else if (lengthMode === "log") {
          s = 0.2 + 0.8 * Math.log1p(len / scaleMag * 9) / Math.log(10);
        }
        scalesList[i * 3] = s * clampedThickness;
        scalesList[i * 3 + 1] = s * clampedThickness;
        scalesList[i * 3 + 2] = s * clampedLengthScale;
        _dir.set(vx, vy, vz).normalize();
        _dummyQ.setFromUnitVectors(_defaultUp, _dir);
      }

      quaternionsList[i * 4] = _dummyQ.x;
      quaternionsList[i * 4 + 1] = _dummyQ.y;
      quaternionsList[i * 4 + 2] = _dummyQ.z;
      quaternionsList[i * 4 + 3] = _dummyQ.w;

      switch (colorMode) {
        case "orientation":
          applyMagnetizationHsl(vx, vy, vz, _color);
          break;
        case "x":
          divergingColor(vx / scaleX, _color);
          break;
        case "y":
          divergingColor(vy / scaleY, _color);
          break;
        case "z":
          divergingColor(vz / scaleZ, _color);
          break;
        case "magnitude":
          magnitudeColor(len / scaleMag, _color);
          break;
        case "monochrome":
          _color.set(monoColor);
          break;
        default:
          // Backward compatibility: if caller still drives by `field`.
          switch (field) {
            case "x":
              divergingColor(vx / scaleX, _color);
              break;
            case "y":
              divergingColor(vy / scaleY, _color);
              break;
            case "z":
              divergingColor(vz / scaleZ, _color);
              break;
            case "magnitude":
              magnitudeColor(len / scaleMag, _color);
              break;
            default:
              applyMagnetizationHsl(vx, vy, vz, _color);
              break;
          }
          break;
      }

      colorsList[i * 3] = _color.r;
      colorsList[i * 3 + 1] = _color.g;
      colorsList[i * 3 + 2] = _color.b;
    }

    return {
      count: resultCount,
      positions: positionsList,
      quaternions: quaternionsList,
      scales: scalesList,
      colors: colorsList,
    };
  }, [
    meshData,
    field,
    colorMode,
    monoColor,
    center,
    visible,
    lengthMode,
    lengthScale,
    thickness,
    sampledNodes,
  ]);
  const capacity = Math.max(count, 1);
  const instanceColorAttribute = useMemo(() => {
    const attribute = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    attribute.setUsage(THREE.DynamicDrawUsage);
    return attribute;
  }, [capacity]);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) {
      return;
    }
    mesh.instanceColor = instanceColorAttribute;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = count;
    if (mesh.instanceColor) {
      mesh.instanceColor.needsUpdate = true;
    }
    invalidate();
  }, [count, glyphPolicy.renderOrder, instanceColorAttribute, invalidate, material]);

  // Apply instance matrices and per-instance colors using the same low-level
  // buffer path that already works reliably in FDM preview rendering.
  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const instanceColor = mesh.instanceColor ?? instanceColorAttribute;
    if (!instanceColor) return;
    const matrixArray = mesh.instanceMatrix.array as Float32Array;
    const colorArray = instanceColor.array as Float32Array;
    colorArray.set(colors.subarray(0, count * 3), 0);
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
      dummy.matrix.toArray(matrixArray, matrixOffset);
      matrixOffset += 16;
    }

    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    instanceColor.needsUpdate = true;
    invalidate();
  }, [
    colors,
    count,
    instanceColorAttribute,
    positions,
    invalidate,
    material,
    quaternions,
    scales,
  ]);

  if (!visible || count === 0) {
    if (
      visible &&
      count === 0 &&
      effectiveNodeMask &&
      FRONTEND_DIAGNOSTIC_FLAGS.renderDebug.enableRenderLogging
    ) {
      console.debug("[FemArrows] zero sampled nodes", {
        boundaryCandidateCount: boundaryCandidateNodes.length,
        filteredCandidateCount: filteredCandidateNodes.length,
        hasFieldData: Boolean(meshData.fieldData),
        quantityDomain: meshData.quantityDomain,
        maskKind: maskKind(effectiveNodeMask),
      });
    }
    return null;
  }

  return (
    <instancedMesh
      ref={meshRef}
      args={[templateGeometry!, material, capacity]}
      frustumCulled={false}
      renderOrder={glyphPolicy.renderOrder}
    >
      <primitive attach="instanceColor" object={instanceColorAttribute} />
    </instancedMesh>
  );
}
