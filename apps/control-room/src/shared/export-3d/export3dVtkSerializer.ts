import {
  evaluateComplexFieldArray,
  evaluateFieldColorsSrgbUInt8,
  normalizeExport3DColorMode,
  normalizeExport3DScalarPalette,
  resolveFieldScalarRange,
} from "./export3dColorEvaluator";
import {
  defaultCoordinateScaleForFormat,
  resolveBoundsFromTargets,
  resolveCoordinateTransform,
  resolveEffectiveAnimationMode,
  throwIfExportAborted,
  transformPositionByCoordinateTransform,
  type Export3DColorMode,
  type Export3DCoordinateTransform,
  type Export3DFdmGridTargetInput,
  type Export3DFemMeshTargetInput,
  type Export3DFieldInput,
  type Export3DNumericArray,
  type Export3DRgbTuple,
  type Export3DScalarPalette,
  type Export3DScalarRange,
  type Export3DStats,
  type Export3DSurfaceGeometryTargetInput,
  type Export3DTargetInput,
  type Export3DVtkEncoding,
  type Export3DVtkFdmGeometryMode,
  type Export3DModelRequest,
} from "./export3dTypes";
import {
  computeFdmCellCentersM,
  extractVoxelExteriorShell,
  resolveFdmActiveCellMask,
  validateFdmGridInput,
} from "./export3dVoxelShell";
import { createStoreZipArchive } from "./export3dZipArchive";

const VTK_TRIANGLE = 5;
const VTK_QUAD = 9;
const VTK_TETRA = 10;
const VTK_HEXAHEDRON = 12;
const VTK_WEDGE = 13;
const VTK_PYRAMID = 14;
const TWO_PI = Math.PI * 2;
const DEFAULT_MONOCHROME_SRGB: Export3DRgbTuple = [0.75, 0.78, 0.85];

const FULLMAG_TO_VTK_CELL_TYPE: Readonly<Record<number, number>> = {
  1: VTK_TETRA,
  2: VTK_WEDGE,
  3: VTK_PYRAMID,
  4: VTK_HEXAHEDRON,
  5: VTK_TRIANGLE,
  9: VTK_QUAD,
  10: VTK_TETRA,
  12: VTK_HEXAHEDRON,
  13: VTK_WEDGE,
  14: VTK_PYRAMID,
};

export interface PvdDataSetEntry {
  timestep: number;
  file: string;
  group?: string;
  part?: number;
}

export interface SerializeVtkExportResult {
  bytes: Uint8Array;
  text?: string;
  coordinateTransform: Export3DCoordinateTransform;
  stats: Export3DStats;
  warnings: string[];
}

interface VtkArraySpec {
  name: string;
  dataType: "Float32" | "Float64" | "Int32" | "UInt8";
  components: number;
  data: Float32Array | Float64Array | Int32Array | Uint8Array;
}

interface ExtractedTargetVtkGeometry {
  pointsM: Float32Array;
  pointCount: number;
  connectivity: Int32Array;
  offsets: Int32Array;
  types: Uint8Array;
  cellCount: number;
  dataLocation: "cell" | "point";
  dataDomainEntryCount: number;
  dataTargetIndices: Uint32Array | null;
  compactActiveIndexMap: Map<number, number> | null;
  allEntryPositionsM: Float32Array | null;
}

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function encodeBase64(bytes: Uint8Array): string {
  const chunkSize = 0x2000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    parts.push(String.fromCharCode(...slice));
  }
  return btoa(parts.join(""));
}

function formatDataArrayXml(
  spec: VtkArraySpec,
  encoding: Export3DVtkEncoding,
): string {
  const nameAttr = spec.name ? ` Name="${escapeXmlAttr(spec.name)}"` : "";
  const compAttr =
    spec.components > 1 ? ` NumberOfComponents="${spec.components}"` : "";

  if (encoding === "binary") {
    const raw = new Uint8Array(
      spec.data.buffer,
      spec.data.byteOffset,
      spec.data.byteLength,
    );
    const framed = new Uint8Array(4 + raw.byteLength);
    new DataView(framed.buffer).setUint32(0, raw.byteLength, true);
    framed.set(raw, 4);
    return `<DataArray type="${spec.dataType}"${nameAttr}${compAttr} format="binary">${encodeBase64(framed)}</DataArray>`;
  }

  const values: string[] = new Array(spec.data.length);
  for (let i = 0; i < spec.data.length; i += 1) {
    const v = spec.data[i]!;
    values[i] = Number.isFinite(v) ? String(v) : "0";
  }
  return `<DataArray type="${spec.dataType}"${nameAttr}${compAttr} format="ascii">${values.join(" ")}</DataArray>`;
}

