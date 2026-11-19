import {
  AnimationClip,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  InterpolateDiscrete,
  InterpolateLinear,
  LineBasicMaterial,
  LineSegments,
  LinearSRGBColorSpace,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NumberKeyframeTrack,
  Scene,
  VectorKeyframeTrack,
  type KeyframeTrack,
  type Material,
} from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";

import { sampleFdmSpatialCellIndices } from "@/shared/domain/mesh/fdmDisplaySampling";

import {
  buildAnimatedArrowMeshesAndTracks,
  buildMergedStaticArrowGeometry,
  computeAutoArrowBaseLengthM,
  samplePointIndicesSpatially,
} from "./export3dArrowGeometry";
import {
  evaluateComplexFieldArray,
  evaluateComplexHarmonicQuadratureBasis,
  evaluateFieldColorsLinear,
  normalizeExport3DColorMode,
  normalizeExport3DScalarPalette,
  resolveFieldScalarRange,
  srgbToLinearRgb,
} from "./export3dColorEvaluator";
import {
  defaultCoordinateScaleForFormat,
  resolveBoundsFromTargets,
  resolveCoordinateTransform,
  resolveEffectiveAnimationMode,
  sanitizeGlTfNodeName,
  sanitizeJsonExtrasValue,
  throwIfExportAborted,
  transformPositionByCoordinateTransform,
  type Export3DColorMode,
  type Export3DComplexFieldInput,
  type Export3DCoordinateTransform,
  type Export3DFdmGridTargetInput,
  type Export3DFemMeshTargetInput,
  type Export3DFieldInput,
  type Export3DIndexArray,
  type Export3DMaterialStyle,
  type Export3DModelOptions,
  type Export3DModelRequest,
  type Export3DNumericArray,
  type Export3DRgbTuple,
  type Export3DScalarPalette,
  type Export3DScalarRange,
  type Export3DStats,
  type Export3DSurfaceDisplacementComponent,
  type Export3DSurfaceGeometryTargetInput,
  type Export3DTargetInput,
  type Export3DVtkVolumeCells,
} from "./export3dTypes";
import {
  buildSurfaceFeatureEdgePositions,
  computeFdmCellCentersM,
  extractVoxelExteriorShell,
} from "./export3dVoxelShell";

const DEFAULT_WIREFRAME_SRGB: Export3DRgbTuple = [0.15, 0.18, 0.24];
const DEFAULT_MONOCHROME_SRGB: Export3DRgbTuple = [0.75, 0.78, 0.85];
const TWO_PI = Math.PI * 2;

export interface BuildExport3DGltfResult {
  bytes: Uint8Array;
  text?: string;
  coordinateTransform: Export3DCoordinateTransform;
  stats: Export3DStats;
  warnings: string[];
}

interface PreparedTargetGeometry {
  positionsM: Float32Array;
  normals: Float32Array;
  indices: Uint32Array | null;
  vertexCount: number;
  triangleCount: number;
  vertexToFieldTargetIndices: Uint32Array | null;
  domainEntryCount: number;
  compactActiveIndexMap: Map<number, number> | null;
  allEntryPositionsM: Float32Array | null;
  arrowCandidateIndices: Uint32Array;
  arrowAnchorPositionsM: Float32Array;
  cellSizeM: readonly [number, number, number] | null;
  boundsSizeM: [number, number, number];
}

const VOLUME_CELL_FACES: Readonly<Record<number, readonly (readonly number[])[]>> = {
  // Fullmag internal cell types (viewport3dTopologyCells.ts)
  1: [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]],
  2: [[0, 1, 2], [3, 5, 4], [0, 3, 4, 1], [1, 4, 5, 2], [2, 5, 3, 0]],
  3: [[0, 3, 2, 1], [0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]],
  4: [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ],
  // Standard VTK cell types
  5: [[0, 1, 2]],
  9: [[0, 1, 2, 3]],
  10: [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]],
  12: [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ],
  13: [[0, 1, 2], [3, 5, 4], [0, 3, 4, 1], [1, 4, 5, 2], [2, 5, 3, 0]],
  14: [[0, 3, 2, 1], [0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]],
};

export function extractVolumeBoundarySurfaceIndices(
  volumeCells: Export3DVtkVolumeCells,
  positionsM: Export3DNumericArray,
): Uint32Array {
  const nodeCount = Math.floor(positionsM.length / 3);
  const hasExplicitCsr = Boolean(
    volumeCells.cellOffsets &&
      volumeCells.cellTypes &&
      volumeCells.cellOffsets.length === volumeCells.cellTypes.length + 1,
  );
  const cellCount = hasExplicitCsr
    ? volumeCells.cellTypes!.length
    : (volumeCells.cellCount ?? Math.floor(volumeCells.cellNodes.length / 4));

  interface BoundaryCandidate {
    nodes: number[];
    cellNodes: number[];
    count: number;
  }

  const faceMap = new Map<string, BoundaryCandidate>();
  for (let c = 0; c < cellCount; c += 1) {
    const start = hasExplicitCsr ? (volumeCells.cellOffsets![c] ?? 0) : c * 4;
    const end = hasExplicitCsr ? (volumeCells.cellOffsets![c + 1] ?? start) : start + 4;
    const cType = hasExplicitCsr ? (volumeCells.cellTypes![c] ?? 1) : 1;
    const localFaces = VOLUME_CELL_FACES[cType];
    if (!localFaces) continue;

    const cNodes: number[] = [];
    for (let k = start; k < end; k += 1) {
      cNodes.push(Number(volumeCells.cellNodes[k] ?? 0));
    }

    for (const local of localFaces) {
      let valid = true;
      const fNodes: number[] = [];
      for (const localIdx of local) {
        const globalNode = cNodes[localIdx];
        if (globalNode === undefined || globalNode < 0 || globalNode >= nodeCount) {
          valid = false;
          break;
        }
        fNodes.push(globalNode);
      }
      if (!valid || fNodes.length < 3) continue;
      const key = [...fNodes].sort((a, b) => a - b).join("_");
      const existing = faceMap.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        faceMap.set(key, { nodes: fNodes, cellNodes: cNodes, count: 1 });
      }
    }
  }

  const triangles: number[] = [];
  for (const candidate of faceMap.values()) {
    if (candidate.count !== 1) continue;
    const f = [...candidate.nodes];
    // Orient outward using opposing interior node when available.
    const faceSet = new Set(f);
    const interiorNode = candidate.cellNodes.find((n) => !faceSet.has(n));
    if (interiorNode !== undefined && f.length >= 3) {
      const a = f[0]!;
      const b = f[1]!;
      const c = f[2]!;
      const ax = positionsM[a * 3] ?? 0;
      const ay = positionsM[a * 3 + 1] ?? 0;
      const az = positionsM[a * 3 + 2] ?? 0;
      const abx = (positionsM[b * 3] ?? 0) - ax;
      const aby = (positionsM[b * 3 + 1] ?? 0) - ay;
      const abz = (positionsM[b * 3 + 2] ?? 0) - az;
      const acx = (positionsM[c * 3] ?? 0) - ax;
      const acy = (positionsM[c * 3 + 1] ?? 0) - ay;
      const acz = (positionsM[c * 3 + 2] ?? 0) - az;
      const nx = aby * acz - abz * acy;
      const ny = abz * acx - abx * acz;
      const nz = abx * acy - aby * acx;
      const ox = (positionsM[interiorNode * 3] ?? 0) - ax;
      const oy = (positionsM[interiorNode * 3 + 1] ?? 0) - ay;
      const oz = (positionsM[interiorNode * 3 + 2] ?? 0) - az;
      if (nx * ox + ny * oy + nz * oz > 0) {
        f.reverse();
      }
    }
    for (let i = 1; i + 1 < f.length; i += 1) {
      triangles.push(f[0]!, f[i]!, f[i + 1]!);
    }
  }
  return Uint32Array.from(triangles);
}

