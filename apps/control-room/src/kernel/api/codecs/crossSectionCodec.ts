import type { DecodedCrossSection } from "./types";

export const FMCS_HEADER_LEN = 64;
export const FMCS_V3_HEADER_LEN = 160;

const MAGIC = "FMCS";
const SUPPORTED_VERSION = 2;
const FMCS_FLAG_INTERSECTION_METADATA = 1;

function readMagic(view: DataView): string {
  return String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
}

export function decodeCrossSection(buffer: ArrayBuffer): DecodedCrossSection {
  if (buffer.byteLength < FMCS_HEADER_LEN) {
    throw new Error(
      `FMCS buffer too short: ${buffer.byteLength} bytes, need at least ${FMCS_HEADER_LEN}`,
    );
  }

  const view = new DataView(buffer);
  const magic = readMagic(view);
  if (magic !== MAGIC) {
    throw new Error(`Invalid FMCS magic: expected "${MAGIC}", got "${magic}"`);
  }

  const version = view.getUint32(4, true);
  if (version !== SUPPORTED_VERSION) {
    throw new Error(
      `Unsupported FMCS version: expected ${SUPPORTED_VERSION}, got ${version}`,
    );
  }

  const polygonCount = view.getUint32(8, true);
  const vertexCount = view.getUint32(12, true);
  const segmentCount = view.getUint32(16, true);
  const parentElementCount = view.getUint32(20, true);
  const metadataVertexCount = view.getUint32(24, true);
  const flags = view.getUint32(28, true);
  if (parentElementCount !== polygonCount) {
    throw new Error(
      `FMCS parent element count mismatch: expected ${polygonCount}, got ${parentElementCount}`,
    );
  }
  if (metadataVertexCount !== vertexCount) {
    throw new Error(
      `FMCS metadata vertex count mismatch: expected ${vertexCount}, got ${metadataVertexCount}`,
    );
  }
  if ((flags & FMCS_FLAG_INTERSECTION_METADATA) === 0) {
    throw new Error("FMCS v2 payload is missing intersection metadata");
  }

  const bounds = {
    uMin: view.getFloat64(32, true),
    uMax: view.getFloat64(40, true),
    vMin: view.getFloat64(48, true),
    vMax: view.getFloat64(56, true),
  };
  for (const [key, value] of Object.entries(bounds)) {
    if (!Number.isFinite(value)) {
      throw new Error(`FMCS: non-finite bound ${key}`);
    }
  }

  const verticesByteLength = vertexCount * 2 * Float32Array.BYTES_PER_ELEMENT;
  const offsetsByteLength = (polygonCount + 1) * Uint32Array.BYTES_PER_ELEMENT;
  const parentIdsByteLength = parentElementCount * Uint32Array.BYTES_PER_ELEMENT;
  const segmentsByteLength = segmentCount * 4 * Float32Array.BYTES_PER_ELEMENT;
  const intersectionWorldByteLength =
    metadataVertexCount * 3 * Float32Array.BYTES_PER_ELEMENT;
  const intersectionEdgeNodeIdsByteLength =
    metadataVertexCount * 2 * Uint32Array.BYTES_PER_ELEMENT;
  const intersectionEdgeTByteLength =
    metadataVertexCount * Float32Array.BYTES_PER_ELEMENT;
  const intersectionKindsByteLength =
    metadataVertexCount * Uint32Array.BYTES_PER_ELEMENT;
  const expectedByteLength =
    FMCS_HEADER_LEN +
    verticesByteLength +
    offsetsByteLength +
    parentIdsByteLength +
    segmentsByteLength +
    intersectionWorldByteLength +
    intersectionEdgeNodeIdsByteLength +
    intersectionEdgeTByteLength +
    intersectionKindsByteLength;
  if (buffer.byteLength !== expectedByteLength) {
    throw new Error(
      `FMCS buffer size mismatch: expected ${expectedByteLength}, got ${buffer.byteLength}`,
    );
  }

  let offset = FMCS_HEADER_LEN;
  const vertices = new Float32Array(buffer, offset, vertexCount * 2);
  offset += verticesByteLength;
  const polygonOffsets = new Uint32Array(buffer, offset, polygonCount + 1);
  offset += offsetsByteLength;
  const parentElementIds = new Uint32Array(buffer, offset, parentElementCount);
  offset += parentIdsByteLength;
  const segments = new Float32Array(buffer, offset, segmentCount * 4);
  offset += segmentsByteLength;
  const intersectionWorld = new Float32Array(
    buffer,
    offset,
    metadataVertexCount * 3,
  );
  offset += intersectionWorldByteLength;
  const intersectionEdgeNodeIds = new Uint32Array(
    buffer,
    offset,
    metadataVertexCount * 2,
  );
  offset += intersectionEdgeNodeIdsByteLength;
  const intersectionEdgeT = new Float32Array(buffer, offset, metadataVertexCount);
  offset += intersectionEdgeTByteLength;
  const intersectionKinds = new Uint32Array(buffer, offset, metadataVertexCount);

  if (polygonOffsets[0] !== 0 || polygonOffsets[polygonCount] !== vertexCount) {
    throw new Error("FMCS polygon offsets do not match vertex count");
  }
  for (let index = 1; index < polygonOffsets.length; index++) {
    if (polygonOffsets[index] < polygonOffsets[index - 1]) {
      throw new Error(`FMCS polygon offsets are not monotonic at ${index}`);
    }
  }

  return {
    bounds,
    intersectionEdgeNodeIds,
    intersectionEdgeT,
    intersectionKinds,
    intersectionWorld,
    parentElementIds,
    polygonCount,
    polygonOffsets,
    segmentCount,
    segments,
    vertexCount,
    vertices,
  };
}

