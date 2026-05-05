import React, { memo, useMemo, useEffect, useRef, useCallback, useId } from "react";
import * as THREE from "three";
import type { FemMeshData, FemColorField, MeshDisplayScope, RenderMode } from "../fem/femMeshTypes";
import { computeFaceAspectRatios } from "./colorUtils";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { recordFrontendPerfSample } from "@/lib/debug/frontendPerfDebug";
import { resolveFemGeometryRenderPasses } from "./femGeometryRenderPasses";
import type { FemGeometryPassState } from "./femGeometryRenderPasses";
import {
  resolveFemGeometryResourceNeeds,
  useFemEdgeGeometryResource,
  useFemPointsGeometryResource,
  useFemSurfaceGeometryResource,
  VOLUME_EDGE_BYTE_BUDGET_DEFAULT,
} from "./femGeometryResources";
import { useBatchedInvalidate } from "./useBatchedInvalidate";
import { useFemVertexColorResource } from "./useFemVertexColorResource";
import { useFemGeometryMaterials } from "./useFemGeometryMaterials";
import { useFemGeometryDisposalAudit } from "./useFemGeometryDisposalAudit";

interface FemGeometryProps {
  meshData: FemMeshData;
  field: FemColorField;
  renderMode: RenderMode;
  renderPasses?: FemGeometryPassState;
  edgeScope?: MeshDisplayScope;
  pointsScope?: MeshDisplayScope;
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

function isValidNodeIndex(nodeIndex: number, nNodes: number): boolean {
  return Number.isInteger(nodeIndex) && nodeIndex >= 0 && nodeIndex < nNodes;
}

function hasFinitePositionTriples(values: Float32Array | ArrayLike<number>): boolean {
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (!Number.isFinite(value)) {
      return false;
    }
  }
  return true;
}

export function resolveFemClipPlane({
  enabled,
  axis,
  clipPos,
  size,
}: {
  enabled?: boolean;
  axis?: "x" | "y" | "z";
  clipPos?: number;
  size: THREE.Vector3;
}): THREE.Plane | null {
  if (!enabled) {
    return null;
  }
  const axisSize = axis === "y" ? size.y : axis === "z" ? size.z : size.x;
  if (!Number.isFinite(axisSize) || axisSize <= 0) {
    return null;
  }
  const resolvedClipPos =
    typeof clipPos === "number" && Number.isFinite(clipPos) ? clipPos : 50;
  const planePosition = ((resolvedClipPos / 100) - 0.5) * axisSize;
  const normal =
    axis === "y"
      ? new THREE.Vector3(0, -1, 0)
      : axis === "z"
        ? new THREE.Vector3(0, 0, -1)
        : new THREE.Vector3(-1, 0, 0);
  return new THREE.Plane(normal, planePosition);
}