function buildFdmHexahedraVtkGeometry(
  target: Export3DFdmGridTargetInput,
): ExtractedTargetVtkGeometry {
  const originM = target.originM ?? [0, 0, 0];
  validateFdmGridInput(target.gridShape, target.cellSizeM, originM);
  const [nx, ny, nz] = target.gridShape;
  const [dx, dy, dz] = target.cellSizeM;
  const [ox, oy, oz] = originM;
  const mask = resolveFdmActiveCellMask(
    target.gridShape,
    target.activeMask,
    target.regionIds,
  );
  const planeStride = nx * ny;
  const cornerStrideY = nx + 1;
  const cornerStrideZ = (nx + 1) * (ny + 1);
  const totalCornerSlots = cornerStrideZ * (nz + 1);

  const cornerToPoint = new Int32Array(totalCornerSlots).fill(-1);
  const pointCoords: number[] = [];
  const connectivity = new Int32Array(mask.activeCellCount * 8);
  const offsets = new Int32Array(mask.activeCellCount);
  const types = new Uint8Array(mask.activeCellCount).fill(VTK_HEXAHEDRON);

  const internCorner = (ix: number, iy: number, iz: number): number => {
    const slot = ix + cornerStrideY * iy + cornerStrideZ * iz;
    const existing = cornerToPoint[slot]!;
    if (existing >= 0) return existing;
    const ptIdx = pointCoords.length / 3;
    cornerToPoint[slot] = ptIdx;
    pointCoords.push(ox + ix * dx, oy + iy * dy, oz + iz * dz);
    return ptIdx;
  };

  for (let cIdx = 0; cIdx < mask.activeCellCount; cIdx += 1) {
    const cell = mask.activeCellIndices[cIdx]!;
    const ix = cell % nx;
    const iy = Math.floor(cell / nx) % ny;
    const iz = Math.floor(cell / planeStride);
    const base = cIdx * 8;
    // Canonical VTK_HEXAHEDRON node order: bottom z0 CCW, then top z1 CCW.
    connectivity[base] = internCorner(ix, iy, iz);
    connectivity[base + 1] = internCorner(ix + 1, iy, iz);
    connectivity[base + 2] = internCorner(ix + 1, iy + 1, iz);
    connectivity[base + 3] = internCorner(ix, iy + 1, iz);
    connectivity[base + 4] = internCorner(ix, iy, iz + 1);
    connectivity[base + 5] = internCorner(ix + 1, iy, iz + 1);
    connectivity[base + 6] = internCorner(ix + 1, iy + 1, iz + 1);
    connectivity[base + 7] = internCorner(ix, iy + 1, iz + 1);
    offsets[cIdx] = base + 8;
  }

  let compactActiveIndexMap: Map<number, number> | null = null;
  if (
    target.field &&
    !target.field.nodeIndices &&
    mask.activeCellCount < mask.totalCells
  ) {
    const nComp = target.field.componentCount;
    const entryLen =
      target.field.kind === "real"
        ? Math.floor(target.field.values.length / nComp)
        : target.field.kind === "complex"
          ? Math.floor(
              Math.min(
                target.field.realValues.length,
                target.field.imagValues.length,
              ) / nComp,
            )
          : target.field.frames.length > 0
            ? Math.floor(target.field.frames[0]!.values.length / nComp)
            : 0;
    if (entryLen === mask.activeCellCount) {
      compactActiveIndexMap = new Map<number, number>();
      for (let i = 0; i < mask.activeCellIndices.length; i += 1) {
        compactActiveIndexMap.set(mask.activeCellIndices[i]!, i);
      }
    }
  }

  const allEntryPositionsM =
    target.field?.kind === "complex" && target.field.wavevectorKf
      ? computeFdmCellCentersM(target.gridShape, target.cellSizeM, originM)
      : null;

  return {
    pointsM: new Float32Array(pointCoords),
    pointCount: pointCoords.length / 3,
    connectivity,
    offsets,
    types,
    cellCount: mask.activeCellCount,
    dataLocation: "cell",
    dataDomainEntryCount: mask.totalCells,
    dataTargetIndices: mask.activeCellIndices,
    compactActiveIndexMap,
    allEntryPositionsM,
  };
}