export function computeTriangleVertexNormals(
  positions: Export3DNumericArray,
  indices: Export3DIndexArray | null | undefined,
): Float32Array {
  const vertexCount = Math.floor(positions.length / 3);
  const normals = new Float32Array(vertexCount * 3);
  const triCount = indices
    ? Math.floor(indices.length / 3)
    : Math.floor(vertexCount / 3);

  for (let tri = 0; tri < triCount; tri += 1) {
    const i0 = indices ? Number(indices[tri * 3] ?? 0) : tri * 3;
    const i1 = indices ? Number(indices[tri * 3 + 1] ?? 0) : tri * 3 + 1;
    const i2 = indices ? Number(indices[tri * 3 + 2] ?? 0) : tri * 3 + 2;
    if (
      i0 < 0 ||
      i1 < 0 ||
      i2 < 0 ||
      i0 >= vertexCount ||
      i1 >= vertexCount ||
      i2 >= vertexCount
    ) {
      continue;
    }

    const ax = positions[i0 * 3] ?? 0;
    const ay = positions[i0 * 3 + 1] ?? 0;
    const az = positions[i0 * 3 + 2] ?? 0;
    const bx = positions[i1 * 3] ?? 0;
    const by = positions[i1 * 3 + 1] ?? 0;
    const bz = positions[i1 * 3 + 2] ?? 0;
    const cx = positions[i2 * 3] ?? 0;
    const cy = positions[i2 * 3 + 1] ?? 0;
    const cz = positions[i2 * 3 + 2] ?? 0;

    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const acx = cx - ax;
    const acy = cy - ay;
    const acz = cz - az;

    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;

    normals[i0 * 3] += nx;
    normals[i0 * 3 + 1] += ny;
    normals[i0 * 3 + 2] += nz;
    normals[i1 * 3] += nx;
    normals[i1 * 3 + 1] += ny;
    normals[i1 * 3 + 2] += nz;
    normals[i2 * 3] += nx;
    normals[i2 * 3 + 1] += ny;
    normals[i2 * 3 + 2] += nz;
  }

  for (let i = 0; i < vertexCount; i += 1) {
    const base = i * 3;
    const len = Math.hypot(normals[base]!, normals[base + 1]!, normals[base + 2]!);
    if (len > 0 && Number.isFinite(len)) {
      normals[base] /= len;
      normals[base + 1] /= len;
      normals[base + 2] /= len;
    } else {
      normals[base] = 0;
      normals[base + 1] = 0;
      normals[base + 2] = 1;
    }
  }

  return normals;
}

function toFloat32Array(arr: Export3DNumericArray): Float32Array {
  return arr instanceof Float32Array ? new Float32Array(arr) : Float32Array.from(arr);
}

function toUint32Array(arr: Export3DIndexArray): Uint32Array {
  return arr instanceof Uint32Array ? arr : Uint32Array.from(arr);
}

function computePositionBoundsSize(positions: Float32Array): [number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  const count = Math.floor(positions.length / 3);
  for (let i = 0; i < count; i += 1) {
    const x = positions[i * 3]!;
    const y = positions[i * 3 + 1]!;
    const z = positions[i * 3 + 2]!;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX)) return [0, 0, 0];
  return [
    Math.max(0, maxX - minX),
    Math.max(0, maxY - minY),
    Math.max(0, maxZ - minZ),
  ];
}

function expandCellFieldSurfaceToFaceVertices(
  positionsM: Float32Array,
  indices: Uint32Array | null,
  normals: Float32Array | null,
): {
  positionsM: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  faceCellIndices: Uint32Array;
} {
  const triCount = indices
    ? Math.floor(indices.length / 3)
    : Math.floor(positionsM.length / 9);
  const outPositions = new Float32Array(triCount * 9);
  const outNormals = new Float32Array(triCount * 9);
  const outIndices = new Uint32Array(triCount * 3);
  const faceCellIndices = new Uint32Array(triCount * 3);

  for (let tri = 0; tri < triCount; tri += 1) {
    const src0 = indices ? indices[tri * 3]! : tri * 3;
    const src1 = indices ? indices[tri * 3 + 1]! : tri * 3 + 1;
    const src2 = indices ? indices[tri * 3 + 2]! : tri * 3 + 2;
    const srcs = [src0, src1, src2] as const;

    const ax = positionsM[src0 * 3] ?? 0;
    const ay = positionsM[src0 * 3 + 1] ?? 0;
    const az = positionsM[src0 * 3 + 2] ?? 0;
    const bx = positionsM[src1 * 3] ?? 0;
    const by = positionsM[src1 * 3 + 1] ?? 0;
    const bz = positionsM[src1 * 3 + 2] ?? 0;
    const cx = positionsM[src2 * 3] ?? 0;
    const cy = positionsM[src2 * 3 + 1] ?? 0;
    const cz = positionsM[src2 * 3 + 2] ?? 0;
    let fnx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let fny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let fnz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const len = Math.hypot(fnx, fny, fnz);
    if (len > 0) {
      fnx /= len;
      fny /= len;
      fnz /= len;
    } else {
      fnx = 0;
      fny = 0;
      fnz = 1;
    }

    for (let corner = 0; corner < 3; corner += 1) {
      const outV = tri * 3 + corner;
      const srcV = srcs[corner]!;
      outPositions[outV * 3] = positionsM[srcV * 3] ?? 0;
      outPositions[outV * 3 + 1] = positionsM[srcV * 3 + 1] ?? 0;
      outPositions[outV * 3 + 2] = positionsM[srcV * 3 + 2] ?? 0;
      if (normals && srcV * 3 + 2 < normals.length) {
        outNormals[outV * 3] = normals[srcV * 3]!;
        outNormals[outV * 3 + 1] = normals[srcV * 3 + 1]!;
        outNormals[outV * 3 + 2] = normals[srcV * 3 + 2]!;
      } else {
        outNormals[outV * 3] = fnx;
        outNormals[outV * 3 + 1] = fny;
        outNormals[outV * 3 + 2] = fnz;
      }
      outIndices[outV] = outV;
      faceCellIndices[outV] = tri;
    }
  }

  return {
    positionsM: outPositions,
    normals: outNormals,
    indices: outIndices,
    faceCellIndices,
  };
}

function fieldEntryCount(field: Export3DFieldInput): number {
  const nComp = field.componentCount;
  if (field.kind === "real") return Math.floor(field.values.length / nComp);
  if (field.kind === "complex") {
    return Math.floor(
      Math.min(field.realValues.length, field.imagValues.length) / nComp,
    );
  }
  return field.frames.length > 0
    ? Math.floor(field.frames[0]!.values.length / nComp)
    : 0;
}

function prepareTargetGeometry(
  target: Export3DTargetInput,
  options: Export3DModelOptions,
): PreparedTargetGeometry {
  if (target.kind === "fdm_grid") {
    return prepareFdmTargetGeometry(target, options);
  }
  return prepareMeshTargetGeometry(target, options);
}

function prepareFdmTargetGeometry(
  target: Export3DFdmGridTargetInput,
  options: Export3DModelOptions,
): PreparedTargetGeometry {
  const originM = target.originM ?? [0, 0, 0];
  const shell = extractVoxelExteriorShell({
    gridShape: target.gridShape,
    cellSizeM: target.cellSizeM,
    originM,
    activeMask: target.activeMask,
    regionIds: target.regionIds,
  });
  const totalCells =
    target.gridShape[0] * target.gridShape[1] * target.gridShape[2];

  let compactActiveIndexMap: Map<number, number> | null = null;
  if (
    target.field &&
    !target.field.nodeIndices &&
    shell.activeCellCount < totalCells &&
    fieldEntryCount(target.field) === shell.activeCellCount
  ) {
    compactActiveIndexMap = new Map<number, number>();
    for (let i = 0; i < shell.activeCellIndices.length; i += 1) {
      compactActiveIndexMap.set(shell.activeCellIndices[i]!, i);
    }
  }

  const maxVectors = Math.max(
    1,
    Math.floor(
      options.maxVectors ??
        (resolveEffectiveAnimationMode([target], options) === "static" ? 1024 : 256),
    ),
  );
  const vectorScope = options.vectorScope ?? "full";
  const candidateCells =
    vectorScope === "surface" ? shell.surfaceCellIndices : shell.activeCellIndices;
  const arrowCandidateIndices = sampleFdmSpatialCellIndices(
    candidateCells,
    target.gridShape,
    maxVectors,
  );
  const arrowAnchorPositionsM = computeFdmCellCentersM(
    target.gridShape,
    target.cellSizeM,
    originM,
    arrowCandidateIndices,
  );
  const allEntryPositionsM =
    target.field?.kind === "complex" && target.field.wavevectorKf
      ? computeFdmCellCentersM(target.gridShape, target.cellSizeM, originM)
      : null;

  return {
    positionsM: shell.positionsM,
    normals: shell.normals,
    indices: shell.indices,
    vertexCount: shell.vertexCount,
    triangleCount: shell.triangleCount,
    vertexToFieldTargetIndices: shell.vertexCellIndices,
    domainEntryCount: totalCells,
    compactActiveIndexMap,
    allEntryPositionsM,
    arrowCandidateIndices,
    arrowAnchorPositionsM,
    cellSizeM: target.cellSizeM,
    boundsSizeM: [
      shell.boundsMaxM[0] - shell.boundsMinM[0],
      shell.boundsMaxM[1] - shell.boundsMinM[1],
      shell.boundsMaxM[2] - shell.boundsMinM[2],
    ],
  };
}

