import React, { memo, useMemo, useEffect, useRef, useCallback } from "react";
import * as THREE from "three";
import { useThree } from "@react-three/fiber";
import { FemMeshData, FemColorField, RenderMode } from "../FemMeshView3D";
import { computeFaceAspectRatios } from "./colorUtils";
import { computeVertexColors, getSharedVertexColors } from "./femVertexColors";
import { RENDER_POLICIES_V2 } from "../shared/renderPolicyV2";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { recordFrontendPerfSample } from "@/lib/debug/frontendPerfDebug";

interface FemGeometryProps {
  meshData: FemMeshData;
  field: FemColorField;
  renderMode: RenderMode;
  opacity: number;
  uniformColor?: string;
  edgeColor?: string;
  highlight?: boolean;
  customBoundaryFaces?: [number, number, number][] | null;
  displayBoundaryFaceIndices?: number[] | null;
  displayElementIndices?: number[] | null;
  qualityPerFace?: number[] | null;
  sharedBaseVertexColors?: Float32Array | null;
  shrinkFactor?: number;
  clipEnabled?: boolean;
  clipAxis?: "x" | "y" | "z";
  clipPos?: number;
  globalCenter?: THREE.Vector3;
  onGeometryCenter?: (center: THREE.Vector3, maxDim: number, size: THREE.Vector3) => void;
  onFaceClick?: (e: any) => void;
  onFaceHover?: (e: any) => void;
  onFaceUnhover?: (e: any) => void;
  onFaceContextMenu?: (e: any) => void;
  showSurfacePass?: boolean;
  showSurfaceHiddenEdgesPass?: boolean;
  showSurfaceVisibleEdgesPass?: boolean;
  showVolumeHiddenEdgesPass?: boolean;
  showVolumeVisibleEdgesPass?: boolean;
  showPointsPass?: boolean;
  enableGeometryCompaction?: boolean;
  enableGeometryNormals?: boolean;
  enableGeometryVertexColors?: boolean;
  enableGeometryPointerInteractions?: boolean;
  enableGeometryHoverInteractions?: boolean;
}

function flattenBoundaryFaces(customBoundaryFaces: readonly [number, number, number][]): Uint32Array {
  const flat = new Uint32Array(customBoundaryFaces.length * 3);
  let offset = 0;
  for (const [a, b, c] of customBoundaryFaces) {
    flat[offset] = a;
    flat[offset + 1] = b;
    flat[offset + 2] = c;
    offset += 3;
  }
  return flat;
}

function collectFaceNodeIndices(boundaryFaces: ArrayLike<number>, faceIndices: readonly number[]): number[] {
  const maxFaces = Math.floor(boundaryFaces.length / 3);
  const unique = new Set<number>();
  for (const faceIndex of faceIndices) {
    if (!Number.isInteger(faceIndex) || faceIndex < 0 || faceIndex >= maxFaces) {
      continue;
    }
    const base = faceIndex * 3;
    unique.add(boundaryFaces[base]);
    unique.add(boundaryFaces[base + 1]);
    unique.add(boundaryFaces[base + 2]);
  }
  return Array.from(unique);
}

function collectElementNodeIndices(
  elements: ArrayLike<number>,
  nElements: number,
  elementOffsets: readonly number[],
): number[] {
  const unique = new Set<number>();
  for (const elementOffset of elementOffsets) {
    if (
      !Number.isInteger(elementOffset) ||
      elementOffset < 0 ||
      elementOffset + 3 >= elements.length ||
      Math.trunc(elementOffset / 4) >= nElements
    ) {
      continue;
    }
    unique.add(elements[elementOffset]);
    unique.add(elements[elementOffset + 1]);
    unique.add(elements[elementOffset + 2]);
    unique.add(elements[elementOffset + 3]);
  }
  return Array.from(unique);
}