function buildFdmSurfaceVtkGeometry(
  target: Export3DFdmGridTargetInput,
): ExtractedTargetVtkGeometry {
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
  const triCount = shell.triangleCount;
  const connectivity = new Int32Array(triCount * 3);
  const offsets = new Int32Array(triCount);
  const types = new Uint8Array(triCount).fill(VTK_TRIANGLE);
  const triCellIndices = new Uint32Array(triCount);

  for (let tri = 0; tri < triCount; tri += 1) {
    connectivity[tri * 3] = shell.indices[tri * 3]!;
    connectivity[tri * 3 + 1] = shell.indices[tri * 3 + 1]!;
    connectivity[tri * 3 + 2] = shell.indices[tri * 3 + 2]!;
    offsets[tri] = (tri + 1) * 3;
    triCellIndices[tri] = shell.faceCellIndices[Math.floor(tri / 2)]!;
  }

  let compactActiveIndexMap: Map<number, number> | null = null;
  if (
    target.field &&
    !target.field.nodeIndices &&
    shell.activeCellCount < totalCells
  ) {
    const nComp = target.field.componentCount;
    const entryLen =
      target.field.kind === "real"
        ? Math.floor(target.field.values.length / nComp)
        : target.field.kind === "complex"
          ? Math.floor(
              Math.min(
                target.field.realValues.length,
                target.field.imagValues.length,
              ) / nComp,
            )
          : target.field.frames.length > 0
            ? Math.floor(target.field.frames[0]!.values.length / nComp)
            : 0;
    if (entryLen === shell.activeCellCount) {
      compactActiveIndexMap = new Map<number, number>();
      for (let i = 0; i < shell.activeCellIndices.length; i += 1) {
        compactActiveIndexMap.set(shell.activeCellIndices[i]!, i);
      }
    }
  }

  const allEntryPositionsM =
    target.field?.kind === "complex" && target.field.wavevectorKf
      ? computeFdmCellCentersM(target.gridShape, target.cellSizeM, originM)
      : null;

  return {
    pointsM: shell.positionsM,
    pointCount: shell.vertexCount,
    connectivity,
    offsets,
    types,
    cellCount: triCount,
    dataLocation: "cell",
    dataDomainEntryCount: totalCells,
    dataTargetIndices: triCellIndices,
    compactActiveIndexMap,
    allEntryPositionsM,
  };
}

function buildMeshVtkGeometry(
  target: Export3DFemMeshTargetInput | Export3DSurfaceGeometryTargetInput,
): ExtractedTargetVtkGeometry {
  const pointsM =
    target.positionsM instanceof Float32Array
      ? target.positionsM
      : Float32Array.from(target.positionsM);
  const pointCount = Math.floor(pointsM.length / 3);

  if (target.kind === "fem_mesh" && target.volumeCells) {
    const vc = target.volumeCells;
    const hasCsr = Boolean(
      vc.cellOffsets && vc.cellTypes && vc.cellOffsets.length === vc.cellTypes.length + 1,
    );
    const cellCount = hasCsr
      ? vc.cellTypes!.length
      : (vc.cellCount ?? Math.floor(vc.cellNodes.length / 4));
    const connList: number[] = [];
    const offsets = new Int32Array(cellCount);
    const types = new Uint8Array(cellCount);

    for (let c = 0; c < cellCount; c += 1) {
      const start = hasCsr ? (vc.cellOffsets![c] ?? 0) : c * 4;
      const end = hasCsr ? (vc.cellOffsets![c + 1] ?? start) : start + 4;
      const rawType = hasCsr ? (vc.cellTypes![c] ?? 1) : 1;
      const vtkType = FULLMAG_TO_VTK_CELL_TYPE[rawType] ?? VTK_TETRA;
      for (let k = start; k < end; k += 1) {
        connList.push(Number(vc.cellNodes[k] ?? 0));
      }
      offsets[c] = connList.length;
      types[c] = vtkType;
    }

    const dataLocation = target.field?.location === "cell" ? "cell" : "point";
    return {
      pointsM,
      pointCount,
      connectivity: Int32Array.from(connList),
      offsets,
      types,
      cellCount,
      dataLocation,
      dataDomainEntryCount: dataLocation === "cell" ? cellCount : pointCount,
      dataTargetIndices: null,
      compactActiveIndexMap: null,
      allEntryPositionsM: dataLocation === "point" ? pointsM : null,
    };
  }

  const rawIndices =
    target.kind === "fem_mesh" ? target.surfaceIndices : target.indices;
  const triCount = rawIndices
    ? Math.floor(rawIndices.length / 3)
    : Math.floor(pointCount / 3);
  const connectivity = new Int32Array(triCount * 3);
  const offsets = new Int32Array(triCount);
  const types = new Uint8Array(triCount).fill(VTK_TRIANGLE);
  for (let tri = 0; tri < triCount; tri += 1) {
    connectivity[tri * 3] = rawIndices ? Number(rawIndices[tri * 3]!) : tri * 3;
    connectivity[tri * 3 + 1] = rawIndices
      ? Number(rawIndices[tri * 3 + 1]!)
      : tri * 3 + 1;
    connectivity[tri * 3 + 2] = rawIndices
      ? Number(rawIndices[tri * 3 + 2]!)
      : tri * 3 + 2;
    offsets[tri] = (tri + 1) * 3;
  }

  const dataLocation = target.field?.location === "cell" ? "cell" : "point";
  return {
    pointsM,
    pointCount,
    connectivity,
    offsets,
    types,
    cellCount: triCount,
    dataLocation,
    dataDomainEntryCount: dataLocation === "cell" ? triCount : pointCount,
    dataTargetIndices: null,
    compactActiveIndexMap: null,
    allEntryPositionsM: dataLocation === "point" ? pointsM : null,
  };
}