function prepareMeshTargetGeometry(
  target: Export3DFemMeshTargetInput | Export3DSurfaceGeometryTargetInput,
  options: Export3DModelOptions,
): PreparedTargetGeometry {
  const rawPositions = toFloat32Array(target.positionsM);
  const rawNodeCount = Math.floor(rawPositions.length / 3);
  const rawIndicesInput =
    target.kind === "fem_mesh" ? target.surfaceIndices : target.indices;
  let surfaceIndices = rawIndicesInput ? toUint32Array(rawIndicesInput) : null;
  if (!surfaceIndices && target.kind === "fem_mesh" && target.volumeCells) {
    surfaceIndices = extractVolumeBoundarySurfaceIndices(
      target.volumeCells,
      rawPositions,
    );
  }

  const rawNormals = target.normals ? toFloat32Array(target.normals) : null;
  const isCellField = target.field?.location === "cell";

  let positionsM = rawPositions;
  let indices = surfaceIndices;
  let normals =
    rawNormals && rawNormals.length === rawPositions.length
      ? rawNormals
      : computeTriangleVertexNormals(rawPositions, surfaceIndices);
  let vertexToFieldTargetIndices: Uint32Array | null = null;
  let domainEntryCount = rawNodeCount;

  if (isCellField) {
    const expanded = expandCellFieldSurfaceToFaceVertices(
      rawPositions,
      surfaceIndices,
      normals,
    );
    positionsM = expanded.positionsM;
    normals = expanded.normals;
    indices = expanded.indices;
    vertexToFieldTargetIndices = expanded.faceCellIndices;
    domainEntryCount = Math.floor(expanded.indices.length / 3);
  }

  const vertexCount = Math.floor(positionsM.length / 3);
  const triangleCount = indices
    ? Math.floor(indices.length / 3)
    : Math.floor(vertexCount / 3);

  const maxVectors = Math.max(
    1,
    Math.floor(
      options.maxVectors ??
        (resolveEffectiveAnimationMode([target], options) === "static" ? 1024 : 256),
    ),
  );
  const vectorScope = options.vectorScope ?? "full";
  let candidatePool: Uint32Array | null = null;

  if (isCellField) {
    const faceCenters = new Float32Array(domainEntryCount * 3);
    for (let tri = 0; tri < domainEntryCount; tri += 1) {
      const a = (tri * 3) * 3;
      const b = (tri * 3 + 1) * 3;
      const c = (tri * 3 + 2) * 3;
      faceCenters[tri * 3] = (positionsM[a]! + positionsM[b]! + positionsM[c]!) / 3;
      faceCenters[tri * 3 + 1] =
        (positionsM[a + 1]! + positionsM[b + 1]! + positionsM[c + 1]!) / 3;
      faceCenters[tri * 3 + 2] =
        (positionsM[a + 2]! + positionsM[b + 2]! + positionsM[c + 2]!) / 3;
    }
    const arrowCandidateIndices = samplePointIndicesSpatially(
      faceCenters,
      maxVectors,
      target.field?.nodeIndices,
    );
    const arrowAnchorPositionsM = new Float32Array(arrowCandidateIndices.length * 3);
    for (let i = 0; i < arrowCandidateIndices.length; i += 1) {
      const cell = arrowCandidateIndices[i]!;
      arrowAnchorPositionsM[i * 3] = faceCenters[cell * 3]!;
      arrowAnchorPositionsM[i * 3 + 1] = faceCenters[cell * 3 + 1]!;
      arrowAnchorPositionsM[i * 3 + 2] = faceCenters[cell * 3 + 2]!;
    }
    return {
      positionsM,
      normals,
      indices,
      vertexCount,
      triangleCount,
      vertexToFieldTargetIndices,
      domainEntryCount,
      compactActiveIndexMap: null,
      allEntryPositionsM: faceCenters,
      arrowCandidateIndices,
      arrowAnchorPositionsM,
      cellSizeM: null,
      boundsSizeM: computePositionBoundsSize(positionsM),
    };
  }

  if (target.field?.nodeIndices) {
    const baseSet = toUint32Array(target.field.nodeIndices);
    if (vectorScope === "surface" && indices) {
      const surfaceSet = new Set<number>();
      for (let i = 0; i < indices.length; i += 1) {
        surfaceSet.add(indices[i]!);
      }
      candidatePool = Uint32Array.from(
        Array.from(baseSet).filter((idx) => surfaceSet.has(idx)),
      );
    } else {
      candidatePool = baseSet;
    }
  } else if (vectorScope === "surface" && indices) {
    const surfaceSet = new Set<number>();
    for (let i = 0; i < indices.length; i += 1) {
      surfaceSet.add(indices[i]!);
    }
    candidatePool = Uint32Array.from(surfaceSet);
  }

  const arrowCandidateIndices = samplePointIndicesSpatially(
    rawPositions,
    maxVectors,
    candidatePool,
  );
  const arrowAnchorPositionsM = new Float32Array(arrowCandidateIndices.length * 3);
  for (let i = 0; i < arrowCandidateIndices.length; i += 1) {
    const vIdx = arrowCandidateIndices[i]!;
    arrowAnchorPositionsM[i * 3] = rawPositions[vIdx * 3]!;
    arrowAnchorPositionsM[i * 3 + 1] = rawPositions[vIdx * 3 + 1]!;
    arrowAnchorPositionsM[i * 3 + 2] = rawPositions[vIdx * 3 + 2]!;
  }

  return {
    positionsM,
    normals,
    indices,
    vertexCount,
    triangleCount,
    vertexToFieldTargetIndices,
    domainEntryCount,
    compactActiveIndexMap: null,
    allEntryPositionsM: rawPositions,
    arrowCandidateIndices,
    arrowAnchorPositionsM,
    cellSizeM: null,
    boundsSizeM: computePositionBoundsSize(positionsM),
  };
}

function buildWatertightDisplacementNormals(
  positionsM: Float32Array,
  normals: Float32Array,
): Float32Array {
  const vertexCount = Math.floor(positionsM.length / 3);
  const boundsSize = computePositionBoundsSize(positionsM);
  const diag = Math.hypot(boundsSize[0], boundsSize[1], boundsSize[2]);
  const tol = Math.max(diag * 1e-7, 1e-30);
  const accum = new Map<string, [number, number, number]>();
  const keys: string[] = new Array(vertexCount);

  for (let i = 0; i < vertexCount; i += 1) {
    const x = positionsM[i * 3]!;
    const y = positionsM[i * 3 + 1]!;
    const z = positionsM[i * 3 + 2]!;
    const key = `${Math.round(x / tol)}_${Math.round(y / tol)}_${Math.round(z / tol)}`;
    keys[i] = key;
    let sum = accum.get(key);
    if (!sum) {
      sum = [0, 0, 0];
      accum.set(key, sum);
    }
    sum[0] += normals[i * 3] ?? 0;
    sum[1] += normals[i * 3 + 1] ?? 0;
    sum[2] += normals[i * 3 + 2] ?? 0;
  }

  const out = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i += 1) {
    const sum = accum.get(keys[i]!)!;
    const len = Math.hypot(sum[0], sum[1], sum[2]);
    if (len > 0 && Number.isFinite(len)) {
      out[i * 3] = sum[0] / len;
      out[i * 3 + 1] = sum[1] / len;
      out[i * 3 + 2] = sum[2] / len;
    } else {
      out[i * 3] = normals[i * 3] ?? 0;
      out[i * 3 + 1] = normals[i * 3 + 1] ?? 0;
      out[i * 3 + 2] = normals[i * 3 + 2] ?? 1;
    }
  }
  return out;
}