export interface PlanarMeshOverlay {
  boundaryClassification: "degraded" | "exact";
  bounds: readonly number[];
  codec: "fmcs.v3" | "fmcs.v4";
  frame: {
    normal: readonly number[];
    origin: readonly number[];
    uAxis: readonly number[];
    vAxis: readonly number[];
  };
  segmentCount: number;
  segmentKinds: Uint8Array;
  segments: Float32Array;
  truncated: boolean;
}

export function decodePlanarMeshOverlay(
  buffer: ArrayBuffer,
  segmentCap = 200_000,
): PlanarMeshOverlay {
  if (buffer.byteLength < FMCS_V3_HEADER_LEN) {
    throw new Error("FMCS planar overlay header is truncated");
  }
  const view = new DataView(buffer);
  const magic = readMagic(view);
  const version = view.getUint32(4, true);
  if (magic !== MAGIC || (version !== 3 && version !== 4)) {
    throw new Error("Expected FMCS v3 or v4 planar overlay");
  }
  const polygonCount = view.getUint32(8, true);
  const vertexCount = view.getUint32(12, true);
  const segmentCount = view.getUint32(16, true);
  const segmentsOffset =
    FMCS_V3_HEADER_LEN +
    vertexCount * 2 * Float32Array.BYTES_PER_ELEMENT +
    (polygonCount + 1) * Uint32Array.BYTES_PER_ELEMENT +
    polygonCount * Uint32Array.BYTES_PER_ELEMENT;
  const kindsOffset =
    segmentsOffset + segmentCount * 4 * Float32Array.BYTES_PER_ELEMENT;
  const expectedByteLength = kindsOffset + (version === 4 ? segmentCount : 0);
  if (buffer.byteLength !== expectedByteLength) {
    throw new Error(
      `FMCS v3 planar overlay size mismatch: expected ${expectedByteLength}, got ${buffer.byteLength}`,
    );
  }
  const retained = Math.min(segmentCount, Math.max(0, segmentCap));
  const segmentKinds =
    version === 4
      ? new Uint8Array(buffer, kindsOffset, segmentCount)
      : new Uint8Array(segmentCount).fill(2);
  if ([...segmentKinds].some((kind) => kind > 2)) {
    throw new Error("FMCS v4 planar overlay has an invalid segment kind");
  }
  return {
    boundaryClassification: version === 4 ? "exact" : "degraded",
    bounds: readFloat64Vector(view, 32, 4),
    codec: version === 4 ? "fmcs.v4" : "fmcs.v3",
    frame: {
      normal: readFloat64Vector(view, 136, 3),
      origin: readFloat64Vector(view, 64, 3),
      uAxis: readFloat64Vector(view, 88, 3),
      vAxis: readFloat64Vector(view, 112, 3),
    },
    segmentCount,
    segmentKinds: segmentKinds.slice(0, retained),
    segments: new Float32Array(buffer, segmentsOffset, retained * 4),
    truncated: retained < segmentCount,
  };
}

function readFloat64Vector(
  view: DataView,
  offset: number,
  count: number,
): number[] {
  return Array.from({ length: count }, (_, index) =>
    view.getFloat64(offset + index * Float64Array.BYTES_PER_ELEMENT, true),
  );
}