function extractTargetVtkGeometry(
  target: Export3DTargetInput,
  fdmMode: Export3DVtkFdmGeometryMode,
): ExtractedTargetVtkGeometry {
  if (target.kind === "fdm_grid") {
    return fdmMode === "surface_triangles"
      ? buildFdmSurfaceVtkGeometry(target)
      : buildFdmHexahedraVtkGeometry(target);
  }
  return buildMeshVtkGeometry(target);
}

function mapFieldValuesToOutput(params: {
  values: Export3DNumericArray;
  componentCount: 1 | 3;
  outputCount: number;
  targetIndices: Uint32Array | null;
  compactActiveIndexMap: Map<number, number> | null;
  fieldNodeIndices?: readonly number[] | Uint32Array | Uint16Array | null;
}): Float32Array {
  const nComp = params.componentCount;
  const fieldCount = Math.floor(params.values.length / nComp);
  const out = new Float32Array(params.outputCount * nComp);

  let map: Map<number, number> | null = params.compactActiveIndexMap;
  if (!map && params.fieldNodeIndices) {
    map = new Map<number, number>();
    const len = Math.min(fieldCount, params.fieldNodeIndices.length);
    for (let i = 0; i < len; i += 1) {
      map.set(Number(params.fieldNodeIndices[i]!), i);
    }
  }

  for (let outIdx = 0; outIdx < params.outputCount; outIdx += 1) {
    const targetIdx = params.targetIndices ? params.targetIndices[outIdx]! : outIdx;
    const fieldIdx = map ? (map.get(targetIdx) ?? -1) : targetIdx;
    if (fieldIdx < 0 || fieldIdx >= fieldCount) continue;
    const src = fieldIdx * nComp;
    const dst = outIdx * nComp;
    for (let c = 0; c < nComp; c += 1) {
      const v = params.values[src + c] ?? 0;
      out[dst + c] = Number.isFinite(v) ? v : 0;
    }
  }
  return out;
}

export function buildPvdCollectionXml(
  entries: readonly PvdDataSetEntry[],
): string {
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<VTKFile type="Collection" version="0.1" byte_order="LittleEndian">',
    "  <Collection>",
  ];
  for (const entry of entries) {
    const group = escapeXmlAttr(entry.group ?? "");
    const part = entry.part ?? 0;
    const timestep = Number.isFinite(entry.timestep) ? entry.timestep : 0;
    const file = escapeXmlAttr(entry.file);
    lines.push(
      `    <DataSet timestep="${timestep}" group="${group}" part="${part}" file="${file}"/>`,
    );
  }
  lines.push("  </Collection>", "</VTKFile>");
  return `${lines.join("\n")}\n`;
}

interface TargetPrecomputedRange {
  colorMode: Export3DColorMode;
  colorPalette: Export3DScalarPalette;
  colorRange: Export3DScalarRange;
  monochromeColor: Export3DRgbTuple;
}