function resolveDisplacementComponent(
  requested: Export3DSurfaceDisplacementComponent | undefined,
  colorMode: Export3DColorMode,
  componentCount: 1 | 3,
): "x" | "y" | "z" | "normal" | "scalar" {
  if (componentCount === 1) return "scalar";
  if (requested && requested !== "auto") return requested;
  if (colorMode === "x" || colorMode === "y" || colorMode === "z") {
    return colorMode;
  }
  return "z";
}

function extractDisplacementScalarsPerVertex(params: {
  values: Export3DNumericArray;
  componentCount: 1 | 3;
  displacementComponent: "x" | "y" | "z" | "normal" | "scalar";
  prep: PreparedTargetGeometry;
  watertightNormals: Float32Array;
  fieldNodeIndices?: Export3DIndexArray | null;
}): Float32Array {
  const { vertexCount } = params.prep;
  const out = new Float32Array(vertexCount);
  const nComp = params.componentCount;
  const fieldCount = Math.floor(params.values.length / nComp);

  let map: Map<number, number> | null = params.prep.compactActiveIndexMap;
  if (!map && params.fieldNodeIndices) {
    map = new Map<number, number>();
    const len = Math.min(fieldCount, params.fieldNodeIndices.length);
    for (let fi = 0; fi < len; fi += 1) {
      map.set(Number(params.fieldNodeIndices[fi]!), fi);
    }
  }

  for (let v = 0; v < vertexCount; v += 1) {
    const targetIdx = params.prep.vertexToFieldTargetIndices
      ? params.prep.vertexToFieldTargetIndices[v]!
      : v;
    const fieldIdx = map ? (map.get(targetIdx) ?? -1) : targetIdx;
    if (fieldIdx < 0 || fieldIdx >= fieldCount) continue;
    const src = fieldIdx * nComp;
    const vx = params.values[src] ?? 0;
    const vy = nComp === 3 ? (params.values[src + 1] ?? 0) : 0;
    const vz = nComp === 3 ? (params.values[src + 2] ?? 0) : 0;
    let s = vx;
    if (params.displacementComponent === "y") s = vy;
    else if (params.displacementComponent === "z") s = vz;
    else if (params.displacementComponent === "normal") {
      s =
        vx * params.watertightNormals[v * 3]! +
        vy * params.watertightNormals[v * 3 + 1]! +
        vz * params.watertightNormals[v * 3 + 2]!;
    }
    out[v] = Number.isFinite(s) ? s : 0;
  }
  return out;
}

function buildDisplacedPositionsAttribute(
  basePositionsScene: Float32Array,
  watertightNormals: Float32Array,
  scalars: Float32Array,
  scaleFactorScene: number,
): BufferAttribute {
  const out = new Float32Array(basePositionsScene.length);
  const count = Math.floor(basePositionsScene.length / 3);
  for (let i = 0; i < count; i += 1) {
    const d = scalars[i]! * scaleFactorScene;
    const base = i * 3;
    out[base] = basePositionsScene[base]! + watertightNormals[base]! * d;
    out[base + 1] = basePositionsScene[base + 1]! + watertightNormals[base + 1]! * d;
    out[base + 2] = basePositionsScene[base + 2]! + watertightNormals[base + 2]! * d;
  }
  return new BufferAttribute(out, 3);
}

function sampleVectorsAtSites(params: {
  values: Export3DNumericArray;
  siteIndices: Uint32Array;
  domainEntryCount: number;
  compactActiveIndexMap: Map<number, number> | null;
  fieldNodeIndices?: Export3DIndexArray | null;
}): Float32Array {
  const count = params.siteIndices.length;
  const out = new Float32Array(count * 3);
  const entryCount = Math.floor(params.values.length / 3);

  let nodeMap: Map<number, number> | null = params.compactActiveIndexMap;
  if (!nodeMap && params.fieldNodeIndices) {
    nodeMap = new Map<number, number>();
    const len = Math.min(entryCount, params.fieldNodeIndices.length);
    for (let i = 0; i < len; i += 1) {
      nodeMap.set(Number(params.fieldNodeIndices[i]!), i);
    }
  }

  for (let i = 0; i < count; i += 1) {
    const targetIdx = params.siteIndices[i]!;
    const fieldIdx = nodeMap ? (nodeMap.get(targetIdx) ?? -1) : targetIdx;
    if (fieldIdx < 0 || fieldIdx >= entryCount) continue;
    const src = fieldIdx * 3;
    out[i * 3] = params.values[src] ?? 0;
    out[i * 3 + 1] = params.values[src + 1] ?? 0;
    out[i * 3 + 2] = params.values[src + 2] ?? 0;
  }
  return out;
}

function createSurfaceMaterial(params: {
  materialStyle: Export3DMaterialStyle;
  opacity: number;
  vertexColors: boolean;
  monochromeSrgb?: Export3DRgbTuple;
}): Material {
  const transparent = params.opacity < 1;
  if (params.vertexColors) {
    // Keep base color strictly 0xffffff when vertexColors is true because glTF
    // multiplies COLOR_0 by baseColorFactor.
    return params.materialStyle === "pbr"
      ? new MeshStandardMaterial({
          color: 0xffffff,
          vertexColors: true,
          roughness: 0.45,
          metalness: 0.08,
          side: DoubleSide,
          transparent,
          opacity: params.opacity,
        })
      : new MeshBasicMaterial({
          color: 0xffffff,
          vertexColors: true,
          side: DoubleSide,
          transparent,
          opacity: params.opacity,
        });
  }
  const linear = srgbToLinearRgb(params.monochromeSrgb ?? DEFAULT_MONOCHROME_SRGB);
  const color = new Color().setRGB(linear[0], linear[1], linear[2], LinearSRGBColorSpace);
  return params.materialStyle === "pbr"
    ? new MeshStandardMaterial({
        color,
        vertexColors: false,
        roughness: 0.45,
        metalness: 0.08,
        side: DoubleSide,
        transparent,
        opacity: params.opacity,
      })
    : new MeshBasicMaterial({
        color,
        vertexColors: false,
        side: DoubleSide,
        transparent,
        opacity: params.opacity,
      });
}

function buildDiscreteFrameScaleTrack(
  nodeName: string,
  frameIndex: number,
  frameCount: number,
  frameTimes: readonly number[],
  durationSeconds: number,
): VectorKeyframeTrack {
  if (frameCount <= 1) {
    return new VectorKeyframeTrack(
      `${nodeName}.scale`,
      [0, durationSeconds],
      [1, 1, 1, 1, 1, 1],
      InterpolateDiscrete,
    );
  }
  const tStart = frameTimes[frameIndex] ?? (frameIndex / frameCount) * durationSeconds;
  const tEnd =
    frameIndex === frameCount - 1
      ? durationSeconds
      : (frameTimes[frameIndex + 1] ?? ((frameIndex + 1) / frameCount) * durationSeconds);

  if (frameIndex === 0) {
    return new VectorKeyframeTrack(
      `${nodeName}.scale`,
      [0, tEnd, durationSeconds],
      [1, 1, 1, 0, 0, 0, 0, 0, 0],
      InterpolateDiscrete,
    );
  }
  if (frameIndex === frameCount - 1) {
    return new VectorKeyframeTrack(
      `${nodeName}.scale`,
      [0, tStart, durationSeconds],
      [0, 0, 0, 1, 1, 1, 1, 1, 1],
      InterpolateDiscrete,
    );
  }
  return new VectorKeyframeTrack(
    `${nodeName}.scale`,
    [0, tStart, tEnd, durationSeconds],
    [0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0],
    InterpolateDiscrete,
  );
}

function maxMagnitudeOfFrames(frames: readonly Export3DNumericArray[]): number {
  let maxMag = 0;
  for (const frame of frames) {
    const count = Math.floor(frame.length / 3);
    for (let i = 0; i < count; i += 1) {
      const mag = Math.hypot(
        frame[i * 3] ?? 0,
        frame[i * 3 + 1] ?? 0,
        frame[i * 3 + 2] ?? 0,
      );
      if (Number.isFinite(mag) && mag > maxMag) maxMag = mag;
    }
  }
  return maxMag;
}