/* ── Helper: compute vertex colors from field data ─────────────────── */
export const FemGeometry = memo(function FemGeometry({
  meshData,
  field,
  renderMode,
  renderPasses,
  edgeScope = "surface",
  pointsScope = "surface",
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
  const scheduleInvalidate = useBatchedInvalidate();
  const resourceOwner = `FemGeometry:${useId()}`;
  const {
    nodes,
    elements,
    boundaryFaces: meshBoundaryFaces,
    nNodes,
    nElements,
    fieldData,
    fieldRevision,
  } = meshData;
  const centerX = globalCenter?.x ?? null;
  const centerY = globalCenter?.y ?? null;
  const centerZ = globalCenter?.z ?? null;
  const hasFieldColormap = field !== "none";

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
  } = useFemSurfaceGeometryResource(() => {
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
    for (let i = 0; i < nNodes * 3; i++) positions[i] = Number(nodes[i] ?? 0);
    if (!hasFinitePositionTriples(positions)) {
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
    let foundBBoxNode = false;
    if (bboxNodeIndices) {
      for (const nodeIndex of bboxNodeIndices) {
        if (!isValidNodeIndex(nodeIndex, nNodes)) {
          continue;
        }
        const offset = nodeIndex * 3;
        const x = positions[offset], y = positions[offset + 1], z = positions[offset + 2];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        foundBBoxNode = true;
      }
    }
    if (!foundBBoxNode) {
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
    if (![subX, subY, subZ].every(Number.isFinite)) {
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
    for (let i = 0; i < nNodes * 3; i += 3) {
      positions[i] -= subX; positions[i + 1] -= subY; positions[i + 2] -= subZ;
    }
    mark("post-center");

    const isVolumetric = elements.length >= 4;
    const doShrink = Boolean(isVolumetric && shrinkFactor && shrinkFactor < 0.999);
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

    const activeElementOffsets = baseElementOffsets;
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
              clipped: false,
            },
          });
          prev = end;
        }
      }
      sample("topologyTotal", totalStart, {
        compacted: Boolean(vMap),
        clipped: false,
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
    displayBoundaryFaceIndices,
    displayElementIndices,
    enableGeometryCompaction,
    enableGeometryNormals,
    enableGeometryVertexColors,
    shrinkFactor,
  ]);

  const clippingPlanes = useMemo(() => {
    const plane = resolveFemClipPlane({
      enabled: clipEnabled,
      axis: clipAxis,
      clipPos,
      size: geoSize,
    });
    return plane ? [plane] : null;
  }, [clipAxis, clipEnabled, clipPos, geoSize.x, geoSize.y, geoSize.z]);

  const geometryResourceNeeds = resolveFemGeometryResourceNeeds({
    renderMode,
    renderPasses,
    edgeScope,
  });

  const { edgesGeometry, tetraEdgesGeometry } = useFemEdgeGeometryResource({
    needs: geometryResourceNeeds,
    surfaceGeometry: geometry,
    nElements,
    nNodes,
    elements,
    nodes,
    centerX,
    centerY,
    centerZ,
    volumeEdgeMaxBytes: VOLUME_EDGE_BYTE_BUDGET_DEFAULT,
  });

  // Points material uses vertexColors={false} — no color attribute needed on pointsGeometry.
  const { pointsGeometry, pointsVertexMap } = useFemPointsGeometryResource({
    needs: geometryResourceNeeds,
    pointsScope,
    surfaceGeometry: geometry,
    vertexMap,
    nNodes,
    enableGeometryVertexColors: false,
    positions: _positions,
    boundaryFaces: _resolvedBoundaryFaces,
    customBoundaryFaces,
    activeElementOffsets: _activeElementOffsets,
    elements,
    nElements,
    preferredFaceIndices: _preferredFaceIndices,
  });

  useFemVertexColorResource({
    customBoundaryFaces,
    field,
    fieldData,
    fieldRevision,
    geometry,
    meshData,
    nElements,
    nNodes,
    nodes,
    pointsGeometry,
    pointsVertexMap,
    qualityPerFace,
    scheduleInvalidate,
    sharedBaseVertexColors,
    uniformColor,
    vertexMap,
    enableGeometryVertexColors,
  });

  // ── Notify parent about geometry center (proper useEffect, not useMemo side-effect) ─
  const onGeometryCenterRef = useRef(onGeometryCenter);
  onGeometryCenterRef.current = onGeometryCenter;
  useEffect(() => {
    if (maxDim > 0 && onGeometryCenterRef.current) {
      onGeometryCenterRef.current(center, maxDim, geoSize);
    }
  }, [center, maxDim, geoSize]);

  // ── Resource tracking / disposal (extracted to focused hook) ─────────────────
  useFemGeometryDisposalAudit({
    resourceOwner,
    geometry,
    edgesGeometry,
    tetraEdgesGeometry,
    pointsGeometry,
  });

  const {
    showSurface,
    showWireOnlyEdges,
    showWireOnlyMesh,
    showSurfaceEdges,
    showSurfaceEdgeFallback,
    showPoints,
    showMeshEdges,
  } = resolveFemGeometryRenderPasses({
    // NOTE: showMeshEdges is needed for material params below
    renderMode,
    renderPasses,
    edgeScope,
    pointsScope,
    hasGeometry: (geometry?.getAttribute("position")?.count ?? 0) > 0,
    hasEdgesGeometry: edgesGeometry != null,
    hasTetraEdgesGeometry: tetraEdgesGeometry != null,
    showSurfacePass,
    showSurfaceHiddenEdgesPass,
    showSurfaceVisibleEdgesPass,
    showPointsPass,
  });

  useEffect(() => {
    if (!FRONTEND_DIAGNOSTIC_FLAGS.femViewport.enableGeometryRenderLogging) {
      return;
    }
    const positionAttribute = geometry?.getAttribute("position") as THREE.BufferAttribute | undefined;
    const colorAttribute = geometry?.getAttribute("color") as THREE.BufferAttribute | undefined;
    console.debug("[fem-geometry]", JSON.stringify({
      renderMode,
      edgeScope,
      pointsScope,
      field,
      passes: {
        explicit: renderPasses ?? null,
        showSurface,
        showWireOnlyEdges,
        showWireOnlyMesh,
        showSurfaceEdges,
        showSurfaceEdgeFallback,
        showPoints,
        showMeshEdges,
      },
      input: {
        nNodes,
        nElements,
        boundaryFaces: Math.floor(meshBoundaryFaces.length / 3),
        customBoundaryFaces: customBoundaryFaces?.length ?? null,
        displayBoundaryFaceIndices: Array.isArray(displayBoundaryFaceIndices)
          ? displayBoundaryFaceIndices.length
          : "all",
        displayElementIndices: Array.isArray(displayElementIndices)
          ? displayElementIndices.length
          : "all",
        activeMask: meshData.activeMask?.length ?? null,
        quantityDomain: meshData.quantityDomain,
        fieldRevision,
        showSurfacePass,
        showPointsPass,
      },
      geometry: {
        hasGeometry: Boolean(geometry),
        vertexCount: positionAttribute?.count ?? 0,
        colorCount: colorAttribute?.count ?? 0,
        indexCount: geometry?.index?.count ?? 0,
        hasEdgesGeometry: Boolean(edgesGeometry),
        hasTetraEdgesGeometry: Boolean(tetraEdgesGeometry),
        hasPointsGeometry: Boolean(pointsGeometry),
      },
      material: {
        opacity,
        uniformColor,
        edgeColor,
        highlight,
        enableGeometryVertexColors,
        enableGeometryNormals,
      },
    }));
  }, [
    customBoundaryFaces,
    displayBoundaryFaceIndices,
    displayElementIndices,
    edgeColor,
    edgeScope,
    edgesGeometry,
    enableGeometryNormals,
    enableGeometryVertexColors,
    field,
    fieldRevision,
    geometry,
    highlight,
    meshBoundaryFaces.length,
    meshData.activeMask,
    meshData.quantityDomain,
    nElements,
    nNodes,
    opacity,
    pointsGeometry,
    pointsScope,
    renderMode,
    renderPasses,
    showPointsPass,
    showPoints,
    showSurfacePass,
    showSurface,
    showSurfaceEdgeFallback,
    showSurfaceEdges,
    showWireOnlyEdges,
    showWireOnlyMesh,
    showMeshEdges,
    tetraEdgesGeometry,
    uniformColor,
  ]);

  const showVolumeWire = false;
  const showVolumeEdgeFallback =
    showVolumeWire &&
    (tetraEdgesGeometry ?? edgesGeometry) != null &&
    !showVolumeHiddenEdgesPass &&
    !showVolumeVisibleEdgesPass;
  const showSelectionWireOverlay = highlight && showSurface && edgesGeometry != null;

  // ── Material params (extracted to focused hook) ─────────────────────────────
  const {
    opacityVal,
    isTransparent,
    resolvedEdgeColor,
    surfacePolicy,
    edgePolicy,
    hiddenEdgePolicy,
    pointPolicy,
    selectionEdgePolicy,
  } = useFemGeometryMaterials({
    opacity,
    highlight,
    uniformColor,
    edgeColor,
    showMeshEdges,
    hasFieldColormap,
  });

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
              roughness={0.52}
              metalness={0.03}
              emissive="#000000"
              emissiveIntensity={0.02}
              transparent={surfacePolicy.transparent}
              opacity={opacityVal}
              depthWrite={surfacePolicy.depthWrite}
              depthTest={surfacePolicy.depthTest}
              polygonOffset={surfacePolicy.polygonOffset}
              polygonOffsetFactor={surfacePolicy.polygonOffsetFactor}
              polygonOffsetUnits={surfacePolicy.polygonOffsetUnits}
              clippingPlanes={clippingPlanes}
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
              clippingPlanes={clippingPlanes}
            />
          )}
        </mesh>
      )}
      
      {showWireOnlyEdges && edgesGeometry ? (
        <lineSegments geometry={edgesGeometry} renderOrder={edgePolicy.renderOrder} frustumCulled={false}>
          <lineBasicMaterial
            color={resolvedEdgeColor}
            opacity={highlight ? 0.98 : 0.86}
            transparent
            depthWrite={false}
            depthTest
            clippingPlanes={clippingPlanes}
          />
        </lineSegments>
      ) : null}

      {showMeshEdges && tetraEdgesGeometry ? (
        <lineSegments geometry={tetraEdgesGeometry} renderOrder={edgePolicy.renderOrder + 5} frustumCulled={false}>
          <lineBasicMaterial
            color={resolvedEdgeColor}
            opacity={highlight ? 0.65 : 0.42}
            transparent
            depthWrite={false}
            depthTest={true}
            clippingPlanes={clippingPlanes}
          />
        </lineSegments>
      ) : null}

      {showMeshEdges && !tetraEdgesGeometry && edgesGeometry ? (
        <lineSegments geometry={edgesGeometry} renderOrder={edgePolicy.renderOrder + 5} frustumCulled={false}>
          <lineBasicMaterial
            color={resolvedEdgeColor}
            opacity={highlight ? 0.65 : 0.42}
            transparent
            depthWrite={false}
            depthTest={true}
            clippingPlanes={clippingPlanes}
          />
        </lineSegments>
      ) : null}

      {showWireOnlyMesh ? (
        <mesh geometry={geometry} renderOrder={edgePolicy.renderOrder} frustumCulled={false}>
          <meshBasicMaterial
            color={resolvedEdgeColor}
            wireframe
            transparent
            opacity={highlight ? 0.98 : 0.86}
            depthWrite={false}
            depthTest
            side={THREE.DoubleSide}
            clippingPlanes={clippingPlanes}
          />
        </mesh>
      ) : null}

      {showSurfaceEdges && edgesGeometry && (
        <>
          {showSurfaceEdgeFallback ? (
            <lineSegments geometry={edgesGeometry} renderOrder={edgePolicy.renderOrder} frustumCulled={false}>
              <lineBasicMaterial
                color={resolvedEdgeColor}
                opacity={(highlight ? 0.95 : 0.58) * opacityVal}
                transparent={edgePolicy.transparent}
                depthWrite={edgePolicy.depthWrite}
                depthTest={edgePolicy.depthTest}
                clippingPlanes={clippingPlanes}
              />
            </lineSegments>
          ) : null}
          {showSurfaceHiddenEdgesPass ? (
            <lineSegments geometry={edgesGeometry} renderOrder={hiddenEdgePolicy.renderOrder} frustumCulled={false}>
              <lineBasicMaterial
                color={resolvedEdgeColor}
                opacity={(highlight ? 0.22 : 0.12) * opacityVal}
                transparent={hiddenEdgePolicy.transparent}
                depthWrite={hiddenEdgePolicy.depthWrite}
                depthTest={hiddenEdgePolicy.depthTest}
                clippingPlanes={clippingPlanes}
              />
            </lineSegments>
          ) : null}
          {showSurfaceVisibleEdgesPass ? (
            <lineSegments geometry={edgesGeometry} renderOrder={edgePolicy.renderOrder} frustumCulled={false}>
              <lineBasicMaterial
                color={resolvedEdgeColor}
                opacity={(highlight ? 0.95 : 0.58) * opacityVal}
                transparent={edgePolicy.transparent}
                depthWrite={edgePolicy.depthWrite}
                depthTest={edgePolicy.depthTest}
                clippingPlanes={clippingPlanes}
              />
            </lineSegments>
          ) : null}
        </>
      )}

      {showSelectionWireOverlay ? (
        <lineSegments geometry={edgesGeometry!} renderOrder={selectionEdgePolicy.renderOrder} frustumCulled={false}>
          <lineBasicMaterial
            color={resolvedEdgeColor}
            opacity={0.98}
            transparent={selectionEdgePolicy.transparent}
            depthWrite={selectionEdgePolicy.depthWrite}
            depthTest={false}
            clippingPlanes={clippingPlanes}
          />
        </lineSegments>
      ) : null}

      {showVolumeWire && (tetraEdgesGeometry ?? edgesGeometry) != null && (
        <>
          {showVolumeEdgeFallback ? (
            <lineSegments
              geometry={(tetraEdgesGeometry ?? edgesGeometry)!}
              renderOrder={edgePolicy.renderOrder}
              frustumCulled={false}
            >
              <lineBasicMaterial
                color={resolvedEdgeColor}
                opacity={(highlight ? 0.98 : 0.78) * Math.max(opacityVal, 0.65)}
                transparent={edgePolicy.transparent}
                depthWrite={edgePolicy.depthWrite}
                depthTest={false}
                clippingPlanes={clippingPlanes}
              />
            </lineSegments>
          ) : null}
          {showVolumeHiddenEdgesPass ? (
            <lineSegments
              geometry={(tetraEdgesGeometry ?? edgesGeometry)!}
              renderOrder={hiddenEdgePolicy.renderOrder}
              frustumCulled={false}
            >
              <lineBasicMaterial
                color={resolvedEdgeColor}
                opacity={(highlight ? 0.16 : 0.09) * opacityVal}
                transparent={hiddenEdgePolicy.transparent}
                depthWrite={hiddenEdgePolicy.depthWrite}
                depthTest={hiddenEdgePolicy.depthTest}
                clippingPlanes={clippingPlanes}
              />
            </lineSegments>
          ) : null}
          {showVolumeVisibleEdgesPass ? (
            <lineSegments
              geometry={(tetraEdgesGeometry ?? edgesGeometry)!}
              renderOrder={edgePolicy.renderOrder}
              frustumCulled={false}
            >
              <lineBasicMaterial
                color={resolvedEdgeColor}
                opacity={(highlight ? 0.72 : 0.32) * opacityVal}
                transparent={edgePolicy.transparent}
                depthWrite={edgePolicy.depthWrite}
                depthTest={edgePolicy.depthTest}
                clippingPlanes={clippingPlanes}
              />
            </lineSegments>
          ) : null}
        </>
      )}

      {showPoints && pointsGeometry && (
        <points geometry={pointsGeometry} renderOrder={pointPolicy.renderOrder} frustumCulled={false}>
          <pointsMaterial 
            vertexColors={false}
            color={highlight ? "#f8fafc" : resolvedEdgeColor}
            size={highlight ? 6 : 5}
            sizeAttenuation={false}
            transparent={pointPolicy.transparent}
            depthWrite={pointPolicy.depthWrite}
            depthTest={pointPolicy.depthTest}
            opacity={Math.max(opacityVal, 0.82)} 
            clippingPlanes={clippingPlanes}
          />
        </points>
      )}
    </group>
  );
});