function resolveSnapshotFieldValues(
  field: Export3DFieldInput,
  geom: ExtractedTargetVtkGeometry,
  frameIdx: number,
  frameCount: number,
  phaseRadOverride?: number,
): Export3DNumericArray {
  if (field.kind === "real") return field.values;
  if (field.kind === "complex") {
    const phaseRad =
      phaseRadOverride ??
      (frameCount > 1
        ? (frameIdx / frameCount) * TWO_PI
        : (field.complexPhaseRad ?? 0));
    return evaluateComplexFieldArray(field, phaseRad, geom.allEntryPositionsM);
  }
  if (field.frames.length === 0) return new Float32Array(0);
  const clampedIdx = Math.min(field.frames.length - 1, Math.max(0, frameIdx));
  return field.frames[clampedIdx]!.values;
}

function serializeSingleFrameVtuXml(params: {
  targets: readonly Export3DTargetInput[];
  geoms: readonly ExtractedTargetVtkGeometry[];
  ranges: readonly (TargetPrecomputedRange | null)[];
  coordinateTransform: Export3DCoordinateTransform;
  encoding: Export3DVtkEncoding;
  frameIdx: number;
  frameCount: number;
  timeS: number;
  includeVectorData: boolean;
  phaseRad?: number;
}): { xml: string; pointCount: number; cellCount: number } {
  const { targets, geoms, ranges, coordinateTransform, encoding } = params;

  let totalPoints = 0;
  let totalCells = 0;
  let totalConnectivity = 0;
  for (const g of geoms) {
    totalPoints += g.pointCount;
    totalCells += g.cellCount;
    totalConnectivity += g.connectivity.length;
  }

  const mergedPoints = new Float32Array(totalPoints * 3);
  const mergedConnectivity = new Int32Array(totalConnectivity);
  const mergedOffsets = new Int32Array(totalCells);
  const mergedTypes = new Uint8Array(totalCells);
  const targetIndexPerCell = new Int32Array(totalCells);

  let pointCursor = 0;
  let cellCursor = 0;
  let connCursor = 0;

  for (let tIdx = 0; tIdx < geoms.length; tIdx += 1) {
    const g = geoms[tIdx]!;
    for (let p = 0; p < g.pointCount; p += 1) {
      const [tx, ty, tz] = transformPositionByCoordinateTransform(
        g.pointsM[p * 3]!,
        g.pointsM[p * 3 + 1]!,
        g.pointsM[p * 3 + 2]!,
        coordinateTransform,
      );
      const dst = (pointCursor + p) * 3;
      mergedPoints[dst] = tx;
      mergedPoints[dst + 1] = ty;
      mergedPoints[dst + 2] = tz;
    }
    for (let k = 0; k < g.connectivity.length; k += 1) {
      mergedConnectivity[connCursor + k] = g.connectivity[k]! + pointCursor;
    }
    for (let c = 0; c < g.cellCount; c += 1) {
      mergedOffsets[cellCursor + c] = g.offsets[c]! + connCursor;
      mergedTypes[cellCursor + c] = g.types[c]!;
      targetIndexPerCell[cellCursor + c] = tIdx;
    }
    pointCursor += g.pointCount;
    cellCursor += g.cellCount;
    connCursor += g.connectivity.length;
  }

  // Group field arrays by (location, quantityId) across targets.
  const pointArrayBuckets = new Map<
    string,
    { componentCount: 1 | 3; data: Float32Array }
  >();
  const cellArrayBuckets = new Map<
    string,
    { componentCount: 1 | 3; data: Float32Array }
  >();

  let hasPointTextureRgb = false;
  let hasCellTextureRgb = false;
  const pointTextureRgb = new Uint8Array(totalPoints * 3).fill(128);
  const cellTextureRgb = new Uint8Array(totalCells * 3).fill(128);

  let pOffset = 0;
  let cOffset = 0;
  for (let tIdx = 0; tIdx < targets.length; tIdx += 1) {
    const target = targets[tIdx]!;
    const g = geoms[tIdx]!;
    const field = target.field ?? null;
    const rangeSpec = ranges[tIdx];

    if (field && rangeSpec) {
      const snapshotValues = resolveSnapshotFieldValues(
        field,
        g,
        params.frameIdx,
        params.frameCount,
        params.phaseRad,
      );
      const outCount = g.dataLocation === "cell" ? g.cellCount : g.pointCount;
      if (params.includeVectorData || field.componentCount !== 3) {
        const mappedValues = mapFieldValuesToOutput({
          values: snapshotValues,
          componentCount: field.componentCount,
          outputCount: outCount,
          targetIndices: g.dataTargetIndices,
          compactActiveIndexMap: g.compactActiveIndexMap,
          fieldNodeIndices: field.nodeIndices,
        });

        const buckets =
          g.dataLocation === "cell" ? cellArrayBuckets : pointArrayBuckets;
        const totalOut = g.dataLocation === "cell" ? totalCells : totalPoints;
        const baseOut = g.dataLocation === "cell" ? cOffset : pOffset;

        let bucket = buckets.get(field.quantityId);
        if (!bucket) {
          bucket = {
            componentCount: field.componentCount,
            data: new Float32Array(totalOut * field.componentCount),
          };
          buckets.set(field.quantityId, bucket);
        }
        if (bucket.componentCount === field.componentCount) {
          bucket.data.set(mappedValues, baseOut * field.componentCount);
        }
      }

      const srgbUInt8 = evaluateFieldColorsSrgbUInt8({
        values: snapshotValues,
        componentCount: field.componentCount,
        colorMode: rangeSpec.colorMode,
        colorPalette: rangeSpec.colorPalette,
        range: rangeSpec.colorRange,
        outputTargetIndices: g.dataTargetIndices,
        outputCount: outCount,
        domainEntryCount: g.dataDomainEntryCount,
        fieldNodeIndices: field.nodeIndices,
        compactActiveIndexMap: g.compactActiveIndexMap,
        monochromeColor: rangeSpec.monochromeColor,
      });

      if (g.dataLocation === "cell") {
        hasCellTextureRgb = true;
        cellTextureRgb.set(srgbUInt8, cOffset * 3);
      } else {
        hasPointTextureRgb = true;
        pointTextureRgb.set(srgbUInt8, pOffset * 3);
      }
    }

    pOffset += g.pointCount;
    cOffset += g.cellCount;
  }

  const pointArrays: VtkArraySpec[] = [];
  for (const [name, bucket] of pointArrayBuckets.entries()) {
    pointArrays.push({
      name,
      dataType: "Float32",
      components: bucket.componentCount,
      data: bucket.data,
    });
  }
  if (hasPointTextureRgb) {
    pointArrays.push({
      name: "magnetic_texture_rgb",
      dataType: "UInt8",
      components: 3,
      data: pointTextureRgb,
    });
  }

  const cellArrays: VtkArraySpec[] = [];
  for (const [name, bucket] of cellArrayBuckets.entries()) {
    cellArrays.push({
      name,
      dataType: "Float32",
      components: bucket.componentCount,
      data: bucket.data,
    });
  }
  if (hasCellTextureRgb) {
    cellArrays.push({
      name: "magnetic_texture_rgb",
      dataType: "UInt8",
      components: 3,
      data: cellTextureRgb,
    });
  }
  if (targets.length > 1) {
    cellArrays.push({
      name: "target_id",
      dataType: "Int32",
      components: 1,
      data: targetIndexPerCell,
    });
  }

  const fieldDataArrays: VtkArraySpec[] = [
    {
      name: "si_meters_per_unit",
      dataType: "Float64",
      components: 1,
      data: Float64Array.from([coordinateTransform.siMetersPerUnit]),
    },
    {
      name: "origin_offset_m",
      dataType: "Float64",
      components: 3,
      data: Float64Array.from(coordinateTransform.originOffsetM),
    },
    {
      name: "time_s",
      dataType: "Float64",
      components: 1,
      data: Float64Array.from([params.timeS]),
    },
  ];

  const lines: string[] = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<VTKFile type="UnstructuredGrid" version="0.1" byte_order="LittleEndian" header_type="UInt32">',
    "  <UnstructuredGrid>",
    "    <FieldData>",
    ...fieldDataArrays.map((arr) => `      ${formatDataArrayXml(arr, "ascii")}`),
    "    </FieldData>",
    `    <Piece NumberOfPoints="${totalPoints}" NumberOfCells="${totalCells}">`,
  ];

  if (pointArrays.length > 0) {
    lines.push("      <PointData>");
    for (const arr of pointArrays) {
      lines.push(`        ${formatDataArrayXml(arr, encoding)}`);
    }
    lines.push("      </PointData>");
  } else {
    lines.push("      <PointData/>");
  }

  if (cellArrays.length > 0) {
    lines.push("      <CellData>");
    for (const arr of cellArrays) {
      lines.push(`        ${formatDataArrayXml(arr, encoding)}`);
    }
    lines.push("      </CellData>");
  } else {
    lines.push("      <CellData/>");
  }

  lines.push(
    "      <Points>",
    `        ${formatDataArrayXml(
      {
        name: "Points",
        dataType: "Float32",
        components: 3,
        data: mergedPoints,
      },
      encoding,
    )}`,
    "      </Points>",
    "      <Cells>",
    `        ${formatDataArrayXml(
      {
        name: "connectivity",
        dataType: "Int32",
        components: 1,
        data: mergedConnectivity,
      },
      encoding,
    )}`,
    `        ${formatDataArrayXml(
      {
        name: "offsets",
        dataType: "Int32",
        components: 1,
        data: mergedOffsets,
      },
      encoding,
    )}`,
    `        ${formatDataArrayXml(
      {
        name: "types",
        dataType: "UInt8",
        components: 1,
        data: mergedTypes,
      },
      encoding,
    )}`,
    "      </Cells>",
    "    </Piece>",
    "  </UnstructuredGrid>",
    "</VTKFile>",
  );

  return {
    xml: `${lines.join("\n")}\n`,
    pointCount: totalPoints,
    cellCount: totalCells,
  };
}