function interpolateVectorFieldFrame(
  frameA: Float32Array,
  frameB: Float32Array,
  alpha: number,
): Float32Array {
  const out = new Float32Array(frameA.length);
  const count = Math.floor(frameA.length / 3);
  for (let i = 0; i < count; i += 1) {
    const b = i * 3;
    const ax = frameA[b]!;
    const ay = frameA[b + 1]!;
    const az = frameA[b + 2]!;
    const bx = frameB[b]!;
    const by = frameB[b + 1]!;
    const bz = frameB[b + 2]!;
    out[b] = ax + (bx - ax) * alpha;
    out[b + 1] = ay + (by - ay) * alpha;
    out[b + 2] = az + (bz - az) * alpha;
  }
  return out;
}

function maxScalarAbsAcrossArrays(arrays: readonly Float32Array[]): number {
  let maxAbs = 0;
  for (const arr of arrays) {
    for (let i = 0; i < arr.length; i += 1) {
      const abs = Math.abs(arr[i]!);
      if (Number.isFinite(abs) && abs > maxAbs) maxAbs = abs;
    }
  }
  return maxAbs;
}

/**
 * Builds a Three.js scene containing all Fullmag targets, optional wireframe
 * feature edges, static or animated magnetic surfaces (via shared position/normal/index
 * BufferAttributes and discrete scale tracks), optional morph-target wave displacement,
 * and static or smooth 60fps 3D vector arrows, then serializes to `.glb` or `.gltf`.
 */