/* ── Helper: compute vertex colors from field data ─────────────────── */
export const FemGeometry = memo(function FemGeometry({
  meshData,
  field,
  renderMode,
  opacity,
  uniformColor,
  edgeColor,
  highlight = false,
  customBoundaryFaces,
  displayBoundaryFaceIndices,
  displayElementIndices,
  qualityPerFace,
  sharedBaseVertexColors = null,
  shrinkFactor,
  clipEnabled,
  clipAxis,
  clipPos,
  globalCenter,
  onGeometryCenter,
  onFaceClick,
  onFaceHover,
  onFaceUnhover,
  onFaceContextMenu,
  showSurfacePass = true,
  showSurfaceHiddenEdgesPass = true,
  showSurfaceVisibleEdgesPass = true,
  showVolumeHiddenEdgesPass = true,
  showVolumeVisibleEdgesPass = true,
  showPointsPass = true,
  enableGeometryCompaction = true,
  enableGeometryNormals = true,
  enableGeometryVertexColors = true,
  enableGeometryPointerInteractions = true,
  enableGeometryHoverInteractions = true,
}: FemGeometryProps) {
  const { invalidate } = useThree();
  const {
    nodes,
    elements,
    boundaryFaces: meshBoundaryFaces,
    nNodes,
    nElements,
    fieldData,
  } = meshData;
  const centerX = globalCenter?.x ?? null;
  const centerY = globalCenter?.y ?? null;
  const centerZ = globalCenter?.z ?? null;
  const hasFieldColormap = field !== "none";
  const resolvedEdgeColor = useMemo(
    () => (hasFieldColormap ? "#d1d5db" : edgeColor ?? uniformColor ?? "#dbeafe"),
    [edgeColor, hasFieldColormap, uniformColor],
  );
  const usesNeutralSelectionHighlight = highlight && hasFieldColormap;
  const resolvedHighlightEmissive = useMemo(() => {
    if (usesNeutralSelectionHighlight) {
      return "#f8fafc";
    }
    const color = new THREE.Color(uniformColor ?? "#cbd5e1");
    color.lerp(new THREE.Color("#ffffff"), 0.42);
    return `#${color.getHexString()}`;
  }, [uniformColor, usesNeutralSelectionHighlight]);

  // ── Topology memo: only rebuilds when mesh structure changes ─────
  // Aux geometries (edges, tetra, points) are split into separate memos
  // so that renderMode switches don't trigger this heavy path.
  const {
    geometry,
    center,
    maxDim,
    geoSize,
    vertexMap,
    displayedToOriginalFace,
    _positions,
    _activeElementOffsets,
    _doShrink,
    _preferredFaceIndices,
    _resolvedBoundaryFaces,
  } = useMemo(() => {
    const perfEnabled = FRONTEND_DIAGNOSTIC_FLAGS.femViewport.enableGeometryPerfLogging;
    const totalStart = perfEnabled ? performance.now() : 0;
    const marks: Record<string, number> = {};
    const mark = (name: string) => {
      if (perfEnabled) {
        marks[name] = performance.now();
      }
    };
    const sample = (phase: string, start: number, extra?: Record<string, number | string | boolean | null>) => {
      if (!perfEnabled) return;
      recordFrontendPerfSample({
        scope: "FemGeometry",
        phase,
        durationMs: performance.now() - start,
        timestampMs: performance.now(),
        meta: {
          nNodes,
          nElements,
          ...extra,
        },
      });
    };

    mark("start");
    const boundaryFaces = customBoundaryFaces
      ? flattenBoundaryFaces(customBoundaryFaces)
      : meshBoundaryFaces;
    const positions = new Float32Array(nNodes * 3);
    for (let i = 0; i < nNodes * 3; i++) positions[i] = nodes[i];

    // D-03 fix: Distinguish null (full mesh), [] (empty — render nothing), and [a,b,c] (subset).
    // Previously [] was collapsed to null which caused full-mesh fallback for empty subsets.
    const preferredFaceIndices = Array.isArray(displayBoundaryFaceIndices)
      ? displayBoundaryFaceIndices
      : null;
    const preferredElementIndices = Array.isArray(displayElementIndices)
      ? displayElementIndices
      : null;

    // D-03 fix: If both face and element subsets are explicitly empty, render nothing.
    const emptyFaceSubset = preferredFaceIndices !== null && preferredFaceIndices.length === 0;
    const emptyElementSubset = preferredElementIndices !== null && preferredElementIndices.length === 0;
    if (emptyFaceSubset && emptyElementSubset) {
      mark("post-inputs");
      return {
        geometry: new THREE.BufferGeometry(),
        center: new THREE.Vector3(),
        maxDim: 0,
        geoSize: new THREE.Vector3(),
        vertexMap: null,
        displayedToOriginalFace: null,
        _positions: new Float32Array(0),
        _activeElementOffsets: [] as number[],
        _doShrink: false,
        _preferredFaceIndices: null as number[] | null,
        _resolvedBoundaryFaces: new Uint32Array(0),
      };
    }
    mark("post-inputs");

    // Compute unclipped bounding box for stable centering. When the mesh includes
    // a shared air-domain shell, prefer the visible magnetic-object surfaces so
    // the camera does not zoom out to the whole outer box by default.
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    const bboxNodeIndices = preferredFaceIndices
      ? (() => {
          const unique = new Set<number>();
          const maxFaces = Math.floor(boundaryFaces.length / 3);
          for (const faceIndex of preferredFaceIndices) {
            if (!Number.isInteger(faceIndex) || faceIndex < 0 || faceIndex >= maxFaces) {
              continue;
            }
            const base = faceIndex * 3;
            unique.add(boundaryFaces[base]);
            unique.add(boundaryFaces[base + 1]);
            unique.add(boundaryFaces[base + 2]);
          }
          return unique.size > 0 ? Array.from(unique) : null;
        })()
      : null;
    if (bboxNodeIndices) {
      for (const nodeIndex of bboxNodeIndices) {
        const offset = nodeIndex * 3;
        const x = positions[offset], y = positions[offset + 1], z = positions[offset + 2];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
    } else {
      for (let nodeIndex = 0; nodeIndex < nNodes; nodeIndex += 1) {
        const offset = nodeIndex * 3;
        const x = positions[offset], y = positions[offset + 1], z = positions[offset + 2];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
    }
    const cX = (minX + maxX) / 2, cY = (minY + maxY) / 2, cZ = (minZ + maxZ) / 2;
    const size = new THREE.Vector3(maxX - minX, maxY - minY, maxZ - minZ);
    const ms = Math.max(size.x, size.y, size.z);
    mark("post-bounds");
    
    // Center positions
    const subX = centerX ?? cX;
    const subY = centerY ?? cY;
    const subZ = centerZ ?? cZ;
    for (let i = 0; i < nNodes * 3; i += 3) {
      positions[i] -= subX; positions[i + 1] -= subY; positions[i + 2] -= subZ;
    }
    mark("post-center");

    const isVolumetric = elements.length >= 4;
    const doVolumeClip = isVolumetric && clipEnabled;
    const doShrink = isVolumetric && shrinkFactor && shrinkFactor < 0.999;
    const baseElementOffsets = preferredElementIndices
      ? (() => {
          const offsets: number[] = [];
          for (const elementIndex of preferredElementIndices) {
            if (!Number.isInteger(elementIndex) || elementIndex < 0 || elementIndex >= nElements) {
              continue;
            }
            offsets.push(elementIndex * 4);
          }
          return offsets;
        })()
      : (() => {
          const offsets = new Array<number>(nElements);
          for (let elementIndex = 0; elementIndex < nElements; elementIndex += 1) {
            offsets[elementIndex] = elementIndex * 4;
          }
          return offsets;
        })();

    let finalIndices: Uint32Array | null = null;
    let finalPositions: Float32Array = positions;
    let vMap: Int32Array | null = null;
    let faceIndexMap: Int32Array | null = null;

    const getAxisIdx = () => clipAxis === "y" ? 1 : clipAxis === "z" ? 2 : 0;
    const clipAxisSize = clipAxis === "y" ? size.y : clipAxis === "z" ? size.z : size.x;
    const posReal = ((clipPos ?? 50) / 100 - 0.5) * clipAxisSize;
    const axisIdx = getAxisIdx();
    const activeElementOffsets = clipEnabled && isVolumetric
      ? baseElementOffsets.filter((elementOffset) => {
          const a = elements[elementOffset];
          const b = elements[elementOffset + 1];
          const cIdx = elements[elementOffset + 2];
          const d = elements[elementOffset + 3];
          const cx = (
            positions[a * 3 + axisIdx] +
            positions[b * 3 + axisIdx] +
            positions[cIdx * 3 + axisIdx] +
            positions[d * 3 + axisIdx]
          ) / 4;
          return cx <= posReal;
        })
      : baseElementOffsets;
    mark("post-selection");

    if (doShrink) {
      const keptTets: number[] = [];
      for (const elementOffset of activeElementOffsets) {
        keptTets.push(
          elements[elementOffset],
          elements[elementOffset + 1],
          elements[elementOffset + 2],
          elements[elementOffset + 3],
        );
      }

      finalPositions = new Float32Array(keptTets.length / 4 * 12 * 3);
      vMap = new Int32Array(keptTets.length / 4 * 12);
      
      const faces = [[0,1,3], [1,2,3], [2,0,3], [0,2,1]]; // tet faces
      let vIdx = 0;
      const sf = shrinkFactor ?? 1.0;
      
      for (let i = 0; i < keptTets.length; i += 4) {
        const tet = [keptTets[i], keptTets[i+1], keptTets[i+2], keptTets[i+3]];
        const cx = (positions[tet[0]*3] + positions[tet[1]*3] + positions[tet[2]*3] + positions[tet[3]*3]) / 4;
        const cy = (positions[tet[0]*3+1] + positions[tet[1]*3+1] + positions[tet[2]*3+1] + positions[tet[3]*3+1]) / 4;
        const cz = (positions[tet[0]*3+2] + positions[tet[1]*3+2] + positions[tet[2]*3+2] + positions[tet[3]*3+2]) / 4;
        
        for (const face of faces) {
          for (const fv of face) {
            const origNode = tet[fv];
            vMap[vIdx] = origNode;
            const px = positions[origNode*3];
            const py = positions[origNode*3+1];
            const pz = positions[origNode*3+2];
            finalPositions[vIdx*3] = cx + (px - cx) * sf;
            finalPositions[vIdx*3+1] = cy + (py - cy) * sf;
            finalPositions[vIdx*3+2] = cz + (pz - cz) * sf;
            vIdx++;
          }
        }
      }
    } else if (doVolumeClip) {
      const faceMap = new Map<bigint, [number, number, number]>();
      const addFace = (a: number, b: number, c: number) => {
        let v1 = a, v2 = b, v3 = c;
        if (v2 < v1 && v2 < v3) { v1 = b; v2 = c; v3 = a; }
        else if (v3 < v1 && v3 < v2) { v1 = c; v2 = a; v3 = b; }
        const key = BigInt(v1) | (BigInt(Math.min(v2, v3)) << 20n) | (BigInt(Math.max(v2, v3)) << 40n);
        if (faceMap.has(key)) faceMap.delete(key);
        else faceMap.set(key, [a, b, c]);
      };

      for (const elementOffset of activeElementOffsets) {
        const a = elements[elementOffset];
        const b = elements[elementOffset + 1];
        const cIdx = elements[elementOffset + 2];
        const d = elements[elementOffset + 3];
        addFace(a, b, d);
        addFace(b, cIdx, d);
        addFace(cIdx, a, d);
        addFace(a, cIdx, b);
      }
      finalIndices = new Uint32Array(faceMap.size * 3);
      let idx = 0;
      for (const face of faceMap.values()) {
        finalIndices[idx++] = face[0];
        finalIndices[idx++] = face[1];
        finalIndices[idx++] = face[2];
      }
    } else {
      const sourceFaceIndices = preferredFaceIndices
        ?? Array.from({ length: boundaryFaces.length / 3 }, (_, faceIndex) => faceIndex);

      // Collect unique nodes referenced by displayed faces
      const usedNodeSet = new Set<number>();
      const maxFaceIdx = Math.floor(boundaryFaces.length / 3);
      for (const faceIndex of sourceFaceIndices) {
        if (faceIndex < 0 || faceIndex >= maxFaceIdx) continue;
        const base = faceIndex * 3;
        usedNodeSet.add(boundaryFaces[base]);
        usedNodeSet.add(boundaryFaces[base + 1]);
        usedNodeSet.add(boundaryFaces[base + 2]);
      }
      const compactCount = usedNodeSet.size;

      // Compact positions when rendering a per-part subset (saves memory + CPU for normals/wireframe)
      if (enableGeometryCompaction && compactCount > 0 && compactCount < nNodes * 0.9) {
        const usedNodesSorted = Array.from(usedNodeSet).sort((a, b) => a - b);
        const globalToLocal = new Int32Array(nNodes).fill(-1);
        for (let i = 0; i < compactCount; i++) {
          globalToLocal[usedNodesSorted[i]] = i;
        }
        finalPositions = new Float32Array(compactCount * 3);
        vMap = new Int32Array(compactCount);
        for (let i = 0; i < compactCount; i++) {
          const g = usedNodesSorted[i];
          vMap[i] = g;
          finalPositions[i * 3] = positions[g * 3];
          finalPositions[i * 3 + 1] = positions[g * 3 + 1];
          finalPositions[i * 3 + 2] = positions[g * 3 + 2];
        }
        finalIndices = new Uint32Array(sourceFaceIndices.length * 3);
        faceIndexMap = new Int32Array(sourceFaceIndices.length);
        let offset = 0;
        for (let displayFaceIndex = 0; displayFaceIndex < sourceFaceIndices.length; displayFaceIndex++) {
          const originalFaceIndex = sourceFaceIndices[displayFaceIndex];
          const base = originalFaceIndex * 3;
          finalIndices[offset] = globalToLocal[boundaryFaces[base]];
          finalIndices[offset + 1] = globalToLocal[boundaryFaces[base + 1]];
          finalIndices[offset + 2] = globalToLocal[boundaryFaces[base + 2]];
          faceIndexMap[displayFaceIndex] = originalFaceIndex;
          offset += 3;
        }
      } else {
        // Full mesh or nearly full - no compaction needed
        finalIndices = new Uint32Array(sourceFaceIndices.length * 3);
        faceIndexMap = new Int32Array(sourceFaceIndices.length);
        let offset = 0;
        for (let displayFaceIndex = 0; displayFaceIndex < sourceFaceIndices.length; displayFaceIndex += 1) {
          const originalFaceIndex = sourceFaceIndices[displayFaceIndex];
          const base = originalFaceIndex * 3;
          finalIndices[offset] = boundaryFaces[base];
          finalIndices[offset + 1] = boundaryFaces[base + 1];
          finalIndices[offset + 2] = boundaryFaces[base + 2];
          faceIndexMap[displayFaceIndex] = originalFaceIndex;
          offset += 3;
        }
      }
    }
    mark("post-topology");

    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(finalPositions, 3));
    if (finalIndices) {
      geom.setIndex(new THREE.BufferAttribute(finalIndices, 1));
    }
    if (enableGeometryNormals) {
      geom.computeVertexNormals();
    }
    if (enableGeometryVertexColors) {
      geom.setAttribute("color", new THREE.BufferAttribute(new Float32Array(finalPositions.length), 3));
    }
    mark("post-geometry");

    if (perfEnabled) {
      const phases: Array<[string, string]> = [
        ["inputs", "post-inputs"],
        ["bounds", "post-bounds"],
        ["center", "post-center"],
        ["selection", "post-selection"],
        ["topology", "post-topology"],
        ["geometry", "post-geometry"],
      ];
      let prev = marks.start ?? totalStart;
      for (const [phase, endKey] of phases) {
        const end = marks[endKey];
        if (typeof end === "number") {
          recordFrontendPerfSample({
            scope: "FemGeometry",
            phase,
            durationMs: end - prev,
            timestampMs: end,
            meta: {
              nNodes,
              nElements,
              compacted: Boolean(vMap),
              clipped: Boolean(clipEnabled),
            },
          });
          prev = end;
        }
      }
      sample("topologyTotal", totalStart, {
        compacted: Boolean(vMap),
        clipped: Boolean(clipEnabled),
      });
    }

    return {
      geometry: geom,
      center:
        centerX == null || centerY == null || centerZ == null
          ? new THREE.Vector3(cX, cY, cZ)
          : new THREE.Vector3(centerX, centerY, centerZ),
      maxDim: ms,
      geoSize: size,
      vertexMap: vMap,
      displayedToOriginalFace: faceIndexMap,
      _positions: positions,
      _activeElementOffsets: activeElementOffsets,
      _doShrink: doShrink,
      _preferredFaceIndices: preferredFaceIndices,
      _resolvedBoundaryFaces: boundaryFaces,
    };
  }, [
    meshBoundaryFaces,
    centerX,
    centerY,
    centerZ,
    elements,
    nElements,
    nNodes,
    nodes,
    customBoundaryFaces,
    clipAxis,
    clipEnabled,
    clipPos,
    displayBoundaryFaceIndices,
    displayElementIndices,
    enableGeometryCompaction,
    enableGeometryNormals,
    enableGeometryVertexColors,
    shrinkFactor,
  ]);

  // ── Edges geometry memo: only rebuilds when surface geometry or renderMode changes ──
  const edgesGeometry = useMemo(() => {
    const needsEdges = renderMode === "surface+edges" || renderMode === "wireframe";
    if (!needsEdges || !geometry) return null;
    return new THREE.WireframeGeometry(geometry);
  }, [geometry, renderMode]);

  // ── Tetra edges geometry memo ─────────────────────────────────────
  const tetraEdgesGeometry = useMemo(() => {
    if (renderMode !== "wireframe") return null;
    if (_doShrink || elements.length < 4 || !_positions) return null;
    const seenEdges = new Set<number>();
    const tetraEdgePairs: number[] = [];
    const registerEdge = (a: number, b: number) => {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const key = lo * nNodes + hi;
      if (seenEdges.has(key)) return;
      seenEdges.add(key);
      tetraEdgePairs.push(lo, hi);
    };
    for (const elementOffset of _activeElementOffsets) {
      const a = elements[elementOffset];
      const b = elements[elementOffset + 1];
      const cIdx = elements[elementOffset + 2];
      const d = elements[elementOffset + 3];
      registerEdge(a, b);
      registerEdge(a, cIdx);
      registerEdge(a, d);
      registerEdge(b, cIdx);
      registerEdge(b, d);
      registerEdge(cIdx, d);
    }
    if (tetraEdgePairs.length === 0) return null;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(_positions, 3));
    geom.setIndex(new THREE.BufferAttribute(new Uint32Array(tetraEdgePairs), 1));
    return geom;
  }, [renderMode, _doShrink, elements, nNodes, _positions, _activeElementOffsets]);

  // ── Points geometry memo ──────────────────────────────────────────
  const { pointsGeometry, pointsVertexMap } = useMemo(() => {
    if (renderMode !== "points" || !_positions) {
      return { pointsGeometry: null as THREE.BufferGeometry | null, pointsVertexMap: null as Int32Array | null };
    }
    const boundaryFaces = _resolvedBoundaryFaces;
    const pointNodeIndices =
      customBoundaryFaces && customBoundaryFaces.length > 0
        ? collectFaceNodeIndices(
            boundaryFaces,
            (() => {
              const faceCount = Math.floor(boundaryFaces.length / 3);
              const allFaceIndices = new Array<number>(faceCount);
              for (let index = 0; index < faceCount; index += 1) {
                allFaceIndices[index] = index;
              }
              return allFaceIndices;
            })(),
          )
        : _activeElementOffsets.length > 0
        ? collectElementNodeIndices(elements, nElements, _activeElementOffsets)
        : _preferredFaceIndices
          ? collectFaceNodeIndices(boundaryFaces, _preferredFaceIndices)
          : Array.from({ length: nNodes }, (_, index) => index);
    const pointPositions = new Float32Array(pointNodeIndices.length * 3);
    const pointVMap = new Int32Array(pointNodeIndices.length);
    for (let i = 0; i < pointNodeIndices.length; i += 1) {
      const nodeIndex = pointNodeIndices[i];
      pointVMap[i] = nodeIndex;
      const base = nodeIndex * 3;
      pointPositions[i * 3] = _positions[base];
      pointPositions[i * 3 + 1] = _positions[base + 1];
      pointPositions[i * 3 + 2] = _positions[base + 2];
    }
    const ptsGeom = new THREE.BufferGeometry();
    ptsGeom.setAttribute("position", new THREE.BufferAttribute(pointPositions, 3));
    if (enableGeometryVertexColors) {
      ptsGeom.setAttribute("color", new THREE.BufferAttribute(new Float32Array(pointPositions.length), 3));
    }
    return { pointsGeometry: ptsGeom, pointsVertexMap: pointVMap };
  }, [renderMode, _positions, _resolvedBoundaryFaces, customBoundaryFaces, _activeElementOffsets, elements, nElements, nNodes, _preferredFaceIndices, enableGeometryVertexColors]);

  // Invalidate the R3F frame when topology geometry rebuilds
  useEffect(() => {
    if (geometry) invalidate();
  }, [geometry, invalidate]);

  // ── Color update ──────────────────────────────────────────────────
  useEffect(() => {
    if (!geometry || !enableGeometryVertexColors) return;
    const perfEnabled = FRONTEND_DIAGNOSTIC_FLAGS.femViewport.enableGeometryPerfLogging;
    const totalStart = perfEnabled ? performance.now() : 0;
    const mark = (phase: string, start: number, extra?: Record<string, number | string | boolean | null>) => {
      if (!perfEnabled) return;
      recordFrontendPerfSample({
        scope: "FemGeometry",
        phase,
        durationMs: performance.now() - start,
        timestampMs: performance.now(),
        meta: {
          field,
          nNodes,
          nElements,
          ...extra,
        },
      });
    };
    const baseColorStart = perfEnabled ? performance.now() : 0;
    const baseColors: Float32Array =
      sharedBaseVertexColors && sharedBaseVertexColors.length === nNodes * 3
        ? sharedBaseVertexColors
        : customBoundaryFaces
          ? computeVertexColors(
              nNodes,
              field,
              fieldData,
              meshData.fieldNComp ?? 3,
              nodes,
              flattenBoundaryFaces(customBoundaryFaces),
              qualityPerFace,
            )
          : getSharedVertexColors({
              meshData,
              field,
              uniformColor,
              qualityPerFace,
            });
    mark("colorBaseCompute", baseColorStart);
    
    // Sub-select or map colors
    const meshApplyStart = perfEnabled ? performance.now() : 0;
    const colorAttr = geometry.getAttribute("color") as THREE.BufferAttribute;
    if (vertexMap) {
      for (let i = 0; i < vertexMap.length; i++) {
        const orig = vertexMap[i];
        colorAttr.array[i*3] = baseColors[orig*3];
        colorAttr.array[i*3+1] = baseColors[orig*3+1];
        colorAttr.array[i*3+2] = baseColors[orig*3+2];
      }
    } else {
      const posCount = geometry.getAttribute("position").count;
      for (let i = 0; i < posCount * 3; i++) {
        colorAttr.array[i] = baseColors[i];
      }
    }
    colorAttr.needsUpdate = true;
    mark("colorMeshApply", meshApplyStart, { mapped: Boolean(vertexMap) });
    if (pointsGeometry) {
      const pointsApplyStart = perfEnabled ? performance.now() : 0;
      const pointsColorAttr = pointsGeometry.getAttribute("color") as THREE.BufferAttribute | undefined;
      if (!pointsColorAttr) {
        invalidate();
        return;
      }
      if (pointsVertexMap) {
        for (let i = 0; i < pointsVertexMap.length; i += 1) {
          const orig = pointsVertexMap[i];
          pointsColorAttr.array[i * 3] = baseColors[orig * 3];
          pointsColorAttr.array[i * 3 + 1] = baseColors[orig * 3 + 1];
          pointsColorAttr.array[i * 3 + 2] = baseColors[orig * 3 + 2];
        }
      }
      pointsColorAttr.needsUpdate = true;
      mark("colorPointsApply", pointsApplyStart, { mapped: Boolean(pointsVertexMap) });
    }
    invalidate();
    mark("colorTotal", totalStart);
  }, [
    customBoundaryFaces,
    field,
    fieldData,
    geometry,
    invalidate,
    meshBoundaryFaces,
    nElements,
    nNodes,
    nodes,
    pointsGeometry,
    pointsVertexMap,
    qualityPerFace,
    sharedBaseVertexColors,
    uniformColor,
    vertexMap,
    enableGeometryVertexColors,
  ]);

  // ── Notify parent about geometry center (proper useEffect, not useMemo side-effect) ─
  const onGeometryCenterRef = useRef(onGeometryCenter);
  onGeometryCenterRef.current = onGeometryCenter;
  useEffect(() => {
    if (maxDim > 0 && onGeometryCenterRef.current) {
      onGeometryCenterRef.current(center, maxDim, geoSize);
    }
  }, [center, maxDim, geoSize]);

  // ── Dispose old THREE geometries to prevent GPU memory leaks ─────
  const prevGeomsRef = useRef<{
    g: THREE.BufferGeometry | null;
    e: THREE.BufferGeometry | null;
    t: THREE.BufferGeometry | null;
    p: THREE.BufferGeometry | null;
  }>({ g: null, e: null, t: null, p: null });
  useEffect(() => {
    if (prevGeomsRef.current.g && prevGeomsRef.current.g !== geometry) {
      prevGeomsRef.current.g.dispose();
    }
    if (prevGeomsRef.current.e && prevGeomsRef.current.e !== edgesGeometry) {
      prevGeomsRef.current.e.dispose();
    }
    if (prevGeomsRef.current.t && prevGeomsRef.current.t !== tetraEdgesGeometry) {
      prevGeomsRef.current.t.dispose();
    }
    if (prevGeomsRef.current.p && prevGeomsRef.current.p !== pointsGeometry) {
      prevGeomsRef.current.p.dispose();
    }
    prevGeomsRef.current = { g: geometry, e: edgesGeometry, t: tetraEdgesGeometry, p: pointsGeometry };
    return () => {
      geometry?.dispose();
      edgesGeometry?.dispose();
      tetraEdgesGeometry?.dispose();
      pointsGeometry?.dispose();
    };
  }, [edgesGeometry, geometry, pointsGeometry, tetraEdgesGeometry]);

  const showSurface = (renderMode === "surface" || renderMode === "surface+edges") && showSurfacePass;
  const showWire = renderMode === "surface+edges";
  const showVolumeWire = renderMode === "wireframe";
  const showPoints = renderMode === "points" && showPointsPass;

  const isTransparent = opacity < 100;
  const opacityVal = opacity / 100;
  const surfacePolicy =
    highlight
      ? RENDER_POLICIES_V2.selectionShell
      : isTransparent
        ? RENDER_POLICIES_V2.contextSurface
        : RENDER_POLICIES_V2.solidSurface;
  const edgePolicy = RENDER_POLICIES_V2.featureEdges;
  const hiddenEdgePolicy = RENDER_POLICIES_V2.hiddenEdges;
  const pointPolicy = RENDER_POLICIES_V2.points;
  const remapFaceIndex = useCallback((faceIndex: number | null | undefined) => {
    if (faceIndex == null) {
      return faceIndex ?? null;
    }
    if (!displayedToOriginalFace) {
      return faceIndex;
    }
    if (faceIndex < 0 || faceIndex >= displayedToOriginalFace.length) {
      return null;
    }
    return displayedToOriginalFace[faceIndex] ?? null;
  }, [displayedToOriginalFace]);
  const handleMappedFaceClick = useCallback((e: any) => {
    if (!onFaceClick) {
      return;
    }
    const mapped = remapFaceIndex(e?.faceIndex);
    if (mapped == null) {
      return;
    }
    e.faceIndex = mapped;
    onFaceClick(e);
  }, [onFaceClick, remapFaceIndex]);
  const handleMappedFaceHover = useCallback((e: any) => {
    if (!onFaceHover) {
      return;
    }
    const mapped = remapFaceIndex(e?.faceIndex);
    if (mapped == null) {
      return;
    }
    e.faceIndex = mapped;
    onFaceHover(e);
  }, [onFaceHover, remapFaceIndex]);
  const handleMappedFaceContextMenu = useCallback((e: any) => {
    if (!onFaceContextMenu) {
      return;
    }
    const mapped = remapFaceIndex(e?.faceIndex);
    if (mapped == null) {
      return;
    }
    e.faceIndex = mapped;
    onFaceContextMenu(e);
  }, [onFaceContextMenu, remapFaceIndex]);

  return (
    <group>
      {showSurface && (
        <mesh 
          geometry={geometry}
          renderOrder={surfacePolicy.renderOrder}
          onClick={enableGeometryPointerInteractions ? handleMappedFaceClick : undefined}
          onPointerOver={
            enableGeometryPointerInteractions && enableGeometryHoverInteractions
              ? handleMappedFaceHover
              : undefined
          }
          onPointerOut={
            enableGeometryPointerInteractions && enableGeometryHoverInteractions
              ? onFaceUnhover
              : undefined
          }
          onContextMenu={enableGeometryPointerInteractions ? handleMappedFaceContextMenu : undefined}
        >
          {enableGeometryNormals ? (
            <meshStandardMaterial
              vertexColors={enableGeometryVertexColors}
              color={enableGeometryVertexColors ? undefined : uniformColor ?? "#94a3b8"}
              side={surfacePolicy.side}
              flatShading={false}
              roughness={highlight ? 0.34 : 0.52}
              metalness={highlight ? 0.08 : 0.03}
              emissive={highlight ? resolvedHighlightEmissive : "#000000"}
              emissiveIntensity={highlight ? (usesNeutralSelectionHighlight ? 0.12 : 0.34) : 0.02}
              transparent={surfacePolicy.transparent}
              opacity={opacityVal}
              depthWrite={surfacePolicy.depthWrite}
              depthTest={surfacePolicy.depthTest}
              polygonOffset={surfacePolicy.polygonOffset}
              polygonOffsetFactor={surfacePolicy.polygonOffsetFactor}
              polygonOffsetUnits={surfacePolicy.polygonOffsetUnits}
            />
          ) : (
            <meshBasicMaterial
              vertexColors={enableGeometryVertexColors}
              color={enableGeometryVertexColors ? undefined : uniformColor ?? "#94a3b8"}
              side={surfacePolicy.side}
              transparent={surfacePolicy.transparent}
              opacity={opacityVal}
              depthWrite={surfacePolicy.depthWrite}
              depthTest={surfacePolicy.depthTest}
              polygonOffset={surfacePolicy.polygonOffset}
              polygonOffsetFactor={surfacePolicy.polygonOffsetFactor}
              polygonOffsetUnits={surfacePolicy.polygonOffsetUnits}
            />
          )}
        </mesh>
      )}
      
      {showWire && edgesGeometry && (
        <>
          {showSurfaceHiddenEdgesPass ? (
            <lineSegments geometry={edgesGeometry} renderOrder={hiddenEdgePolicy.renderOrder}>
              <lineBasicMaterial
                color={resolvedEdgeColor}
                opacity={(highlight ? 0.22 : 0.12) * opacityVal}
                transparent={hiddenEdgePolicy.transparent}
                depthWrite={hiddenEdgePolicy.depthWrite}
                depthTest={hiddenEdgePolicy.depthTest}
              />
            </lineSegments>
          ) : null}
          {showSurfaceVisibleEdgesPass ? (
            <lineSegments geometry={edgesGeometry} renderOrder={edgePolicy.renderOrder}>
              <lineBasicMaterial
                color={resolvedEdgeColor}
                opacity={(highlight ? 0.95 : 0.58) * opacityVal}
                transparent={edgePolicy.transparent}
                depthWrite={edgePolicy.depthWrite}
                depthTest={edgePolicy.depthTest}
              />
            </lineSegments>
          ) : null}
        </>
      )}

      {showVolumeWire && (tetraEdgesGeometry ?? edgesGeometry) != null && (
        <>
          {showVolumeHiddenEdgesPass ? (
            <lineSegments
              geometry={(tetraEdgesGeometry ?? edgesGeometry)!}
              renderOrder={hiddenEdgePolicy.renderOrder}
            >
              <lineBasicMaterial
                color={resolvedEdgeColor}
                opacity={(highlight ? 0.16 : 0.09) * opacityVal}
                transparent={hiddenEdgePolicy.transparent}
                depthWrite={hiddenEdgePolicy.depthWrite}
                depthTest={hiddenEdgePolicy.depthTest}
              />
            </lineSegments>
          ) : null}
          {showVolumeVisibleEdgesPass ? (
            <lineSegments
              geometry={(tetraEdgesGeometry ?? edgesGeometry)!}
              renderOrder={edgePolicy.renderOrder}
            >
              <lineBasicMaterial
                color={resolvedEdgeColor}
                opacity={(highlight ? 0.72 : 0.32) * opacityVal}
                transparent={edgePolicy.transparent}
                depthWrite={edgePolicy.depthWrite}
                depthTest={edgePolicy.depthTest}
              />
            </lineSegments>
          ) : null}
        </>
      )}

      {showPoints && pointsGeometry && (
        <points geometry={pointsGeometry} renderOrder={pointPolicy.renderOrder}>
          <pointsMaterial 
            vertexColors={enableGeometryVertexColors}
            color={enableGeometryVertexColors ? undefined : uniformColor ?? "#94a3b8"}
            size={maxDim * 0.008 * (highlight ? 1.15 : 1)}
            sizeAttenuation 
            transparent={pointPolicy.transparent}
            depthWrite={pointPolicy.depthWrite}
            depthTest={pointPolicy.depthTest}
            opacity={opacityVal} 
          />
        </points>
      )}
    </group>
  );
});