/**
 * Serializes Fullmag FDM/FEM targets into a VTK XML `.vtu` file or a
 * self-contained `.vtu.zip` bundle (`series.pvd` + `frames/frame_*.vtu`).
 */
export function serializeVtkExport(
  request: Export3DModelRequest,
): SerializeVtkExportResult {
  const { targets, options } = request;
  throwIfExportAborted(options.signal);

  const coordinateScale =
    options.coordinateScale ?? defaultCoordinateScaleForFormat(options.format);
  const encoding: Export3DVtkEncoding = options.vtkEncoding ?? "ascii";
  const fdmMode: Export3DVtkFdmGeometryMode =
    options.vtkFdmGeometryMode ?? "volume_hexahedra";
  const boundsM = resolveBoundsFromTargets(targets);
  const coordinateTransform = resolveCoordinateTransform(boundsM, coordinateScale);
  const animationMode = resolveEffectiveAnimationMode(targets, options);
  const cycleDurationSeconds = Math.max(0.1, options.cycleDurationSeconds ?? 2.0);
  const phaseFrameCount = Math.max(
    4,
    Math.min(120, Math.floor(options.phaseFrameCount ?? 24)),
  );
  const warnings: string[] = [];

  const activeTargets: Export3DTargetInput[] = [];
  const geoms: ExtractedTargetVtkGeometry[] = [];

  for (const target of targets) {
    throwIfExportAborted(options.signal);
    const geom = extractTargetVtkGeometry(target, fdmMode);
    if (geom.pointCount === 0 || geom.cellCount === 0) {
      warnings.push(`Target "${target.id}" produced no exportable VTK cells.`);
      continue;
    }
    activeTargets.push(target);
    geoms.push(geom);
  }

  if (geoms.length === 0) {
    throw new Error(
      "Cannot export VTK model: no exportable points or cells found in targets.",
    );
  }

  // Determine frame count & global scalar color ranges.
  let frameCount = 1;
  if (options.format === "vtu_zip") {
    if (
      animationMode === "phase_cycle" &&
      activeTargets.some(
        (t) =>
          t.field?.kind === "complex" &&
          (t.field.complexRepresentation ?? "phase_rotated_real") ===
            "phase_rotated_real",
      )
    ) {
      frameCount = phaseFrameCount;
    } else if (animationMode === "playback_frames") {
      for (const t of activeTargets) {
        if (t.field?.kind === "frames" && t.field.frames.length > frameCount) {
          frameCount = t.field.frames.length;
        }
      }
    }
  } else {
    const hasMulti =
      (animationMode === "phase_cycle" &&
        activeTargets.some((t) => t.field?.kind === "complex")) ||
      (animationMode === "playback_frames" &&
        activeTargets.some(
          (t) => t.field?.kind === "frames" && t.field.frames.length > 1,
        ));
    if (hasMulti) {
      warnings.push(
        "Single .vtu file exported one snapshot frame; select .vtu_zip for full animated PVD time series.",
      );
    }
  }

  const ranges: (TargetPrecomputedRange | null)[] = activeTargets.map(
    (target, idx) => {
      const field = target.field;
      if (!field) return null;
      const g = geoms[idx]!;
      const defaultColorMode: Export3DColorMode =
        field.componentCount === 3 ? "orientation" : "magnitude";
      const colorMode = normalizeExport3DColorMode(
        target.appearance?.colorMode ?? options.colorMode,
        defaultColorMode,
      );
      const colorPalette = normalizeExport3DScalarPalette(
        target.appearance?.colorPalette ?? options.colorPalette,
        "viridis",
      );
      const monochromeColor =
        target.appearance?.monochromeColor ??
        options.monochromeColor ??
        DEFAULT_MONOCHROME_SRGB;
      const explicitRange =
        target.appearance?.colorRange !== undefined
          ? target.appearance.colorRange
          : options.colorRange;

      const allFramesValues: Export3DNumericArray[] = [];
      for (let f = 0; f < frameCount; f += 1) {
        const snapshotIdx =
          options.format === "vtu" ? Math.max(0, Math.floor(options.frameIndex ?? 0)) : f;
        allFramesValues.push(
          resolveSnapshotFieldValues(field, g, snapshotIdx, frameCount),
        );
      }
      const colorRange = resolveFieldScalarRange(
        allFramesValues,
        field.componentCount,
        colorMode,
        colorPalette,
        explicitRange,
      );
      return { colorMode, colorPalette, colorRange, monochromeColor };
    },
  );

  const encoder = new TextEncoder();

  if (options.format === "vtu") {
    const snapIdx = Math.max(0, Math.floor(options.frameIndex ?? 0));
    const single = serializeSingleFrameVtuXml({
      targets: activeTargets,
      geoms,
      ranges,
      coordinateTransform,
      encoding,
      frameIdx: snapIdx,
      frameCount: 1,
      timeS: 0,
      includeVectorData: options.vtkIncludeVectorData !== false,
    });
    const bytes = encoder.encode(single.xml);
    return {
      bytes,
      text: single.xml,
      coordinateTransform,
      stats: {
        targetCount: activeTargets.length,
        meshCount: activeTargets.length,
        vertexCount: single.pointCount,
        triangleCount: 0,
        cellCount: single.cellCount,
        arrowCount: 0,
        frameCount: 1,
        animationChannelCount: 0,
        materialCount: 0,
        byteLength: bytes.byteLength,
      },
      warnings,
    };
  }

  // .vtu.zip: series.pvd + frames/frame_0000.vtu ...
  const zipEntries: Array<{ path: string; data: Uint8Array | string }> = [];
  const pvdEntries: PvdDataSetEntry[] = [];
  let pointCount = 0;
  let cellCount = 0;

  for (let f = 0; f < frameCount; f += 1) {
    throwIfExportAborted(options.signal);
    const frameTimeS = resolveFrameTimestamp(
      activeTargets,
      f,
      frameCount,
      cycleDurationSeconds,
    );
    const framePath = `frames/frame_${String(f).padStart(4, "0")}.vtu`;
    const serialized = serializeSingleFrameVtuXml({
      targets: activeTargets,
      geoms,
      ranges,
      coordinateTransform,
      encoding,
      frameIdx: f,
      frameCount,
      timeS: frameTimeS,
      includeVectorData: options.vtkIncludeVectorData !== false,
    });
    pointCount = serialized.pointCount;
    cellCount = serialized.cellCount;
    zipEntries.push({ path: framePath, data: serialized.xml });
    pvdEntries.push({
      timestep: frameTimeS,
      file: framePath,
      group: "",
      part: 0,
    });
  }

  const pvdXml = buildPvdCollectionXml(pvdEntries);
  zipEntries.unshift({ path: "series.pvd", data: pvdXml });
  const zipBytes = createStoreZipArchive(zipEntries);

  return {
    bytes: zipBytes,
    coordinateTransform,
    stats: {
      targetCount: activeTargets.length,
      meshCount: activeTargets.length,
      vertexCount: pointCount,
      triangleCount: 0,
      cellCount,
      arrowCount: 0,
      frameCount,
      animationChannelCount: 0,
      materialCount: 0,
      byteLength: zipBytes.byteLength,
    },
    warnings,
  };
}

function resolveFrameTimestamp(
  targets: readonly Export3DTargetInput[],
  frameIdx: number,
  frameCount: number,
  cycleDurationSeconds: number,
): number {
  for (const target of targets) {
    if (target.field?.kind === "frames") {
      const f = target.field.frames[frameIdx];
      if (f?.timeS !== undefined && Number.isFinite(f.timeS)) {
        return f.timeS;
      }
    }
  }
  return frameCount > 1 ? (frameIdx / frameCount) * cycleDurationSeconds : 0;
}