export async function buildExport3DGltf(
  request: Export3DModelRequest,
): Promise<BuildExport3DGltfResult> {
  const { targets, options } = request;
  throwIfExportAborted(options.signal);

  const binary = options.format === "glb";
  const coordinateScale =
    options.coordinateScale ?? defaultCoordinateScaleForFormat(options.format);
  const materialStyle: Export3DMaterialStyle = options.materialStyle ?? "unlit";
  const opacity = Math.min(1, Math.max(0, options.opacity ?? 1));
  const animationMode = resolveEffectiveAnimationMode(targets, options);
  const cycleDurationSeconds = Math.max(0.1, options.cycleDurationSeconds ?? 2.0);
  const phaseFrameCount = Math.max(
    4,
    Math.min(120, Math.floor(options.phaseFrameCount ?? 24)),
  );
  const arrowFps = Math.max(10, Math.min(120, Math.floor(options.arrowFps ?? 60)));
  const surfaceDisplacementScale = Math.max(
    0,
    options.surfaceDisplacementScale ?? 0,
  );
  const boundsM = resolveBoundsFromTargets(targets);
  const coordinateTransform = resolveCoordinateTransform(boundsM, coordinateScale);
  const maxDomainDimM = boundsM
    ? Math.max(boundsM.size[0], boundsM.size[1], boundsM.size[2], 1e-18)
    : 1;

  const warnings: string[] = [];
  const disposables = new Set<{ dispose(): void }>();
  const usedNodeNames = new Set<string>();
  const tracks: KeyframeTrack[] = [];

  const scene = new Scene();
  scene.name = sanitizeGlTfNodeName("fullmag_scene", usedNodeNames, "scene");
  const rootGroup = new Group();
  rootGroup.name = sanitizeGlTfNodeName("fullmag_root", usedNodeNames, "root");
  scene.add(rootGroup);

  const provenanceExtras = sanitizeJsonExtrasValue({
    schema_version: 1,
    generator: "fullmag-control-room-export-3d",
    coordinate_scale: coordinateScale,
    si_meters_per_unit: coordinateTransform.siMetersPerUnit,
    origin_offset_m: coordinateTransform.originOffsetM,
    bounds_m: boundsM ? { min: boundsM.min, max: boundsM.max } : null,
    animation_mode: animationMode,
    material_style: materialStyle,
    ...(options.provenance ?? {}),
  });
  scene.userData = { fullmag: provenanceExtras };
  rootGroup.userData = { fullmag: provenanceExtras };

  let totalMeshCount = 0;
  let totalVertexCount = 0;
  let totalTriangleCount = 0;
  let totalCellCount = 0;
  let totalArrowCount = 0;
  let maxFrameCount = 1;
  const usedMaterialSet = new Set<Material>();

  try {
    for (let targetIdx = 0; targetIdx < targets.length; targetIdx += 1) {
      throwIfExportAborted(options.signal);
      const target = targets[targetIdx]!;
      const prep = prepareTargetGeometry(target, options);
      if (prep.vertexCount === 0) {
        warnings.push(`Target "${target.id}" produced no exportable surface vertices.`);
        continue;
      }

      totalCellCount +=
        target.kind === "fdm_grid"
          ? prep.domainEntryCount
          : prep.triangleCount;

      const targetGroup = new Group();
      targetGroup.name = sanitizeGlTfNodeName(
        `target_${target.name ?? target.id}`,
        usedNodeNames,
        `target_${targetIdx}`,
      );
      targetGroup.userData = {
        fullmag: sanitizeJsonExtrasValue({
          object_id: target.id,
          name: target.name ?? target.id,
          discretization: target.kind,
          quantity_id: target.field?.quantityId ?? null,
          unit: target.field?.unit ?? null,
        }),
      };
      rootGroup.add(targetGroup);

      const basePositionsScene = new Float32Array(prep.positionsM.length);
      for (let i = 0; i < prep.vertexCount; i += 1) {
        const [sx, sy, sz] = transformPositionByCoordinateTransform(
          prep.positionsM[i * 3]!,
          prep.positionsM[i * 3 + 1]!,
          prep.positionsM[i * 3 + 2]!,
          coordinateTransform,
        );
        basePositionsScene[i * 3] = sx;
        basePositionsScene[i * 3 + 1] = sy;
        basePositionsScene[i * 3 + 2] = sz;
      }

      const sharedPositionAttr = new BufferAttribute(basePositionsScene, 3);
      const sharedNormalAttr = new BufferAttribute(prep.normals, 3);
      const sharedIndexAttr = prep.indices
        ? new BufferAttribute(
            prep.vertexCount < 65535
              ? Uint16Array.from(prep.indices)
              : prep.indices,
            1,
          )
        : null;

      const field = target.field ?? null;
      const targetOpacity = Math.min(
        1,
        Math.max(0, target.appearance?.opacity ?? opacity),
      );
      const includeSurface =
        target.appearance?.includeSurface ?? options.includeSurface ?? true;
      const includeWireframe =
        target.appearance?.includeWireframe ?? options.includeWireframe ?? false;
      const includeVectors =
        target.appearance?.includeVectors ?? options.includeVectors ?? false;

      const defaultColorMode: Export3DColorMode =
        field?.componentCount === 3 ? "orientation" : "magnitude";
      const colorMode = normalizeExport3DColorMode(
        target.appearance?.colorMode ?? options.colorMode,
        defaultColorMode,
      );
      const colorPalette: Export3DScalarPalette = normalizeExport3DScalarPalette(
        target.appearance?.colorPalette ?? options.colorPalette,
        "viridis",
      );
      const monochromeColor =
        target.appearance?.monochromeColor ??
        options.monochromeColor ??
        DEFAULT_MONOCHROME_SRGB;
      const explicitColorRange =
        target.appearance?.colorRange !== undefined
          ? target.appearance.colorRange
          : options.colorRange;

      // Resolve frame values according to animationMode & field kind.
      const frameValuesList: Export3DNumericArray[] = [];
      const frameTimesList: number[] = [];
      let effectiveDuration = cycleDurationSeconds;
      let complexQuadrature: {
        cosBasis: Float32Array;
        sinBasis: Float32Array;
      } | null = null;

      if (field) {
        if (field.kind === "real") {
          frameValuesList.push(field.values);
          frameTimesList.push(0);
        } else if (field.kind === "complex") {
          const repr = field.complexRepresentation ?? "phase_rotated_real";
          if (animationMode === "phase_cycle" && repr === "phase_rotated_real") {
            for (let f = 0; f < phaseFrameCount; f += 1) {
              const phaseRad = (f / phaseFrameCount) * TWO_PI;
              frameValuesList.push(
                evaluateComplexFieldArray(field, phaseRad, prep.allEntryPositionsM),
              );
              frameTimesList.push((f / phaseFrameCount) * effectiveDuration);
            }
            complexQuadrature = evaluateComplexHarmonicQuadratureBasis(
              field,
              prep.allEntryPositionsM,
            );
          } else {
            if (animationMode === "phase_cycle" && repr !== "phase_rotated_real") {
              warnings.push(
                `Target "${target.id}" uses complex representation "${repr}", which is phase-invariant; exporting static frame.`,
              );
            }
            frameValuesList.push(
              evaluateComplexFieldArray(
                field,
                field.complexPhaseRad ?? 0,
                prep.allEntryPositionsM,
              ),
            );
            frameTimesList.push(0);
          }
        } else if (field.kind === "frames") {
          if (field.frames.length === 0) {
            warnings.push(`Target "${target.id}" has an empty playback frames list.`);
          } else if (animationMode === "playback_frames" && field.frames.length > 1) {
            const firstTime = field.frames[0]!.timeS;
            const lastTime = field.frames[field.frames.length - 1]!.timeS;
            const hasPhysicalTimes =
              firstTime !== undefined &&
              lastTime !== undefined &&
              Number.isFinite(firstTime) &&
              Number.isFinite(lastTime) &&
              lastTime > firstTime;
            if (hasPhysicalTimes) {
              const span = lastTime! - firstTime!;
              effectiveDuration = cycleDurationSeconds;
              for (let f = 0; f < field.frames.length; f += 1) {
                frameValuesList.push(field.frames[f]!.values);
                const t = field.frames[f]!.timeS ?? firstTime!;
                frameTimesList.push(((t - firstTime!) / span) * effectiveDuration);
              }
            } else {
              for (let f = 0; f < field.frames.length; f += 1) {
                frameValuesList.push(field.frames[f]!.values);
                frameTimesList.push((f / field.frames.length) * effectiveDuration);
              }
            }
          } else {
            const idx = Math.min(
              field.frames.length - 1,
              Math.max(0, Math.floor(options.frameIndex ?? 0)),
            );
            frameValuesList.push(field.frames[idx]!.values);
            frameTimesList.push(0);
          }
        }
      }

      const colorRange: Export3DScalarRange = field
        ? resolveFieldScalarRange(
            frameValuesList,
            field.componentCount,
            colorMode,
            colorPalette,
            explicitColorRange,
          )
        : { min: 0, max: 1 };

      const frameCount = Math.max(1, frameValuesList.length);
      if (frameCount > maxFrameCount) maxFrameCount = frameCount;

      // Optional wave displacement morph target BufferAttributes.
      const useDisplacement = Boolean(field && surfaceDisplacementScale > 0);
      const dispAmplitudeScene =
        surfaceDisplacementScale * maxDomainDimM * coordinateTransform.unitsPerMeter;
      let watertightNormals: Float32Array | null = null;
      let staticMorphAttr: BufferAttribute | null = null;
      let quadratureMorphAttrs:
        | readonly [BufferAttribute, BufferAttribute, BufferAttribute, BufferAttribute]
        | null = null;
      let playbackMorphAttrs: BufferAttribute[] | null = null;

      if (useDisplacement && field) {
        watertightNormals = buildWatertightDisplacementNormals(
          prep.positionsM,
          prep.normals,
        );
        const dispComp = resolveDisplacementComponent(
          options.surfaceDisplacementComponent,
          colorMode,
          field.componentCount,
        );

        if (complexQuadrature && frameCount > 1) {
          const cosScalars = extractDisplacementScalarsPerVertex({
            values: complexQuadrature.cosBasis,
            componentCount: field.componentCount,
            displacementComponent: dispComp,
            prep,
            watertightNormals,
            fieldNodeIndices: field.nodeIndices,
          });
          const sinScalars = extractDisplacementScalarsPerVertex({
            values: complexQuadrature.sinBasis,
            componentCount: field.componentCount,
            displacementComponent: dispComp,
            prep,
            watertightNormals,
            fieldNodeIndices: field.nodeIndices,
          });
          let peakMag = 0;
          for (let v = 0; v < prep.vertexCount; v += 1) {
            const amp = Math.hypot(cosScalars[v]!, sinScalars[v]!);
            if (amp > peakMag) peakMag = amp;
          }
          const normScale =
            peakMag > 1e-30 ? dispAmplitudeScene / peakMag : 0;
          quadratureMorphAttrs = [
            buildDisplacedPositionsAttribute(
              basePositionsScene,
              watertightNormals,
              cosScalars,
              normScale,
            ),
            buildDisplacedPositionsAttribute(
              basePositionsScene,
              watertightNormals,
              cosScalars,
              -normScale,
            ),
            buildDisplacedPositionsAttribute(
              basePositionsScene,
              watertightNormals,
              sinScalars,
              normScale,
            ),
            buildDisplacedPositionsAttribute(
              basePositionsScene,
              watertightNormals,
              sinScalars,
              -normScale,
            ),
          ];
        } else {
          const frameScalars = frameValuesList.map((vals) =>
            extractDisplacementScalarsPerVertex({
              values: vals,
              componentCount: field.componentCount,
              displacementComponent: dispComp,
              prep,
              watertightNormals: watertightNormals!,
              fieldNodeIndices: field.nodeIndices,
            }),
          );
          const maxAbs = maxScalarAbsAcrossArrays(frameScalars);
          const normScale = maxAbs > 1e-30 ? dispAmplitudeScene / maxAbs : 0;
          if (frameCount === 1) {
            staticMorphAttr = buildDisplacedPositionsAttribute(
              basePositionsScene,
              watertightNormals,
              frameScalars[0]!,
              normScale,
            );
          } else {
            playbackMorphAttrs = frameScalars.map((scalars) =>
              buildDisplacedPositionsAttribute(
                basePositionsScene,
                watertightNormals!,
                scalars,
                normScale,
              ),
            );
          }
        }
      }

      // 1. Surface Meshes
      if (includeSurface) {
        const useVertexColors = Boolean(field && colorMode !== "monochrome");
        const surfaceMaterial = createSurfaceMaterial({
          materialStyle,
          opacity: targetOpacity,
          vertexColors: useVertexColors,
          monochromeSrgb: monochromeColor,
        });
        disposables.add(surfaceMaterial);
        usedMaterialSet.add(surfaceMaterial);

        const quadratureKeyCount = Math.max(
          24,
          Math.round(effectiveDuration * arrowFps),
        );
        const quadratureTimes: number[] = [];
        const quadWeights: [number[], number[], number[], number[]] = [[], [], [], []];
        if (quadratureMorphAttrs) {
          for (let s = 0; s <= quadratureKeyCount; s += 1) {
            const t = (s / quadratureKeyCount) * effectiveDuration;
            const phi = (s / quadratureKeyCount) * TWO_PI;
            const c = Math.cos(phi);
            const sn = Math.sin(phi);
            quadratureTimes.push(t);
            quadWeights[0].push(Math.max(0, c));
            quadWeights[1].push(Math.max(0, -c));
            quadWeights[2].push(Math.max(0, sn));
            quadWeights[3].push(Math.max(0, -sn));
          }
        }

        if (frameCount <= 1) {
          const geometry = new BufferGeometry();
          geometry.setAttribute("position", sharedPositionAttr);
          geometry.setAttribute("normal", sharedNormalAttr);
          if (sharedIndexAttr) geometry.setIndex(sharedIndexAttr);
          if (useVertexColors && field && frameValuesList[0]) {
            const colors = evaluateFieldColorsLinear({
              values: frameValuesList[0],
              componentCount: field.componentCount,
              colorMode,
              colorPalette,
              range: colorRange,
              outputTargetIndices: prep.vertexToFieldTargetIndices,
              outputCount: prep.vertexCount,
              domainEntryCount: prep.domainEntryCount,
              fieldNodeIndices: field.nodeIndices,
              compactActiveIndexMap: prep.compactActiveIndexMap,
              monochromeColor,
            });
            geometry.setAttribute("color", new BufferAttribute(colors, 3));
          }
          if (staticMorphAttr) {
            geometry.morphAttributes.position = [staticMorphAttr];
            geometry.morphTargetsRelative = false;
          }
          disposables.add(geometry);

          const mesh = new Mesh(geometry, surfaceMaterial);
          mesh.name = sanitizeGlTfNodeName(
            `${target.id}_surface`,
            usedNodeNames,
            "surface",
          );
          if (staticMorphAttr) {
            mesh.updateMorphTargets();
            if (mesh.morphTargetInfluences) {
              mesh.morphTargetInfluences[0] = 1;
            }
          }
          mesh.userData = {
            fullmag: sanitizeJsonExtrasValue({
              role: "surface",
              object_id: target.id,
              quantity_id: field?.quantityId ?? null,
              color_mode: colorMode,
              color_palette: colorPalette,
              color_range: colorRange,
            }),
          };
          targetGroup.add(mesh);
          totalMeshCount += 1;
          totalVertexCount += prep.vertexCount;
          totalTriangleCount += prep.triangleCount;
        } else {
          // Multi-frame animated texture: K Mesh nodes sharing the EXACT SAME
          // BufferAttribute instances for position, normal, and index, toggled
          // via discrete scale tracks.
          for (let k = 0; k < frameCount; k += 1) {
            throwIfExportAborted(options.signal);
            const geometry = new BufferGeometry();
            geometry.setAttribute("position", sharedPositionAttr);
            geometry.setAttribute("normal", sharedNormalAttr);
            if (sharedIndexAttr) geometry.setIndex(sharedIndexAttr);
            if (useVertexColors && field) {
              const colors = evaluateFieldColorsLinear({
                values: frameValuesList[k]!,
                componentCount: field.componentCount,
                colorMode,
                colorPalette,
                range: colorRange,
                outputTargetIndices: prep.vertexToFieldTargetIndices,
                outputCount: prep.vertexCount,
                domainEntryCount: prep.domainEntryCount,
                fieldNodeIndices: field.nodeIndices,
                compactActiveIndexMap: prep.compactActiveIndexMap,
                monochromeColor,
              });
              geometry.setAttribute("color", new BufferAttribute(colors, 3));
            }

            if (quadratureMorphAttrs) {
              geometry.morphAttributes.position = [...quadratureMorphAttrs];
              geometry.morphTargetsRelative = false;
            } else if (playbackMorphAttrs) {
              const nextK = k < frameCount - 1 ? k + 1 : k;
              geometry.morphAttributes.position = [
                playbackMorphAttrs[k]!,
                playbackMorphAttrs[nextK]!,
              ];
              geometry.morphTargetsRelative = false;
            }
            disposables.add(geometry);

            const frameMesh = new Mesh(geometry, surfaceMaterial);
            frameMesh.name = sanitizeGlTfNodeName(
              `${target.id}_surface_f${k}`,
              usedNodeNames,
              `surface_f${k}`,
            );
            frameMesh.scale.set(k === 0 ? 1 : 0, k === 0 ? 1 : 0, k === 0 ? 1 : 0);
            frameMesh.userData = {
              fullmag: sanitizeJsonExtrasValue({
                role: "surface_frame",
                object_id: target.id,
                frame_index: k,
                time_s: frameTimesList[k] ?? 0,
              }),
            };

            if (quadratureMorphAttrs) {
              frameMesh.updateMorphTargets();
              if (frameMesh.morphTargetInfluences) {
                frameMesh.morphTargetInfluences[0] = 1;
              }
              for (let m = 0; m < 4; m += 1) {
                tracks.push(
                  new NumberKeyframeTrack(
                    `${frameMesh.name}.morphTargetInfluences[${m}]`,
                    quadratureTimes,
                    quadWeights[m]!,
                    InterpolateLinear,
                  ),
                );
              }
            } else if (playbackMorphAttrs) {
              frameMesh.updateMorphTargets();
              if (frameMesh.morphTargetInfluences) {
                frameMesh.morphTargetInfluences[0] = 1;
                frameMesh.morphTargetInfluences[1] = 0;
              }
              const tStart =
                frameTimesList[k] ?? (k / frameCount) * effectiveDuration;
              const tEnd =
                k === frameCount - 1
                  ? effectiveDuration
                  : (frameTimesList[k + 1] ??
                    ((k + 1) / frameCount) * effectiveDuration);
              if (k === 0) {
                tracks.push(
                  new NumberKeyframeTrack(
                    `${frameMesh.name}.morphTargetInfluences[0]`,
                    [0, tEnd, effectiveDuration],
                    [1, 0, 0],
                    InterpolateLinear,
                  ),
                  new NumberKeyframeTrack(
                    `${frameMesh.name}.morphTargetInfluences[1]`,
                    [0, tEnd, effectiveDuration],
                    [0, 1, 1],
                    InterpolateLinear,
                  ),
                );
              } else if (k === frameCount - 1) {
                tracks.push(
                  new NumberKeyframeTrack(
                    `${frameMesh.name}.morphTargetInfluences[0]`,
                    [0, tStart, effectiveDuration],
                    [1, 1, 1],
                    InterpolateLinear,
                  ),
                  new NumberKeyframeTrack(
                    `${frameMesh.name}.morphTargetInfluences[1]`,
                    [0, tStart, effectiveDuration],
                    [0, 0, 0],
                    InterpolateLinear,
                  ),
                );
              } else {
                tracks.push(
                  new NumberKeyframeTrack(
                    `${frameMesh.name}.morphTargetInfluences[0]`,
                    [0, tStart, tEnd, effectiveDuration],
                    [1, 1, 0, 0],
                    InterpolateLinear,
                  ),
                  new NumberKeyframeTrack(
                    `${frameMesh.name}.morphTargetInfluences[1]`,
                    [0, tStart, tEnd, effectiveDuration],
                    [0, 0, 1, 1],
                    InterpolateLinear,
                  ),
                );
              }
            }

            tracks.push(
              buildDiscreteFrameScaleTrack(
                frameMesh.name,
                k,
                frameCount,
                frameTimesList,
                effectiveDuration,
              ),
            );

            targetGroup.add(frameMesh);
            totalMeshCount += 1;
          }
          totalVertexCount += prep.vertexCount;
          totalTriangleCount += prep.triangleCount;
        }
      }

      // 2. Wireframe Feature Edges
      if (includeWireframe) {
        const wireSourcePos = staticMorphAttr
          ? (staticMorphAttr.array as Float32Array)
          : basePositionsScene;
        const edgePositions = buildSurfaceFeatureEdgePositions(
          wireSourcePos,
          prep.indices,
        );
        if (edgePositions.length >= 6) {
          const wireGeometry = new BufferGeometry();
          wireGeometry.setAttribute("position", new BufferAttribute(edgePositions, 3));
          const wireLinear = srgbToLinearRgb(
            options.wireframeColor ?? DEFAULT_WIREFRAME_SRGB,
          );
          const wireMaterial = new LineBasicMaterial({
            color: new Color().setRGB(
              wireLinear[0],
              wireLinear[1],
              wireLinear[2],
              LinearSRGBColorSpace,
            ),
            transparent: targetOpacity < 1,
            opacity: targetOpacity,
          });
          disposables.add(wireGeometry);
          disposables.add(wireMaterial);
          usedMaterialSet.add(wireMaterial);

          const wireSegments = new LineSegments(wireGeometry, wireMaterial);
          wireSegments.name = sanitizeGlTfNodeName(
            `${target.id}_wireframe`,
            usedNodeNames,
            "wireframe",
          );
          wireSegments.userData = {
            fullmag: sanitizeJsonExtrasValue({
              role: "wireframe",
              object_id: target.id,
            }),
          };
          targetGroup.add(wireSegments);
          totalMeshCount += 1;
        }
      }

      // 3. 3D Vector Arrows
      if (includeVectors && field) {
        if (field.componentCount !== 3) {
          warnings.push(
            `Target "${target.id}" field "${field.quantityId}" is scalar (1-component); vector arrows omitted.`,
          );
        } else if (prep.arrowCandidateIndices.length > 0) {
          const vecColorMode = normalizeExport3DColorMode(
            target.appearance?.vectorColorMode ?? options.vectorColorMode ?? colorMode,
            colorMode,
          );
          const vecPalette = normalizeExport3DScalarPalette(
            options.vectorColorPalette ?? colorPalette,
            colorPalette,
          );
          const anchorMode = options.arrowAnchorMode ?? "center";
          const lengthMode = options.vectorLengthMode ?? "proportional";
          const baseArrowLengthM = computeAutoArrowBaseLengthM({
            boundsSizeM: prep.boundsSizeM,
            sampledCount: prep.arrowCandidateIndices.length,
            cellSizeM: prep.cellSizeM,
            arrowLengthScale: options.arrowLengthScale,
          });

          const isComplexCycle =
            animationMode === "phase_cycle" &&
            field.kind === "complex" &&
            (field.complexRepresentation ?? "phase_rotated_real") ===
              "phase_rotated_real";
          const isPlaybackFrames =
            animationMode === "playback_frames" &&
            field.kind === "frames" &&
            field.frames.length > 1;

          if (!isComplexCycle && !isPlaybackFrames) {
            const srcValues = frameValuesList[0];
            if (srcValues) {
              const siteVectors = sampleVectorsAtSites({
                values: srcValues,
                siteIndices: prep.arrowCandidateIndices,
                domainEntryCount: prep.domainEntryCount,
                compactActiveIndexMap: prep.compactActiveIndexMap,
                fieldNodeIndices: field.nodeIndices,
              });
              const vecColorRange = resolveFieldScalarRange(
                [srcValues],
                3,
                vecColorMode,
                vecPalette,
                explicitColorRange,
              );
              const maxMag = maxMagnitudeOfFrames([srcValues]);
              const built = buildMergedStaticArrowGeometry({
                anchorsM: prep.arrowAnchorPositionsM,
                vectors: siteVectors,
                maxMagnitude: maxMag,
                baseArrowLengthM,
                anchorMode,
                vectorLengthMode: lengthMode,
                coordinateTransform,
                colorMode: vecColorMode,
                colorPalette: vecPalette,
                colorRange: vecColorRange,
                monochromeColor,
              });
              if (built) {
                const arrowMaterial = createSurfaceMaterial({
                  materialStyle,
                  opacity: targetOpacity,
                  vertexColors: true,
                });
                disposables.add(built.geometry);
                disposables.add(arrowMaterial);
                usedMaterialSet.add(arrowMaterial);

                const arrowMesh = new Mesh(built.geometry, arrowMaterial);
                arrowMesh.name = sanitizeGlTfNodeName(
                  `${target.id}_vectors`,
                  usedNodeNames,
                  "vectors",
                );
                arrowMesh.userData = {
                  fullmag: sanitizeJsonExtrasValue({
                    role: "vectors_static",
                    object_id: target.id,
                    arrow_count: built.arrowCount,
                    quantity_id: field.quantityId,
                  }),
                };
                targetGroup.add(arrowMesh);
                totalMeshCount += 1;
                totalArrowCount += built.arrowCount;
              }
            }
          } else {
            // Smooth 60fps animated 3D arrows sharing ONE unit arrow BufferGeometry
            // and a bounded quantized palette of shared materials.
            const keyframeCount = Math.max(
              24,
              Math.round(effectiveDuration * arrowFps),
            );
            const keyframeTimes: number[] = [];
            const arrowFrameVectors: Float32Array[] = [];

            if (isComplexCycle) {
              const complexField = field as Export3DComplexFieldInput;
              for (let f = 0; f <= keyframeCount; f += 1) {
                const t = (f / keyframeCount) * effectiveDuration;
                const phaseRad = (f / keyframeCount) * TWO_PI;
                keyframeTimes.push(t);
                const fullEval = evaluateComplexFieldArray(
                  complexField,
                  phaseRad,
                  prep.allEntryPositionsM,
                );
                arrowFrameVectors.push(
                  sampleVectorsAtSites({
                    values: fullEval,
                    siteIndices: prep.arrowCandidateIndices,
                    domainEntryCount: prep.domainEntryCount,
                    compactActiveIndexMap: prep.compactActiveIndexMap,
                    fieldNodeIndices: complexField.nodeIndices,
                  }),
                );
              }
            } else {
              const sampledPlaybackFrames = frameValuesList.map((vals) =>
                sampleVectorsAtSites({
                  values: vals,
                  siteIndices: prep.arrowCandidateIndices,
                  domainEntryCount: prep.domainEntryCount,
                  compactActiveIndexMap: prep.compactActiveIndexMap,
                  fieldNodeIndices: field.nodeIndices,
                }),
              );
              const sourceTimes = frameTimesList;
              if (sampledPlaybackFrames.length >= keyframeCount) {
                for (let f = 0; f < sampledPlaybackFrames.length; f += 1) {
                  keyframeTimes.push(sourceTimes[f] ?? 0);
                  arrowFrameVectors.push(sampledPlaybackFrames[f]!);
                }
              } else {
                const segCount = sampledPlaybackFrames.length - 1;
                for (let s = 0; s <= keyframeCount; s += 1) {
                  const t = (s / keyframeCount) * effectiveDuration;
                  keyframeTimes.push(t);
                  let seg = 0;
                  while (seg < segCount - 1 && t > (sourceTimes[seg + 1] ?? effectiveDuration)) {
                    seg += 1;
                  }
                  const t0 = sourceTimes[seg] ?? 0;
                  const t1 = sourceTimes[seg + 1] ?? effectiveDuration;
                  const span = t1 - t0;
                  const alpha =
                    span > 1e-18 ? Math.min(1, Math.max(0, (t - t0) / span)) : 0;
                  arrowFrameVectors.push(
                    interpolateVectorFieldFrame(
                      sampledPlaybackFrames[seg]!,
                      sampledPlaybackFrames[seg + 1]!,
                      alpha,
                    ),
                  );
                }
              }
            }

            const maxMag = maxMagnitudeOfFrames(
              frameValuesList.length > 0 ? frameValuesList : arrowFrameVectors,
            );
            const vecColorRange = resolveFieldScalarRange(
              frameValuesList.length > 0 ? frameValuesList : arrowFrameVectors,
              3,
              vecColorMode,
              vecPalette,
              explicitColorRange,
            );
            const animatedArrows = buildAnimatedArrowMeshesAndTracks({
              targetId: target.id,
              anchorsM: prep.arrowAnchorPositionsM,
              frameVectors: arrowFrameVectors,
              keyframeTimes,
              maxMagnitude: maxMag,
              baseArrowLengthM,
              anchorMode,
              vectorLengthMode: lengthMode,
              coordinateTransform,
              materialStyle,
              opacity: targetOpacity,
              colorMode: vecColorMode,
              colorPalette: vecPalette,
              colorRange: vecColorRange,
              monochromeColor,
              usedNodeNames,
            });
            if (animatedArrows) {
              disposables.add(animatedArrows.sharedGeometry);
              for (const mat of animatedArrows.materials) {
                disposables.add(mat);
                usedMaterialSet.add(mat);
              }
              const arrowGroup = new Group();
              arrowGroup.name = sanitizeGlTfNodeName(
                `${target.id}_vectors`,
                usedNodeNames,
                "vectors",
              );
              for (const arrowMesh of animatedArrows.meshes) {
                arrowGroup.add(arrowMesh);
              }
              targetGroup.add(arrowGroup);
              tracks.push(...animatedArrows.tracks);
              totalMeshCount += animatedArrows.meshes.length;
              totalArrowCount += animatedArrows.arrowCount;
            }
          }
        }
      }
    }

    if (totalMeshCount === 0) {
      throw new Error(
        "Cannot export glTF/GLB model: no exportable surface, wireframe, or vector meshes found.",
      );
    }

    throwIfExportAborted(options.signal);

    const animations: AnimationClip[] = [];
    if (tracks.length > 0) {
      const clipName = sanitizeGlTfNodeName(
        "fullmag_animation",
        usedNodeNames,
        "animation",
      );
      animations.push(new AnimationClip(clipName, -1, tracks));
    }

    const exporter = new GLTFExporter();
    const exported = await exporter.parseAsync(scene, {
      binary,
      onlyVisible: true,
      trs: tracks.length > 0,
      animations,
    });

    let bytes: Uint8Array;
    let text: string | undefined;
    if (binary) {
      if (!(exported instanceof ArrayBuffer)) {
        throw new Error("GLTFExporter did not return an ArrayBuffer for binary GLB export.");
      }
      bytes = new Uint8Array(exported);
    } else {
      text = JSON.stringify(exported, null, 2);
      bytes = new TextEncoder().encode(text);
    }

    return {
      bytes,
      text,
      coordinateTransform,
      stats: {
        targetCount: targets.length,
        meshCount: totalMeshCount,
        vertexCount: totalVertexCount,
        triangleCount: totalTriangleCount,
        cellCount: totalCellCount,
        arrowCount: totalArrowCount,
        frameCount: maxFrameCount,
        animationChannelCount: tracks.length,
        materialCount: usedMaterialSet.size,
        byteLength: bytes.byteLength,
      },
      warnings,
    };
  } finally {
    for (const resource of disposables) {
      resource.dispose();
    }
  }
}
